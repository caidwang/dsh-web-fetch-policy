/** Address-pinned, configurable HTTP(S) fetch provider for ctx.web. */

import { WebError } from '@deepseek-ai/dsh-web'
import type { WebFetchBody, WebFetchProvider, WebFetchRequest, WebFetchResult } from '@deepseek-ai/dsh-web'
import { deadline, timeoutOf } from '@deepseek-ai/dsh-timeout'
import { proxyRouteFor } from '@deepseek-ai/dsh-http-proxy'
import type { Response } from 'undici'
import { isNonPublicIpLiteral, policyHttpNetwork } from './network.js'
import type { AddressAccessPolicy, ResolvedAddress } from './network.js'
import { classifyContentType, decoderForCharset, isSameOrigin, parseCharset, validateFetchUrl } from './policy.js'

/** Resolved size, timeout, redirect, and header limits. */
export interface HttpFetchLimits {
  readonly maxResponseBytes: number
  readonly maxBodyChars: number
  readonly timeoutMs: number
  readonly maxRedirects: number
  readonly userAgent: string
}

/** Injectable resolver signature used by focused tests. */
export type HttpFetchResolver = (hostname: string, signal: AbortSignal) => Promise<ResolvedAddress[]>

/** Stable id selected by the package's bundle patch. */
export const POLICY_FETCH_PROVIDER_ID = 'policy-http'

/**
 * Anonymous HTTP(S) backend. It enforces public-only transport by default and
 * applies explicit private-host exceptions before pinning direct connections.
 */
export class PolicyHttpFetchProvider implements WebFetchProvider {
  readonly id = POLICY_FETCH_PROVIDER_ID

  /** @param limits - load-time validated request limits.
   * @param addressPolicy - load-time validated private-address exception policy.
   * @param resolveAddresses - retains and pins one policy-checked DNS answer set.
   */
  constructor(
    private readonly limits: HttpFetchLimits,
    addressPolicy: AddressAccessPolicy,
    private readonly resolveAddresses: HttpFetchResolver = (hostname, signal) => policyHttpNetwork.resolve(
      hostname,
      signal,
      addressPolicy,
    ),
  ) {}

  /** The provider needs no credentials. */
  available(): boolean {
    return true
  }

  /** Fetch one resource under the provider's resource deadline. */
  async fetch(request: WebFetchRequest, signal?: AbortSignal): Promise<WebFetchResult> {
    if (signal?.aborted) throw new WebError('web fetch aborted', 'WEB_ABORTED')
    using requestDeadline = deadline(signal, this.limits.timeoutMs, 'WEB_FETCH_TIMEOUT')
    return await this.followAndRead(request.url, requestDeadline.signal)
  }

  /** Follow same-origin redirects; every hop calls requestOnce and is rechecked. */
  private async followAndRead(initialUrl: string, signal: AbortSignal): Promise<WebFetchResult> {
    let currentUrl = validateFetchUrl(initialUrl)
    let redirectsFollowed = 0
    for (;;) {
      const request = await this.requestOnce(currentUrl, signal)
      try {
        const { response } = request
        if (isRedirectStatus(response.status)) {
          if (redirectsFollowed >= this.limits.maxRedirects) {
            await response.body?.cancel()
            throw new WebError(`exceeded the maximum of ${this.limits.maxRedirects} redirects`, 'WEB_REDIRECT_BLOCKED')
          }
          const location = response.headers.get('location')
          if (location === null) {
            await response.body?.cancel()
            throw new WebError(`redirect response (HTTP ${response.status}) without a Location header`, 'WEB_PROVIDER_ERROR')
          }
          let target: URL
          try {
            target = validateFetchUrl(new URL(location, currentUrl).toString())
          } catch (error: unknown) {
            await response.body?.cancel()
            if (error instanceof WebError) throw error
            throw new WebError(`invalid redirect Location "${location}"`, 'WEB_PROVIDER_ERROR', { cause: error })
          }
          if (!isSameOrigin(target, currentUrl)) {
            await response.body?.cancel()
            throw new WebError(`cross-origin redirect to ${target.origin} is not followed automatically`, 'WEB_REDIRECT_BLOCKED')
          }
          await response.body?.cancel()
          currentUrl = target
          redirectsFollowed++
          continue
        }
        return await this.readBody(response, currentUrl, signal)
      } finally {
        await request.close()
      }
    }
  }

  /** Choose proxy or local pinned transport for one already validated URL. */
  private async requestOnce(url: URL, signal: AbortSignal) {
    const headers = {
      'user-agent': this.limits.userAgent,
      accept: 'text/html,application/xhtml+xml,text/*;q=0.9,application/json;q=0.8',
    }
    try {
      const route = proxyRouteFor(url)
      // A proxy resolves a hostname remotely, so this preserves dsh's existing
      // proxy behavior. Non-public literals stay local: handing one to a local
      // proxy would bypass exactly the literal policy this provider owns.
      if (route.proxied && !isNonPublicIpLiteral(url.hostname)) {
        return await policyHttpNetwork.requestVia(route.dispatcher, url, headers, signal)
      }
      const addresses = await this.resolveAddresses(url.hostname, signal)
      return await policyHttpNetwork.request(url, addresses, headers, signal)
    } catch (error: unknown) {
      if (error instanceof WebError) throw error
      throw translateAbortOrNetwork(error, signal)
    }
  }

  /** Classify, cap, decode, and return one final non-redirect response. */
  private async readBody(response: Response, finalUrl: URL, signal: AbortSignal): Promise<WebFetchResult> {
    const contentType = response.headers.get('content-type')
    const kind = classifyContentType(contentType)
    if (kind === undefined) {
      await response.body?.cancel()
      throw new WebError(`unsupported content type "${contentType ?? 'unknown'}"`, 'WEB_UNSUPPORTED_CONTENT_TYPE')
    }
    let decoder: TextDecoder
    try {
      decoder = decoderForCharset(parseCharset(contentType))
    } catch (error: unknown) {
      await response.body?.cancel()
      throw error
    }
    const { bytes, truncatedByBytes } = await this.readCapped(response, signal)
    const decoded = decoder.decode(bytes)
    const truncatedByChars = decoded.length > this.limits.maxBodyChars
    const content = truncatedByChars ? decoded.slice(0, this.limits.maxBodyChars) : decoded
    const body: WebFetchBody = kind === 'html' ? { kind: 'html', content } : { kind: 'text', content }
    return { url: finalUrl.toString(), statusCode: response.status, body, truncated: truncatedByBytes || truncatedByChars }
  }

  /** Read a bounded response stream and always cancel it after the useful bytes. */
  private async readCapped(response: Response, signal: AbortSignal): Promise<{ bytes: Uint8Array; truncatedByBytes: boolean }> {
    const declared = response.headers.get('content-length')
    if (declared !== null && Number.isFinite(Number(declared)) && Number(declared) > this.limits.maxResponseBytes) {
      await response.body?.cancel()
      throw new WebError(`response exceeds the maximum of ${this.limits.maxResponseBytes} bytes`, 'WEB_FETCH_TOO_LARGE')
    }
    if (response.body === null) return { bytes: new Uint8Array(0), truncatedByBytes: false }
    const reader = response.body.getReader() as ReadableStreamDefaultReader<Uint8Array>
    const chunks: Uint8Array[] = []
    let total = 0
    let truncatedByBytes = false
    try {
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        const remaining = this.limits.maxResponseBytes - total
        if (value.byteLength > remaining) {
          chunks.push(value.subarray(0, remaining))
          total += remaining
          truncatedByBytes = true
          break
        }
        chunks.push(value)
        total += value.byteLength
      }
    } catch (error: unknown) {
      throw translateAbortOrNetwork(error, signal)
    } finally {
      await reader.cancel().catch(() => undefined)
    }
    const bytes = new Uint8Array(total)
    let offset = 0
    for (const chunk of chunks) {
      bytes.set(chunk, offset)
      offset += chunk.byteLength
    }
    return { bytes, truncatedByBytes }
  }
}

/** Recognize redirect statuses whose Location is meaningful. */
function isRedirectStatus(status: number): boolean {
  return status === 301 || status === 302 || status === 303 || status === 307 || status === 308
}

/** Translate an abort or network failure to the dsh web error vocabulary. */
function translateAbortOrNetwork(error: unknown, signal: AbortSignal): WebError {
  const timeout = timeoutOf(signal, 'WEB_FETCH_TIMEOUT')
  if (timeout !== undefined) return new WebError('web fetch timed out', 'WEB_FETCH_TIMEOUT', { cause: timeout })
  if (signal.aborted) return new WebError('web fetch aborted', 'WEB_ABORTED', { cause: error })
  return new WebError(`web fetch failed: ${String(error)}`, 'WEB_PROVIDER_ERROR', { cause: error })
}
