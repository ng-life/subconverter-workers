import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        // Keep local tests on the newest compatibility date supported by the
        // bundled workerd binary. Production still uses wrangler.jsonc.
        compatibilityDate: '2026-08-22',
        bindings: {
          TOKEN: 'test-token',
          PROVIDERS: JSON.stringify({
            mysub: { type: 'uri', url: 'https://upstream.example/sub', cacheTtlSeconds: 300 },
          }),
        },
      },
    }),
  ],
  test: { include: ['test/**/*.test.ts'] },
});
