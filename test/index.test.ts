import { describe, expect, it, vi } from 'vitest';
import worker, { forceRefresh, parseRoute } from '../src/index';
import type { Provider, Target } from '../src/model';

function createEnv() {
  const getSubscription = vi.fn(
    async (_provider: Provider, target: Target) => new Response(target),
  );
  const getByName = vi.fn(() => ({ getSubscription }));

  return {
    env: {
      TOKEN: 'test-token',
      PUSH_TOKEN: 'test-push-token',
      PROVIDERS: JSON.stringify({
        mysub: {
          type: 'uri',
          url: 'https://upstream.example/sub',
          cacheTtlSeconds: 300,
        },
      }),
      SUBSCRIPTIONS: { getByName },
    } as unknown as Env,
    getByName,
    getSubscription,
  };
}

describe('request routing', () => {
  it('parses /providerName/format routes', () => {
    expect(parseRoute('/my-provider/clash')).toEqual({
      providerName: 'my-provider',
      target: 'clash',
    });
  });

  it('rejects the legacy route and unknown formats', () => {
    expect(() => parseRoute('/clash')).toThrow('ROUTE_NOT_FOUND');
    expect(() => parseRoute('/mysub/surge')).toThrow('FORMAT_NOT_FOUND');
    expect(() => parseRoute('/mysub/clash/extra')).toThrow('ROUTE_NOT_FOUND');
  });

  it('resolves the provider from the path and delegates the target format', async () => {
    const { env, getByName, getSubscription } = createEnv();
    const response = await worker.fetch(
      new Request('https://worker.example/mysub/quanx?token=test-token'),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.text()).toBe('quanx');
    expect(getByName).toHaveBeenCalledOnce();
    expect(getSubscription).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'uri', cacheTtlSeconds: 300 }),
      'quanx',
      false,
    );
  });

  it('passes an explicit force-refresh request to the provider cache', async () => {
    const { env, getSubscription } = createEnv();
    const response = await worker.fetch(
      new Request('https://worker.example/mysub/quanx?token=test-token&refresh=true'),
      env,
    );

    expect(response.status).toBe(200);
    expect(getSubscription).toHaveBeenCalledWith(expect.anything(), 'quanx', true);
  });

  it('validates refresh parameter values', () => {
    expect(forceRefresh(new URL('https://worker.example/sub?refresh=1'))).toBe(true);
    expect(forceRefresh(new URL('https://worker.example/sub?refresh=true'))).toBe(true);
    expect(forceRefresh(new URL('https://worker.example/sub?refresh=0'))).toBe(false);
    expect(forceRefresh(new URL('https://worker.example/sub?refresh=false'))).toBe(false);
    expect(() => forceRefresh(new URL('https://worker.example/sub?refresh=yes'))).toThrow(
      'INVALID_REFRESH_PARAMETER',
    );
    expect(() => forceRefresh(new URL('https://worker.example/sub?refresh=1&refresh=1'))).toThrow(
      'INVALID_REFRESH_PARAMETER',
    );
  });

  it('requires exactly one valid token', async () => {
    const { env, getSubscription } = createEnv();
    const response = await worker.fetch(
      new Request('https://worker.example/mysub/clash?token=wrong'),
      env,
    );

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'UNAUTHORIZED' });
    expect(getSubscription).not.toHaveBeenCalled();
  });
});

describe('traffic push routing', () => {
  function createPushEnv(url = '') {
    const pushTraffic = vi.fn(async () => ({ status: 'created' as const, collectedAt: 100 }));
    return {
      env: {
        TOKEN: 'test-token',
        PUSH_TOKEN: 'test-push-token',
        PROVIDERS: JSON.stringify({
          bwh: {
            type: 'quanx',
            url,
            body: 'shadowsocks=example.com:443, method=aes-128-gcm, password=test, tag=bwh',
          },
        }),
        SUBSCRIPTIONS: { getByName: vi.fn(() => ({ pushTraffic })) },
      } as unknown as Env,
      pushTraffic,
    };
  }

  function request(token = 'test-push-token'): Parameters<typeof worker.fetch>[0] {
    return new Request('https://worker.example/internal/providers/bwh/traffic', {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        schemaVersion: 1,
        collectedAt: 100,
        subscription: { upload: 0, download: 10, total: 100, resetAt: 200 },
        monitor: { status: 'Running' },
      }),
    }) as Parameters<typeof worker.fetch>[0];
  }

  it('accepts authenticated reports only for providers with an empty URL', async () => {
    const { env, pushTraffic } = createPushEnv();
    const response = await worker.fetch(request(), env);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ provider: 'bwh', collectedAt: 100, updated: true });
    expect(pushTraffic).toHaveBeenCalledWith(
      expect.objectContaining({ upload: 0, download: 10, total: 100, resetAt: 200 }),
    );
  });

  it('rejects invalid tokens and pull providers', async () => {
    expect((await worker.fetch(request('wrong'), createPushEnv().env)).status).toBe(401);
    const pull = createPushEnv('https://upstream.example/sub');
    const response = await worker.fetch(request(), pull.env);
    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ error: 'PROVIDER_NOT_PUSH_ENABLED' });
    expect(pull.pushTraffic).not.toHaveBeenCalled();
  });

  it('validates content type and payload', async () => {
    const { env } = createPushEnv();
    const invalidType = request();
    invalidType.headers.set('content-type', 'text/plain');
    expect((await worker.fetch(invalidType, env)).status).toBe(415);
    const invalidPayload = request();
    invalidPayload.headers.set('content-type', 'application/json');
    const malformed = new Request(invalidPayload.url, {
      method: 'POST',
      headers: invalidPayload.headers,
      body: JSON.stringify({ schemaVersion: 1, collectedAt: -1, subscription: {} }),
    }) as Parameters<typeof worker.fetch>[0];
    expect((await worker.fetch(malformed, env)).status).toBe(400);
  });
});
