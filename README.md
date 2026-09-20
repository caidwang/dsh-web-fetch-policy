# dsh-web-fetch-policy

`dsh-web-fetch-policy` is an out-of-tree `ctx.web` HTTP(S) fetch provider for
DeepSeek Harness 0.1.6-alpha.2. It starts public-only, then adds narrow,
auditable exceptions for exact non-public destinations while preserving DNS
answer-set validation, address pinning, size limits, timeouts, and same-origin
redirect checks.

It registers as `policy-http`. Its bundle patch changes the existing `web` row
to `fetchProvider: policy-http`; the standard `http` provider may stay loaded,
but it is no longer selected.

## Install

```sh
dsh plugin --profile demo add github:caidwang/dsh-web-fetch-policy
```

Git installation builds TypeScript with `prepare`. With pnpm 10 or newer, add
the package to the profile's `pnpm-workspace.yaml` if pnpm asks for approval:

```yaml
allowBuilds:
  dsh-web-fetch-policy: true
```

Then run the same `dsh plugin ... add` command again. Treat that approval as
permission to execute this repository's build script; pin a commit SHA in a
production install. Publishing to npm or installing a packed tarball uses the
prebuilt `lib/` files and does not need this build approval.

## Configure explicit exceptions

The bundle inserts a row named `web-fetch-policy`. Override that row in the
profile's `cordis.patch.yml`:

```yaml
- id: web-fetch-policy
  config:
    allowedPrivateHosts:
      - 127.0.0.1
      - localhost
      - api.corp.example
    allowedPrivateCidrs:
      - 198.18.0.0/16 # only when this reserved range is an intentional local target
    allowPrivateDns: true
```

`allowedPrivateHosts` contains exact hostnames or IP literals only. Wildcards,
URLs, CIDR ranges, ports, public IPs, unspecified addresses, and multicast
addresses fail plugin load. `allowedPrivateCidrs` contains canonical IPv4 or
IPv6 network ranges and can match a literal URL IP or DNS answers. For a DNS
name, every answer must be non-public and inside an allowed CIDR; a public
answer or an answer from another non-public range rejects the request. Both
lists accept only connectable non-public destinations. An exact listed
non-public literal works with the default `allowPrivateDns: false`. A listed
`localhost` may resolve only to loopback addresses. A normal DNS hostname can
use `allowPrivateDns: true` with an exact `allowedPrivateHosts` entry when a
broader private-DNS exception is intended.

When private DNS is enabled, every answer for the exact listed hostname must be
connectable and non-public. A response containing both public and non-public
answers is rejected. The accepted full answer set is passed to a request-local
DNS lookup, so the subsequent connection cannot re-resolve the hostname to a
different address. Each allowed same-origin redirect repeats this process.

All other provider limits retain the standard defaults and can be set on the
same row:

| Field | Default |
| --- | ---: |
| `maxResponseBytes` | 5,000,000 |
| `maxBodyChars` | 100,000 |
| `timeoutMs` | 30,000 |
| `maxRedirects` | 5 |
| `userAgent` | `dsh-web-fetch-policy/...` |

## Proxy behavior

For a hostname routed through `HTTP_PROXY`/`HTTPS_PROXY`, the proxy performs
the origin lookup, so this provider retains DSH's proxy behavior and does not
run a local public-IP check or pin a local origin address. A non-public IP
literal does not take that shortcut: it uses the local policy and pinned path.

This package governs `ctx.web.fetch()` only. It does not regulate network
connections made by shell commands, browsers, MCP servers, or other plugins.

## Source attribution

This implementation is derived from
[`@deepseek-ai/dsh-web-fetch-http`](https://github.com/deepseek-ai/deepseek-harness/tree/main/packages/web/web-fetch-http),
including its address pinning, DNS64 handling, proxy routing, redirects, and
bounded text decoding paths. Those portions are MIT licensed; see
[LICENSE](LICENSE).

## Development

Use Node `^22.19.0` or `>=24.0.0`.

```sh
pnpm install
pnpm test
pnpm typecheck
pnpm build
```
