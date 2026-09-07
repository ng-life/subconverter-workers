import { timingSafeEqual } from 'node:crypto';
import { getProvider, digest } from './config';
import { AppError, targets, type Target } from './model';
export { SubscriptionCache } from './cache';

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (request.method !== 'GET') return Response.json({ error: 'METHOD_NOT_ALLOWED' }, { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } });
      const url = new URL(request.url);
      const target = url.pathname.slice(1) as Target;
      if (!targets.includes(target)) throw new AppError(404, 'FORMAT_NOT_FOUND');
      const runtime = env as Env & { TOKEN?: unknown; PROVIDERS?: unknown };
      if (typeof runtime.TOKEN !== 'string' || !runtime.TOKEN) throw new AppError(500, 'TOKEN_NOT_CONFIGURED');
      const supplied = url.searchParams.getAll('token');
      if (supplied.length !== 1 || supplied[0].length > 4096) throw new AppError(401, 'UNAUTHORIZED');
      // Hash both inputs to equal length before constant-time comparison.
      const [expected, actual] = await Promise.all([digest(runtime.TOKEN), digest(supplied[0])]);
      if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(actual))) throw new AppError(401, 'UNAUTHORIZED');
      const names = url.searchParams.getAll('provider');
      if (names.length !== 1 || !/^[a-zA-Z0-9_-]{1,64}$/.test(names[0])) throw new AppError(400, 'INVALID_PROVIDER');
      const provider = getProvider(runtime.PROVIDERS, names[0]);
      // Changing a provider configuration starts a new cache generation; token rotation does not.
      const identity = await digest(JSON.stringify({ schema: 1, name: names[0], provider }));
      const response = await env.SUBSCRIPTIONS.getByName(identity).getSubscription(provider, target);
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    } catch (e) {
      const error = e instanceof AppError ? e : new AppError(500, 'INTERNAL_ERROR');
      return Response.json({ error: error.code }, { status: error.status, headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
    }
  },
} satisfies ExportedHandler<Env>;
