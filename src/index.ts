/**
 * Configurable, address-pinned HTTP(S) fetch provider for the DeepSeek Harness
 * web service. Derived from @deepseek-ai/dsh-web-fetch-http (MIT).
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-web'
import { createAddressAccessPolicy } from './network.js'
import { PolicyHttpFetchProvider } from './provider.js'
import type { HttpFetchLimits } from './provider.js'

const MAX_NODE_TIMER_DELAY_MS = 2_147_483_647

export { POLICY_FETCH_PROVIDER_ID, PolicyHttpFetchProvider } from './provider.js'
export type { HttpFetchLimits, HttpFetchResolver } from './provider.js'
export {
  createAddressAccessPolicy,
  isNonPublicIpLiteral,
  isPublicIpAddress,
  normalizeAllowedPrivateHost,
  resolvePolicyAddresses,
} from './network.js'
export type { AddressAccessPolicy, AddressResolver, ResolvedAddress } from './network.js'

/** An explicit non-browser identifier sent on every request. */
export const DEFAULT_USER_AGENT = 'dsh-web-fetch-policy/0.1 (+https://github.com/caidwang/dsh-web-fetch-policy)'

/** Loader-visible plugin name. */
export const name = 'web-fetch-policy'

/** This provider contributes only to an existing dsh web service. */
export const inject = ['web']

/** Load-time provider configuration. */
export interface Config {
  /** Maximum response body size in bytes. */
  maxResponseBytes?: number
  /** Maximum decoded response length in JavaScript characters. */
  maxBodyChars?: number
  /** Per-fetch resource deadline, in milliseconds. */
  timeoutMs?: number
  /** Maximum same-origin redirects to follow. */
  maxRedirects?: number
  /** HTTP User-Agent header. */
  userAgent?: string
  /** Exact private IP literals, localhost, or DNS names eligible for the narrow exception policy. */
  allowedPrivateHosts?: string[]
  /** Allow an exact allowlisted DNS name to resolve entirely to private addresses. */
  allowPrivateDns?: boolean
}

/** Schemastery config schema; semantic host validation happens during apply. */
export const Config: z<Config> = z.object({
  maxResponseBytes: z.number().default(5_000_000),
  maxBodyChars: z.number().default(100_000),
  timeoutMs: z.number().default(30_000),
  maxRedirects: z.number().default(5),
  userAgent: z.string().default(DEFAULT_USER_AGENT),
  allowedPrivateHosts: z.array(z.string()).default([]),
  allowPrivateDns: z.boolean().default(false),
})

type ResolvedConfig = Required<Config>

/** Register `policy-http` and make its registry lifecycle follow this plugin. */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  assertPositiveFinite('maxResponseBytes', resolved.maxResponseBytes)
  assertPositiveFinite('maxBodyChars', resolved.maxBodyChars)
  assertTimeout(resolved.timeoutMs)
  assertNonNegativeInteger('maxRedirects', resolved.maxRedirects)
  if (resolved.userAgent.length === 0) {
    throw new Error('dsh-web-fetch-policy: userAgent must not be empty')
  }
  const addressPolicy = createAddressAccessPolicy(resolved.allowedPrivateHosts, resolved.allowPrivateDns)
  const limits: HttpFetchLimits = {
    maxResponseBytes: resolved.maxResponseBytes,
    maxBodyChars: resolved.maxBodyChars,
    timeoutMs: resolved.timeoutMs,
    maxRedirects: resolved.maxRedirects,
    userAgent: resolved.userAgent,
  }
  ctx.effect(() => ctx.web.registerFetchProvider(new PolicyHttpFetchProvider(limits, addressPolicy)))
}

/** Reject nonsensical byte, character, and timer limits at plugin construction. */
function assertPositiveFinite(field: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`dsh-web-fetch-policy: ${field} must be a positive finite number`)
  }
}

/** Reject Node timer values that would otherwise silently become one millisecond. */
function assertTimeout(value: number): void {
  assertPositiveFinite('timeoutMs', value)
  if (value > MAX_NODE_TIMER_DELAY_MS) {
    throw new Error(`dsh-web-fetch-policy: timeoutMs must be no greater than ${MAX_NODE_TIMER_DELAY_MS}`)
  }
}

/** Redirect budget permits zero but must otherwise be a non-negative integer. */
function assertNonNegativeInteger(field: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new Error(`dsh-web-fetch-policy: ${field} must be a non-negative integer`)
  }
}
