import { defineConfig } from 'tsdown'

export default defineConfig({
  entry: ['src/index.ts'],
  format: 'esm',
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
})
