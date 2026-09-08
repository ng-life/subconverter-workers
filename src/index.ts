import { tracing } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { digest, getProvider } from './config';
import { AppError, targets, type Target } from './model';
import { errorMetadata, logEvent } from './observability';
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

/**
 * Authenticate without logging the supplied token. Hashing both values first
 * gives timingSafeEqual fixed-length inputs even when the token lengths differ.
 */
async function authenticate(url: URL, configuredToken: unknown): Promise<void> {
  if (typeof configuredToken !== 'string' || !configuredToken)
    throw new AppError(500, 'TOKEN_NOT_CONFIGURED');

  const supplied = url.searchParams.getAll('token');
  if (supplied.length !== 1 || supplied[0].length > 4096) throw new AppError(401, 'UNAUTHORIZED');

  const [expected, actual] = await Promise.all([digest(configuredToken), digest(supplied[0])]);
  if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(actual)))
    throw new AppError(401, 'UNAUTHORIZED');
}

/** Parse the optional cache refresh switch without accepting ambiguous values. */
export function forceRefresh(url: URL): boolean {
  const values = url.searchParams.getAll('refresh');
  if (!values.length) return false;
  if (values.length !== 1) throw new AppError(400, 'INVALID_REFRESH_PARAMETER');
  if (['1', 'true'].includes(values[0].toLowerCase())) return true;
  if (['0', 'false'].includes(values[0].toLowerCase())) return false;
  throw new AppError(400, 'INVALID_REFRESH_PARAMETER');
}

function errorResponse(error: AppError): Response {
  const headers: Record<string, string> = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
  };
  if (error.status === 405) headers.allow = 'GET';

  return Response.json({ error: error.code }, { status: error.status, headers });
}

export default {
  async fetch(request, env): Promise<Response> {
    return tracing.enterSpan('subscription.request', async (span) => {
      const startedAt = Date.now();
      const url = new URL(request.url);
      let providerName: string | undefined;
      let target: Target | undefined;

      span.setAttributes({
        'http.request.method': request.method,
        'url.path': url.pathname,
      });

      try {
        if (request.method !== 'GET') throw new AppError(405, 'METHOD_NOT_ALLOWED');

        ({ providerName, target } = parseRoute(url.pathname));
        span.setAttributes({
          'subscription.provider': providerName,
          'subscription.format': target,
        });

        const runtime = env as Env & { TOKEN?: unknown; PROVIDERS?: unknown };
        await tracing.enterSpan('subscription.authenticate', () =>
          authenticate(url, runtime.TOKEN),
        );
        const refresh = forceRefresh(url);
        span.setAttribute('subscription.cache.force_refresh', refresh);

        const provider = getProvider(runtime.PROVIDERS, providerName);
        // Provider configuration is part of the identity so a config change gets
        // a fresh Durable Object without mutating or mixing the previous cache.
        // Exclude the new diagnostic name field to preserve existing cache IDs.
        const { name: _providerName, ...providerIdentity } = provider;
        const identity = await digest(
          JSON.stringify({ schema: 2, name: providerName, provider: providerIdentity }),
        );
        const response = await env.SUBSCRIPTIONS.getByName(identity).getSubscription(
          provider,
          target,
          refresh,
        );
        response.headers.set('x-content-type-options', 'nosniff');

        const cacheStatus = response.headers.get('x-subscription-cache') ?? 'NONE';
        span.setAttributes({
          'http.response.status_code': response.status,
          'subscription.cache.status': cacheStatus,
        });
        logEvent('info', 'subscription.request.completed', {
          provider: providerName,
          format: target,
          status: response.status,
          cacheStatus,
          nodeCount: response.headers.get('x-subscription-node-count'),
          skippedCount: response.headers.get('x-subscription-skipped'),
          forceRefresh: refresh,
          durationMs: Date.now() - startedAt,
        });

        return response;
      } catch (cause) {
        const error = cause instanceof AppError ? cause : new AppError(500, 'INTERNAL_ERROR');
        const metadata = errorMetadata(error);
        span.setAttributes({
          'http.response.status_code': error.status,
          'subscription.error.code': error.code,
          'subscription.error.name': metadata.errorName,
        });

        logEvent(error.status >= 500 ? 'error' : 'warn', 'subscription.request.failed', {
          provider: providerName,
          format: target,
          status: error.status,
          errorCode: error.code,
          errorName: metadata.errorName,
          durationMs: Date.now() - startedAt,
        });
        return errorResponse(error);
      }
    });
  },
} satisfies ExportedHandler<Env>;
