import { defineConfig } from 'tsdown'

const host = {
  entry: ['src/index.ts'],
  format: 'esm' as const,
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'lib',
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/dsh-http-proxy',
      '@deepseek-ai/dsh-timeout',
      '@deepseek-ai/dsh-web',
      '@deepseek-ai/schemastery',
      'ipaddr.js',
      'undici',
    ],
  },
}

const client = {
  entry: { client: 'src/client.ts' },
  format: 'cjs' as const,
  platform: 'browser' as const,
  dts: false,
  sourcemap: true,
  clean: false,
  outDir: 'client',
  deps: { neverBundle: ['react'] },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: 'window.__ModuleLoader__.load({ id: "dsh-web-fetch-policy", factory: (require) => {',
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
}

export default defineConfig([host, client])
