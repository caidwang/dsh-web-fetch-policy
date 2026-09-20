/**
 * DNS policy and address-pinned HTTP transport.
 *
 * Derived from @deepseek-ai/dsh-web-fetch-http (MIT), with the private-host
 * exception policy added here. A DNS answer is checked as a complete set and
 * the following request can use only the retained addresses.
 */

import { lookup as systemLookup } from 'node:dns/promises'
import type { LookupAddress, LookupOptions } from 'node:dns'
import { isIP } from 'node:net'
import type { Dispatcher, Response } from 'undici'
import ipaddr from 'ipaddr.js'
import { WebError } from '@deepseek-ai/dsh-web'

/** One resolved address retained for an address-pinned connection. */
export interface ResolvedAddress {
  readonly address: string
  readonly family: 4 | 6
}

/** A response paired with its request-local transport disposer. */
export interface PinnedResponse {
  readonly response: Response
  close(): Promise<void>
}

/** Injectable only for tests; production uses Node's system resolver. */
export type AddressResolver = (hostname: string, options: { all: true; order: 'verbatim' }) => Promise<LookupAddress[]>

/** Validated, explicit exceptions to the public-address default. */
export interface AddressAccessPolicy {
  readonly allowedPrivateHosts: ReadonlySet<string>
  readonly allowPrivateDns: boolean
}

type AddressClass = 'public' | 'private' | 'unsafe'

const IPV4ONLY_DISCOVERY_HOST = 'ipv4only.arpa'
const IPV4ONLY_SENTINELS = new Set(['192.0.0.170', '192.0.0.171'])
const RFC6052_PREFIX_LENGTHS = [32, 40, 48, 56, 64, 96] as const

interface Nat64Prefix {
  readonly bytes: readonly number[]
  readonly length: typeof RFC6052_PREFIX_LENGTHS[number]
}

/** Create a validated address policy from the load-time plugin configuration. */
export function createAddressAccessPolicy(
  configuredHosts: readonly string[],
  allowPrivateDns: boolean,
): AddressAccessPolicy {
  const allowedPrivateHosts = new Set<string>()
  for (const host of configuredHosts) {
    const normalized = normalizeAllowedPrivateHost(host)
    if (allowedPrivateHosts.has(normalized)) {
      throw new Error(`dsh-web-fetch-policy: allowedPrivateHosts contains duplicate host "${host}"`)
    }
    allowedPrivateHosts.add(normalized)
  }
  return { allowedPrivateHosts, allowPrivateDns }
}

/** Normalize and validate one exact allowlist entry. Wildcards and ports are forbidden. */
export function normalizeAllowedPrivateHost(input: string): string {
  if (input.length === 0 || input.trim() !== input) {
    throw new Error('dsh-web-fetch-policy: allowedPrivateHosts entries must be non-empty hostnames or IP literals without whitespace')
  }
  if (input.includes('*') || input.includes('/') || input.includes('@') || input.includes(':') && !input.startsWith('[')) {
    throw new Error(`dsh-web-fetch-policy: allowedPrivateHosts entry "${input}" must be one exact hostname or IP literal, without a wildcard, port, or URL`)
  }

  const literal = stripIpv6Brackets(input)
  const family = isIP(literal)
  if (family !== 0) {
    const canonical = ipaddr.parse(literal).toString()
    if (classifyIpAddress(canonical) !== 'private') {
      throw new Error(`dsh-web-fetch-policy: allowed private IP "${input}" must be a connectable non-public unicast address`)
    }
    return family === 6 ? `[${canonical}]` : canonical
  }

  const normalized = input.toLowerCase()
  if (normalized.length > 253 || !isExactHostname(normalized)) {
    throw new Error(`dsh-web-fetch-policy: allowedPrivateHosts entry "${input}" must be one exact DNS hostname`)
  }
  return normalized
}

/** Return true only for globally reachable unicast IPv4/IPv6 addresses. */
export function isPublicIpAddress(input: string): boolean {
  return classifyIpAddress(input) === 'public'
}

/** Return true for a literal that normally requires an explicit exception. */
export function isNonPublicIpLiteral(hostname: string): boolean {
  const literal = stripIpv6Brackets(hostname)
  return isIP(literal) !== 0 && !isPublicIpAddress(literal)
}

/**
 * Resolve once, validate every answer, and return the fixed address set for a
 * later connection. A private DNS exception is accepted only when every answer
 * is private and the queried hostname is explicitly allowlisted.
 */
export async function resolvePolicyAddresses(
  hostname: string,
  signal: AbortSignal,
  policy: AddressAccessPolicy,
  resolver: AddressResolver = systemLookup,
): Promise<ResolvedAddress[]> {
  const literal = stripIpv6Brackets(hostname)
  const literalFamily = isIP(literal)
  const resolved = literalFamily === 0
    ? await raceWithSignal(resolver(literal, { all: true, order: 'verbatim' }), signal)
    : [{ address: literal, family: literalFamily }]

  if (resolved.length === 0) {
    throw new WebError(`hostname "${hostname}" resolved to no addresses`, 'WEB_PROVIDER_ERROR')
  }

  const normalizedHost = normalizeRuntimeHostname(hostname)
  // An explicitly allowlisted loopback IPv6 literal needs no DNS64 probe. A
  // public literal still gets the probe because it could be a NAT64 encoding.
  // `localhost` gets the same treatment only when explicitly listed; it is
  // subsequently required to contain loopback answers exclusively.
  const hasIpv6 = resolved.some(entry => entry.family === 6 && isIP(entry.address) === 6)
    && !(literalFamily === 6 && classifyIpAddress(literal) === 'private')
    && !(normalizedHost === 'localhost' && policy.allowedPrivateHosts.has('localhost'))
  const nat64Prefixes = hasIpv6 ? await discoverNat64Prefixes(signal, resolver) : []
  const addresses: ResolvedAddress[] = []
  const classes: AddressClass[] = []

  for (const entry of resolved) {
    if ((entry.family !== 4 && entry.family !== 6) || isIP(entry.address) !== entry.family) {
      throw new WebError(`hostname "${hostname}" resolved to an invalid IP address`, 'WEB_PROVIDER_ERROR')
    }
    const translated = translatedIpv4Address(entry.address, nat64Prefixes)
    const addressClass = classifyIpAddress(translated ?? entry.address)
    if (addressClass === 'unsafe') {
      throw new WebError(`URL hostname "${hostname}" resolves to an unsafe non-public IP address`, 'WEB_BLOCKED_URL')
    }
    classes.push(addressClass)
    addresses.push({ address: entry.address, family: entry.family })
  }

  const localhostAllowed = normalizedHost === 'localhost' && policy.allowedPrivateHosts.has('localhost')
  if (localhostAllowed && !addresses.every(({ address }) => isLoopbackAddress(address))) {
    throw new WebError(`URL hostname "${hostname}" must resolve only to loopback addresses`, 'WEB_BLOCKED_URL')
  }

  const allPublic = classes.every(addressClass => addressClass === 'public')
  if (allPublic) return addresses

  const allPrivate = classes.every(addressClass => addressClass === 'private')
  const literalAllowed = literalFamily !== 0 && policy.allowedPrivateHosts.has(normalizedHost)
  const privateDnsAllowed = literalFamily === 0
    && normalizedHost !== 'localhost'
    && policy.allowPrivateDns
    && policy.allowedPrivateHosts.has(normalizedHost)

  // A DNS response containing both public and private addresses can shift the
  // request to a different network class. Reject it even for approved hosts.
  if (!allPrivate) {
    throw new WebError(`URL hostname "${hostname}" resolves to mixed public and non-public addresses`, 'WEB_BLOCKED_URL')
  }
  if (literalAllowed) return addresses
  if (localhostAllowed) return addresses
  if (privateDnsAllowed) return addresses
  throw new WebError(`URL hostname "${hostname}" resolves to a non-public IP address`, 'WEB_BLOCKED_URL')
}

/** Request directly through an agent whose DNS lookup exposes only validated answers. */
export async function requestPinned(
  url: URL,
  addresses: readonly ResolvedAddress[],
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const { Agent, fetch } = await import('undici')
  const dispatcher = new Agent({ autoSelectFamily: true, connect: { lookup: createPinnedLookup(addresses) } })
  try {
    const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
    return { response, close: async () => { await dispatcher.close() } }
  } catch (error: unknown) {
    await dispatcher.close()
    throw error
  }
}

/** Request through the proxy dispatcher selected by dsh-http-proxy. */
export async function requestVia(
  dispatcher: Dispatcher,
  url: URL,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<PinnedResponse> {
  const { fetch } = await import('undici')
  const response = await fetch(url, { method: 'GET', redirect: 'manual', headers, signal, dispatcher })
  return { response, close: () => Promise.resolve() }
}

/** Operations retained behind an object for focused provider tests. */
export const policyHttpNetwork = {
  resolve: resolvePolicyAddresses,
  request: requestPinned,
  requestVia,
}

/** Build a Node lookup callback that cannot issue another DNS query. */
export function createPinnedLookup(addresses: readonly ResolvedAddress[]): (
  hostname: string,
  options: LookupOptions,
  callback: (error: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void,
) => void {
  return (hostname, options, callback): void => {
    const family = typeof options.family === 'number'
      ? options.family
      : options.family === 'IPv4' ? 4 : options.family === 'IPv6' ? 6 : 0
    const eligible = family === 0 ? addresses : addresses.filter(address => address.family === family)
    const selected = eligible[0]
    if (selected === undefined) {
      const error = Object.assign(new Error(`no validated address for ${hostname} in family ${family}`), { code: 'ENOTFOUND', hostname })
      callback(error, options.all === true ? [] : '', family)
      return
    }
    if (options.all === true) {
      callback(null, eligible.map(address => ({ ...address })))
      return
    }
    callback(null, selected.address, selected.family)
  }
}

/** Discover DNS64 prefixes using the RFC 7050 ipv4only.arpa probe. */
async function discoverNat64Prefixes(signal: AbortSignal, resolver: AddressResolver): Promise<Nat64Prefix[]> {
  const discovered = await raceWithSignal(resolver(IPV4ONLY_DISCOVERY_HOST, { all: true, order: 'verbatim' }), signal)
  const prefixes: Nat64Prefix[] = []
  const seen = new Set<string>()
  for (const entry of discovered) {
    if (entry.family !== 6 || isIP(entry.address) !== 6) continue
    const bytes = ipaddr.parse(entry.address).toByteArray()
    for (const length of RFC6052_PREFIX_LENGTHS) {
      const embedded = embeddedIpv4Address(bytes, length)
      if (embedded === undefined || !IPV4ONLY_SENTINELS.has(embedded)) continue
      const prefixBytes = bytes.slice(0, length / 8)
      const key = `${String(length)}:${prefixBytes.join('.')}`
      if (!seen.has(key)) {
        seen.add(key)
        prefixes.push({ bytes: prefixBytes, length })
      }
    }
  }
  return prefixes
}

/** Extract an underlying IPv4 address when an IPv6 answer matches a DNS64 prefix. */
function translatedIpv4Address(input: string, prefixes: readonly Nat64Prefix[]): string | undefined {
  if (isIP(input) !== 6) return undefined
  const bytes = ipaddr.parse(input).toByteArray()
  for (const prefix of prefixes) {
    if (!prefix.bytes.every((byte, index) => bytes[index] === byte)) continue
    const embedded = embeddedIpv4Address(bytes, prefix.length)
    if (embedded !== undefined) return embedded
  }
  return undefined
}

/** Decode the RFC 6052 layouts supported by DNS64. */
function embeddedIpv4Address(bytes: readonly number[], prefixLength: Nat64Prefix['length']): string | undefined {
  if (prefixLength === 96) return bytes.slice(12, 16).join('.')
  if (bytes[8] !== 0) return undefined
  const prefixBytes = prefixLength / 8
  const beforeReserved = 8 - prefixBytes
  return [
    ...bytes.slice(prefixBytes, prefixBytes + beforeReserved),
    ...bytes.slice(9, 9 + 4 - beforeReserved),
  ].join('.')
}

/** Classify an address for this plugin's narrow exception policy. */
function classifyIpAddress(input: string): AddressClass {
  let parsed: ipaddr.IPv4 | ipaddr.IPv6
  try {
    parsed = ipaddr.parse(stripIpv6Brackets(input))
  } catch {
    return 'unsafe'
  }
  if (parsed instanceof ipaddr.IPv4) {
    if (parsed.range() === 'unicast') return 'public'
    if (['unspecified', 'broadcast', 'multicast'].includes(parsed.range())) return 'unsafe'
    // ipaddr.js groups 198.18.0.0/15 (RFC 2544 benchmarking, used by Clash
    // Fake-IP) under `reserved`; it is connectable enough for an exact operator
    // exception, unlike the rest of that broad reserved bucket.
    if (parsed.range() === 'reserved' && !parsed.match(ipaddr.parse('198.18.0.0') as ipaddr.IPv4, 15)) return 'unsafe'
    return 'private'
  }
  if (parsed.isIPv4MappedAddress()) return classifyIpAddress(parsed.toIPv4Address().toString())
  if (parsed.range() === 'unicast') return 'public'
  return ['unspecified', 'multicast', 'reserved'].includes(parsed.range()) ? 'unsafe' : 'private'
}

/** `localhost` may only use loopback answers; DNS must not widen that exception. */
function isLoopbackAddress(input: string): boolean {
  const parsed = ipaddr.parse(stripIpv6Brackets(input))
  if (parsed instanceof ipaddr.IPv4) return parsed.range() === 'loopback'
  if (parsed.isIPv4MappedAddress()) return parsed.toIPv4Address().range() === 'loopback'
  return parsed.range() === 'loopback'
}

/** Hostname validation for config entries: DNS labels only, no ports or wildcards. */
function isExactHostname(hostname: string): boolean {
  return hostname.split('.').every(label => label.length > 0 && label.length <= 63 && /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label))
}

/** WHATWG URL keeps brackets around IPv6 hostnames; IP parsers do not. */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname
}

/** Runtime URL hostnames are normalized only enough to compare exact entries. */
function normalizeRuntimeHostname(hostname: string): string {
  const literal = stripIpv6Brackets(hostname)
  const family = isIP(literal)
  if (family === 0) return hostname.toLowerCase()
  const canonical = ipaddr.parse(literal).toString()
  return family === 6 ? `[${canonical}]` : canonical
}

/** Race the non-cancellable OS resolver so user cancellation stays prompt. */
function raceWithSignal<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = () => new Error('web fetch aborted during hostname resolution', { cause: signal.reason })
  if (signal.aborted) return Promise.reject(aborted())
  return new Promise<T>((resolve, reject) => {
    const abort = () => { reject(aborted()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => { signal.removeEventListener('abort', abort) })
  })
}
