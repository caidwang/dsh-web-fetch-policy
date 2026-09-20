import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installProxyFromEnvironment } from '@deepseek-ai/dsh-http-proxy'
import { createAddressAccessPolicy, policyHttpNetwork } from '../src/network.js'
import { PolicyHttpFetchProvider } from '../src/provider.js'
import type { HttpFetchLimits } from '../src/provider.js'

const limits: HttpFetchLimits = {
  maxResponseBytes: 1_000_000,
  maxBodyChars: 100_000,
  timeoutMs: 5_000,
  maxRedirects: 5,
  userAgent: 'policy-test/1.0',
}

let origin: Server
let originUrl: string
let originRequests: string[]
let proxy: Server
let proxyUrl: string
let proxied: string[]
let disposeProxy: (() => Promise<void>) | undefined

function listen(server: Server): Promise<AddressInfo> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address() as AddressInfo)))
}

function respond(_request: IncomingMessage, response: ServerResponse, body: string): void {
  response.writeHead(200, { 'content-type': 'text/plain' })
  response.end(body)
}

beforeEach(async () => {
  originRequests = []
  proxied = []
  origin = createServer((request, response) => {
    originRequests.push(request.url ?? '')
    if (request.url === '/redirect') {
      response.writeHead(302, { location: '/final' })
      response.end()
      return
    }
    respond(request, response, request.url === '/final' ? 'redirected' : 'direct')
  })
  proxy = createServer((request, response) => {
    proxied.push(request.url ?? '')
    respond(request, response, 'via-proxy')
  })
  const [originAddress, proxyAddress] = await Promise.all([listen(origin), listen(proxy)])
  originUrl = `http://127.0.0.1:${String(originAddress.port)}`
  proxyUrl = `http://127.0.0.1:${String(proxyAddress.port)}`
})

afterEach(async () => {
  await disposeProxy?.()
  disposeProxy = undefined
  vi.restoreAllMocks()
  await Promise.all([
    new Promise<void>(resolve => origin.close(() => resolve())),
    new Promise<void>(resolve => proxy.close(() => resolve())),
  ])
})

async function installProxy(): Promise<void> {
  const env = {
    get: (name: string) => name === 'HTTP_PROXY' || name === 'HTTPS_PROXY' ? { value: proxyUrl } : undefined,
  }
  disposeProxy = await installProxyFromEnvironment(env, () => undefined)
}

describe('provider transport policy', () => {
  it('rechecks and pins every same-origin redirect hop', async () => {
    const policy = createAddressAccessPolicy(['127.0.0.1'], false)
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const provider = new PolicyHttpFetchProvider(limits, policy, resolve)

    await expect(provider.fetch({ url: `${originUrl}/redirect` })).resolves.toMatchObject({
      url: `${originUrl}/final`,
      body: { kind: 'text', content: 'redirected' },
    })
    expect(resolve).toHaveBeenCalledTimes(2)
    expect(originRequests).toEqual(['/redirect', '/final'])
  })

  it('uses the configured HTTP proxy for a hostname and skips local resolution', async () => {
    await installProxy()
    const resolve = vi.spyOn(policyHttpNetwork, 'resolve')
    const provider = new PolicyHttpFetchProvider(limits, createAddressAccessPolicy([], false))

    await expect(provider.fetch({ url: 'http://proxy-origin.test/page' })).resolves.toMatchObject({
      body: { kind: 'text', content: 'via-proxy' },
    })
    expect(proxied).toEqual(['http://proxy-origin.test/page'])
    expect(resolve).not.toHaveBeenCalled()
  })

  it('keeps a non-public literal on the local pinned-policy path even with a proxy', async () => {
    await installProxy()
    const policy = createAddressAccessPolicy(['127.0.0.1'], false)
    const resolve = vi.fn(async () => [{ address: '127.0.0.1', family: 4 as const }])
    const provider = new PolicyHttpFetchProvider(limits, policy, resolve)

    await expect(provider.fetch({ url: `${originUrl}/direct` })).resolves.toMatchObject({
      body: { kind: 'text', content: 'direct' },
    })
    expect(resolve).toHaveBeenCalledOnce()
    expect(proxied).toEqual([])
  })
})
