import { defineConfig } from 'vitest/config';
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';

export default defineConfig({
  plugins: [cloudflareTest({
    wrangler: { configPath: './wrangler.jsonc' },
    miniflare: { bindings: {
      TOKEN: 'test-token',
      PROVIDERS: JSON.stringify({ mysub: { type: 'uri', url: 'https://upstream.example/sub', minRefreshIntervalSeconds: 300 } }),
    } },
  })],
  test: { include: ['test/**/*.test.ts'] },
});
