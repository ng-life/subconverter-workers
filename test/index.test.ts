import { describe, expect, it, vi } from 'vitest';
import worker, { parseRoute } from '../src/index';
import type { Provider, Target } from '../src/model';

function createEnv() {
  const getSubscription = vi.fn(
    async (_provider: Provider, target: Target) => new Response(target),
  );
  const getByName = vi.fn(() => ({ getSubscription }));

  return {
    env: {
      TOKEN: 'test-token',
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
