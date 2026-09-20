import { describe, expect, it } from 'vitest'
import type { AddressResolver } from '../src/network.js'
import {
  createAddressAccessPolicy,
  createPinnedLookup,
  normalizeAllowedPrivateCidr,
  normalizeAllowedPrivateHost,
  resolvePolicyAddresses,
} from '../src/network.js'

function resolver(entries: Array<{ address: string; family: 4 | 6 }>): AddressResolver {
  return async hostname => hostname === 'ipv4only.arpa' ? [] : entries
}

describe('private-address policy', () => {
  it('keeps the default public-only', async () => {
    const policy = createAddressAccessPolicy([], false)
    await expect(resolvePolicyAddresses('public.test', new AbortController().signal, policy, resolver([
      { address: '8.8.8.8', family: 4 },
    ]))).resolves.toEqual([{ address: '8.8.8.8', family: 4 }])
    await expect(resolvePolicyAddresses('private.test', new AbortController().signal, policy, resolver([
      { address: '10.0.0.5', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('permits an exact listed private literal but denies another one', async () => {
    const policy = createAddressAccessPolicy(['127.0.0.1'], false)
    await expect(resolvePolicyAddresses('127.0.0.1', new AbortController().signal, policy)).resolves.toEqual([
      { address: '127.0.0.1', family: 4 },
    ])
    await expect(resolvePolicyAddresses('127.0.0.2', new AbortController().signal, policy)).rejects
      .toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('permits an exact listed reserved-range literal while retaining the default deny', async () => {
    const policy = createAddressAccessPolicy(['198.18.0.1'], false)
    await expect(resolvePolicyAddresses('198.18.0.1', new AbortController().signal, policy)).resolves.toEqual([
      { address: '198.18.0.1', family: 4 },
    ])
    await expect(resolvePolicyAddresses('198.18.0.1', new AbortController().signal, createAddressAccessPolicy([], false)))
      .rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('permits literal destinations inside configured IPv4 and IPv6 CIDRs only', async () => {
    const policy = createAddressAccessPolicy([], false, ['198.18.0.0/16', 'fc00::/7'])
    await expect(resolvePolicyAddresses('198.18.0.1', new AbortController().signal, policy)).resolves.toEqual([
      { address: '198.18.0.1', family: 4 },
    ])
    await expect(resolvePolicyAddresses('198.19.0.1', new AbortController().signal, policy)).rejects
      .toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePolicyAddresses('fd12::1', new AbortController().signal, policy)).resolves.toEqual([
      { address: 'fd12::1', family: 6 },
    ])
    await expect(resolvePolicyAddresses('fe80::1', new AbortController().signal, policy)).rejects
      .toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('allows DNS answers only when every non-public answer matches a configured CIDR', async () => {
    const policy = createAddressAccessPolicy([], false, ['198.18.0.0/16'])
    await expect(resolvePolicyAddresses('example.test', new AbortController().signal, policy, resolver([
      { address: '198.18.0.1', family: 4 },
    ]))).resolves.toEqual([{ address: '198.18.0.1', family: 4 }])
    await expect(resolvePolicyAddresses('example.test', new AbortController().signal, policy, resolver([
      { address: '198.18.0.1', family: 4 },
      { address: '198.19.0.1', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePolicyAddresses('example.test', new AbortController().signal, policy, resolver([
      { address: '198.18.0.1', family: 4 },
      { address: '10.0.0.1', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePolicyAddresses('example.test', new AbortController().signal, policy, resolver([
      { address: '198.18.0.1', family: 4 },
      { address: '8.8.8.8', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('lets localhost use loopback only', async () => {
    const policy = createAddressAccessPolicy(['localhost'], false)
    const calls: string[] = []
    const loopbackResolver: AddressResolver = async hostname => {
      calls.push(hostname)
      if (hostname === 'localhost') return [{ address: '127.0.0.1', family: 4 }, { address: '::1', family: 6 }]
      throw new Error(`unexpected DNS64 lookup for ${hostname}`)
    }
    await expect(resolvePolicyAddresses('localhost', new AbortController().signal, policy, loopbackResolver)).resolves.toHaveLength(2)
    expect(calls).toEqual(['localhost'])
    await expect(resolvePolicyAddresses('localhost', new AbortController().signal, policy, resolver([
      { address: '10.0.0.5', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePolicyAddresses('localhost', new AbortController().signal, policy, resolver([
      { address: '8.8.8.8', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    const privateDnsEnabled = createAddressAccessPolicy(['localhost'], true)
    await expect(resolvePolicyAddresses('localhost', new AbortController().signal, privateDnsEnabled, resolver([
      { address: '10.0.0.5', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('does not require DNS64 discovery for an explicitly allowed private IPv6 literal', async () => {
    const policy = createAddressAccessPolicy(['[::1]'], false)
    const resolver = async (): Promise<never[]> => { throw new Error('DNS must not run for an IPv6 literal') }
    await expect(resolvePolicyAddresses('[::1]', new AbortController().signal, policy, resolver)).resolves.toEqual([
      { address: '::1', family: 6 },
    ])
  })

  it('permits a listed DNS name to resolve privately only when allowPrivateDns is on', async () => {
    const answers = resolver([{ address: '10.0.0.5', family: 4 }])
    const locked = createAddressAccessPolicy(['service.internal'], false)
    const enabled = createAddressAccessPolicy(['service.internal'], true)
    await expect(resolvePolicyAddresses('service.internal', new AbortController().signal, locked, answers)).rejects
      .toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
    await expect(resolvePolicyAddresses('service.internal', new AbortController().signal, enabled, answers)).resolves
      .toEqual([{ address: '10.0.0.5', family: 4 }])
  })

  it('rejects a mixed public/private DNS answer set even for an approved DNS name', async () => {
    const policy = createAddressAccessPolicy(['service.internal'], true)
    await expect(resolvePolicyAddresses('service.internal', new AbortController().signal, policy, resolver([
      { address: '8.8.8.8', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]))).rejects.toThrow(expect.objectContaining({ code: 'WEB_BLOCKED_URL' }))
  })

  it('rejects wildcard, public, and non-connectable allowlist entries at load time', () => {
    expect(() => createAddressAccessPolicy(['*.internal'], true)).toThrow('exact hostname')
    expect(() => createAddressAccessPolicy(['8.8.8.8'], false)).toThrow('connectable non-public')
    expect(() => createAddressAccessPolicy(['0.0.0.0'], false)).toThrow('connectable non-public')
    expect(normalizeAllowedPrivateHost('[::1]')).toBe('[::1]')
    expect(normalizeAllowedPrivateCidr('198.18.0.0/16')).toEqual({ network: '198.18.0.0', family: 4, prefixLength: 16 })
    expect(normalizeAllowedPrivateCidr('fc00::/7')).toEqual({ network: 'fc00::', family: 6, prefixLength: 7 })
    expect(() => createAddressAccessPolicy([], false, ['198.18.0.1/16'])).toThrow('network address')
    expect(() => createAddressAccessPolicy([], false, ['8.8.8.0/24'])).toThrow('connectable non-public')
    expect(() => createAddressAccessPolicy([], false, ['0.0.0.0/0'])).toThrow('connectable non-public')
    expect(() => createAddressAccessPolicy([], false, ['224.0.0.0/4'])).toThrow('connectable non-public')
    expect(() => createAddressAccessPolicy([], false, ['198.18.0.0/16', '198.18.0.0/16'])).toThrow('duplicate CIDR')
  })
})

describe('address pinning', () => {
  it('serves the retained answer set without another resolver call', async () => {
    const lookup = createPinnedLookup([{ address: '10.0.0.5', family: 4 }])
    const result = await new Promise<{ address: string | import('node:dns').LookupAddress[]; family?: number }>((resolve, reject) => {
      lookup('rebound.internal', {}, (error, address, family) => {
        if (error !== null) reject(error)
        else resolve({ address, ...(family === undefined ? {} : { family }) })
      })
    })
    expect(result).toEqual({ address: '10.0.0.5', family: 4 })
  })
})
