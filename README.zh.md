# dsh-web-fetch-policy

这是一个给 DeepSeek Harness `ctx.web` 使用的 HTTP(S) fetch provider，兼容 0.1.2-rc.1 和 0.1.6-alpha.2。默认只允许访问公网地址；需要访问本机或其他非公网地址时，可以通过配置明确放行目标。

## 解决 TUN 模式下的 web fetch 失败

部分 TUN 网络环境会把公网域名解析成 `198.18.0.0/16` 内的 Fake-IP。provider 会把这段地址视为非公网地址，因此默认拦截。确认该地址段由本机网络接管后，在 profile 的 `cordis.patch.yml` 中加入：

```yaml
- id: web-fetch-policy
  config:
    allowedPrivateCidrs:
      - 198.18.0.0/16
```

CIDR 白名单既匹配 URL 中直接出现的 IPv4 或 IPv6 地址，也匹配域名解析结果。对于域名，所有解析结果都必须是非公网地址并且全部落在已配置的 CIDR 内；混入公网地址或其他私网地址时仍会拦截。其他私网、回环、组播和未指定地址仍会被拦截。需要使用更宽的域名私网例外时，再同时配置 `allowedPrivateHosts` 和 `allowPrivateDns: true`。

## 安装与配置

```sh
dsh plugin --profile demo add github:caidwang/dsh-web-fetch-policy
```

bundle 会把 `ctx.web` 的 fetch provider 设为 `policy-http`。完整的安装步骤、配置字段和限制请参阅 [README.md](README.md)。

在 0.1.6-alpha.2 中，如果 DSH 提供 HTTP 代理工具，普通域名会沿用代理路由；0.1.2-rc.1 不带该工具，provider 会使用直连且地址固定的请求路径。
