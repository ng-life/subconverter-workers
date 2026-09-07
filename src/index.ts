import { timingSafeEqual } from 'node:crypto';
import { getProvider, digest } from './config';
import { AppError, targets, type Target } from './model';
export { SubscriptionCache } from './cache';

const PROVIDER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;

/** Parse the public /providerName/format route without accepting extra segments. */
export function parseRoute(pathname: string): { providerName: string; target: Target } {
  const match = pathname.match(/^\/([^/]+)\/([^/]+)$/);
  if (!match || !PROVIDER_NAME.test(match[1])) throw new AppError(404, 'ROUTE_NOT_FOUND');

  const target = match[2] as Target;
  if (!targets.includes(target)) throw new AppError(404, 'FORMAT_NOT_FOUND');

  return { providerName: match[1], target };
}

export default {
  async fetch(request, env): Promise<Response> {
    try {
      if (request.method !== 'GET')
        return Response.json(
          { error: 'METHOD_NOT_ALLOWED' },
          { status: 405, headers: { allow: 'GET', 'cache-control': 'no-store' } },
        );
      const url = new URL(request.url);
      const { providerName, target } = parseRoute(url.pathname);
      const runtime = env as Env & { TOKEN?: unknown; PROVIDERS?: unknown };
      if (typeof runtime.TOKEN !== 'string' || !runtime.TOKEN)
        throw new AppError(500, 'TOKEN_NOT_CONFIGURED');
      const supplied = url.searchParams.getAll('token');
      if (supplied.length !== 1 || supplied[0].length > 4096)
        throw new AppError(401, 'UNAUTHORIZED');
      // Hash both inputs to equal length before constant-time comparison.
      const [expected, actual] = await Promise.all([digest(runtime.TOKEN), digest(supplied[0])]);
      if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(actual)))
        throw new AppError(401, 'UNAUTHORIZED');
      const provider = getProvider(runtime.PROVIDERS, providerName);
      // Changing a provider configuration starts a new cache generation; token rotation does not.
      const identity = await digest(JSON.stringify({ schema: 2, name: providerName, provider }));
      const response = await env.SUBSCRIPTIONS.getByName(identity).getSubscription(
        provider,
        target,
      );
      response.headers.set('x-content-type-options', 'nosniff');
      return response;
    } catch (e) {
      const error = e instanceof AppError ? e : new AppError(500, 'INTERNAL_ERROR');
      return Response.json(
        { error: error.code },
        {
          status: error.status,
          headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' },
        },
      );
    }
  },
} satisfies ExportedHandler<Env>;
