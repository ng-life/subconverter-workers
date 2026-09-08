import { env } from 'cloudflare:workers';
import { reset, runInDurableObject } from 'cloudflare:test';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Provider } from '../src/model';

const provider: Provider = {
  name: 'mysub',
  type: 'uri',
  url: 'https://upstream.example/sub',
  headers: {},
  cacheTtlSeconds: 300,
  timeoutSeconds: 10,
};

function shadowsocks(name: string): string {
  return `ss://${btoa('aes-128-gcm:password')}@example.com:443#${name}`;
}

beforeEach(() => {
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await reset();
});

describe('intermediate model cache', () => {
  it('stores one normalized model and serializes formats on demand', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('model-cache');

    const result = await runInDurableObject(stub, async (instance, state) => {
      const upstream = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValue(new Response(shadowsocks('Hong%20Kong')));
      const clash = await instance.getSubscription(provider, 'clash');
      const quanx = await instance.getSubscription(provider, 'quanx');
      const row = state.storage.sql
        .exec<{ model: string }>('SELECT model FROM subscription_cache WHERE id = 1')
        .one();

      return {
        clashCache: clash.headers.get('x-subscription-cache'),
        quanxCache: quanx.headers.get('x-subscription-cache'),
        quanxBody: await quanx.text(),
        upstreamCalls: upstream.mock.calls.length,
        stored: JSON.parse(row.model) as { schemaVersion: number; nodes: unknown[] },
      };
    });

    expect(result.clashCache).toBe('MISS');
    expect(result.quanxCache).toBe('HIT');
    expect(result.quanxBody).toContain('tag=Hong Kong');
    expect(result.upstreamCalls).toBe(1);
    expect(result.stored.schemaVersion).toBe(1);
    expect(result.stored.nodes).toHaveLength(1);
  });

  it('refreshes an expired model before converting the response', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('expired-cache');

    const result = await runInDurableObject(stub, async (instance, state) => {
      const upstream = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(shadowsocks('Old')))
        .mockResolvedValueOnce(new Response(shadowsocks('New')));
      await instance.getSubscription(provider, 'clash');
      state.storage.sql.exec(
        'UPDATE subscription_cache SET attempted_at = 0, fetched_at = 0 WHERE id = 1',
      );
      const refreshed = await instance.getSubscription(provider, 'loon');

      return {
        cache: refreshed.headers.get('x-subscription-cache'),
        body: await refreshed.text(),
        upstreamCalls: upstream.mock.calls.length,
      };
    });

    expect(result.cache).toBe('REFRESH');
    expect(result.body).toContain('New = Shadowsocks');
    expect(result.upstreamCalls).toBe(2);
  });

  it('serves the last model as stale when an expired refresh fails', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('stale-cache');

    const result = await runInDurableObject(stub, async (instance, state) => {
      const upstream = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(shadowsocks('Last%20Known')))
        .mockRejectedValueOnce(new Error('upstream unavailable'));
      await instance.getSubscription(provider, 'clash');
      state.storage.sql.exec(
        'UPDATE subscription_cache SET attempted_at = 0, fetched_at = 0 WHERE id = 1',
      );
      const stale = await instance.getSubscription(provider, 'quanx');

      return {
        cache: stale.headers.get('x-subscription-cache'),
        body: await stale.text(),
        upstreamCalls: upstream.mock.calls.length,
      };
    });

    expect(result.cache).toBe('STALE');
    expect(result.body).toContain('tag=Last Known');
    expect(result.upstreamCalls).toBe(2);
  });
});
