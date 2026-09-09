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
  it('persists pushed traffic and exposes it with static nodes', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('pushed-traffic');
    const pushProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: '',
      body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      const pushed = await instance.pushTraffic({
        schemaVersion: 1,
        collectedAt: 1_790_000_000,
        upload: 0,
        download: 100,
        total: 1000,
        resetAt: 1_800_000_000,
        payloadHash: 'hash',
      });
      const duplicate = await instance.pushTraffic({
        schemaVersion: 1,
        collectedAt: 1_790_000_000,
        upload: 0,
        download: 100,
        total: 1000,
        resetAt: 1_800_000_000,
        payloadHash: 'hash',
      });
      const response = await instance.getSubscription(pushProvider, 'quanx');
      return {
        pushed,
        duplicate,
        body: await response.text(),
        userinfo: response.headers.get('subscription-userinfo'),
        updatedAt: response.headers.get('x-subscription-traffic-updated-at'),
      };
    });

    expect(result.pushed.status).toBe('created');
    expect(result.duplicate.status).toBe('unchanged');
    expect(result.body).toContain('tag=Static');
    expect(result.userinfo).toBe('upload=0; download=100; total=1000; expire=1800000000');
    expect(result.updatedAt).toBe('2026-09-21T14:13:20.000Z');
  });

  it('rejects older and conflicting pushed traffic', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('pushed-traffic-order');
    const result = await runInDurableObject(stub, async (instance) => {
      await instance.pushTraffic({
        schemaVersion: 1,
        collectedAt: 20,
        total: 100,
        payloadHash: 'a',
      });
      return {
        stale: await instance.pushTraffic({
          schemaVersion: 1,
          collectedAt: 19,
          total: 90,
          payloadHash: 'b',
        }),
        conflict: await instance.pushTraffic({
          schemaVersion: 1,
          collectedAt: 20,
          total: 90,
          payloadHash: 'b',
        }),
      };
    });
    expect(result.stale.status).toBe('stale');
    expect(result.conflict.status).toBe('conflict');
  });

  it('uses a static QuanX body and exposes Bandwagon traffic metadata', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('static-bandwagon');
    const staticProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: 'https://api.example.com/service-info',
      body:
        'shadowsocks=example.com:443, method=aes-128-gcm, password=test, ' +
        'server_check_url=http://test.example/generate_204, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      const upstream = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({
          error: 0,
          data_counter: 100,
          plan_monthly_data: 1000,
          monthly_data_multiplier: 2,
          data_next_reset: 1790169013,
        }),
      );
      const response = await instance.getSubscription(staticProvider, 'quanx');
      return {
        body: await response.text(),
        cache: response.headers.get('x-subscription-cache'),
        userinfo: response.headers.get('subscription-userinfo'),
        upstreamCalls: upstream.mock.calls.length,
      };
    });

    expect(result.cache).toBe('MISS');
    expect(result.body).toContain('tag=Static');
    expect(result.body).toContain('server_check_url=http://test.example/generate_204');
    expect(result.userinfo).toBe('upload=0; download=200; total=2000; expire=1790169013');
    expect(result.upstreamCalls).toBe(1);
  });

  it('serves static nodes when Bandwagon traffic metadata is temporarily unavailable', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('static-bandwagon-degraded');
    const staticProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: 'https://api.example.com/service-info',
      body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        Response.json({ error: 1, message: 'temporary service error' }),
      );
      const response = await instance.getSubscription(staticProvider, 'quanx');
      return {
        status: response.status,
        body: await response.text(),
        cache: response.headers.get('x-subscription-cache'),
        warning: response.headers.get('x-subscription-warning'),
        userinfo: response.headers.get('subscription-userinfo'),
      };
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('tag=Static');
    expect(result.cache).toBe('STALE');
    expect(result.warning).toBe(
      'UPSTREAM_SERVICE_ERROR; upstream_body=%7B%22error%22%3A1%2C%22message%22%3A%22temporary%20service%20error%22%7D',
    );
    expect(result.userinfo).toBeNull();
  });

  it('serves static nodes when the Bandwagon endpoint cannot be reached', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('static-bandwagon-network-error');
    const staticProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: 'https://api.example.com/service-info',
      body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('network unavailable'));
      const response = await instance.getSubscription(staticProvider, 'quanx');
      return {
        status: response.status,
        body: await response.text(),
        warning: response.headers.get('x-subscription-warning'),
      };
    });

    expect(result.status).toBe(200);
    expect(result.body).toContain('tag=Static');
    expect(result.warning).toBe('UPSTREAM_FETCH_FAILED');
  });

  it('reports a safe upstream HTTP status while serving static nodes', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('static-bandwagon-http-error');
    const staticProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: 'https://api.example.com/service-info',
      body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response('Forbidden', { status: 403 }));
      const response = await instance.getSubscription(staticProvider, 'quanx');
      return {
        status: response.status,
        warning: response.headers.get('x-subscription-warning'),
      };
    });

    expect(result.status).toBe(200);
    expect(result.warning).toBe('UPSTREAM_HTTP_ERROR; upstream_body=Forbidden');
  });

  it('reports the HTTP status when an upstream error has no body', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('static-bandwagon-empty-http-error');
    const staticProvider: Provider = {
      ...provider,
      type: 'quanx',
      url: 'https://api.example.com/service-info',
      body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=Static',
    };

    const result = await runInDurableObject(stub, async (instance) => {
      vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 403 }));
      const response = await instance.getSubscription(staticProvider, 'quanx');
      return response.headers.get('x-subscription-warning');
    });

    expect(result).toBe('UPSTREAM_HTTP_ERROR; status=403');
  });

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

  it('force-refreshes a fresh model before converting the response', async () => {
    const stub = env.SUBSCRIPTIONS.getByName('forced-refresh');

    const result = await runInDurableObject(stub, async (instance) => {
      const upstream = vi
        .spyOn(globalThis, 'fetch')
        .mockResolvedValueOnce(new Response(shadowsocks('Old')))
        .mockResolvedValueOnce(new Response(shadowsocks('Forced')));
      await instance.getSubscription(provider, 'clash');
      const refreshed = await instance.getSubscription(provider, 'quanx', true);

      return {
        cache: refreshed.headers.get('x-subscription-cache'),
        body: await refreshed.text(),
        upstreamCalls: upstream.mock.calls.length,
      };
    });

    expect(result.cache).toBe('REFRESH');
    expect(result.body).toContain('tag=Forced');
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
