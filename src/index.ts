import { tracing } from 'cloudflare:workers';
import { timingSafeEqual } from 'node:crypto';
import { digest, getProvider } from './config';
import {
  AppError,
  record,
  targets,
  type Provider,
  type SubscriptionTraffic,
  type Target,
} from './model';
import { errorMetadata, logEvent } from './observability';
export { SubscriptionCache } from './cache';

const PROVIDER_NAME = /^[a-zA-Z0-9_-]{1,64}$/;
const PUSH_ROUTE = /^\/internal\/providers\/([^/]+)\/traffic$/;
const MAX_PUSH_BYTES = 16 * 1024;

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

async function authenticateBearer(request: Request, configuredToken: unknown): Promise<void> {
  if (typeof configuredToken !== 'string' || !configuredToken)
    throw new AppError(500, 'PUSH_TOKEN_NOT_CONFIGURED');
  const authorization = request.headers.get('authorization') ?? '';
  const match = authorization.match(/^Bearer ([^\s]{1,4096})$/);
  if (!match) throw new AppError(401, 'UNAUTHORIZED');
  const [expected, actual] = await Promise.all([digest(configuredToken), digest(match[1])]);
  if (!timingSafeEqual(new TextEncoder().encode(expected), new TextEncoder().encode(actual)))
    throw new AppError(401, 'UNAUTHORIZED');
}

async function readPushPayload(request: Request): Promise<SubscriptionTraffic> {
  const contentType = request.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase();
  if (contentType !== 'application/json') throw new AppError(415, 'UNSUPPORTED_MEDIA_TYPE');
  const declaredLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_PUSH_BYTES)
    throw new AppError(413, 'PAYLOAD_TOO_LARGE');
  if (!request.body) throw new AppError(400, 'INVALID_TRAFFIC_PAYLOAD');
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_PUSH_BYTES) throw new AppError(413, 'PAYLOAD_TOO_LARGE');
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    const root = record(
      JSON.parse(new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes)),
    );
    if (root.schemaVersion !== 1) throw new Error();
    if (root.monitor !== undefined) record(root.monitor);
    if (
      Object.keys(root).some(
        (key) => !['schemaVersion', 'collectedAt', 'subscription', 'monitor'].includes(key),
      )
    )
      throw new Error();
    const collectedAt = safeInteger(root.collectedAt);
    const subscription = record(root.subscription);
    if (
      Object.keys(subscription).some(
        (key) => !['upload', 'download', 'total', 'resetAt', 'expireAt'].includes(key),
      )
    )
      throw new Error();
    const values: Partial<
      Pick<SubscriptionTraffic, 'upload' | 'download' | 'total' | 'resetAt' | 'expireAt'>
    > = {};
    for (const key of ['upload', 'download', 'total', 'resetAt', 'expireAt'] as const) {
      if (subscription[key] !== undefined) values[key] = safeInteger(subscription[key]);
    }
    if (values.upload === undefined && values.download === undefined && values.total === undefined)
      throw new Error();
    const canonical = JSON.stringify({ schemaVersion: 1, collectedAt, ...values });
    const traffic: SubscriptionTraffic = {
      schemaVersion: 1,
      collectedAt,
      ...values,
      payloadHash: await digest(canonical),
    };
    return traffic;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(400, 'INVALID_TRAFFIC_PAYLOAD');
  }
}

function safeInteger(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error();
  return value;
}

async function providerCache(env: Env, providerName: string, provider: Provider) {
  const { name: _providerName, ...providerIdentity } = provider;
  const identity = await digest(
    JSON.stringify({ schema: 2, name: providerName, provider: providerIdentity }),
  );
  return env.SUBSCRIPTIONS.getByName(identity);
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
  if (error.status === 405) headers.allow = error.detail ?? 'GET';

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
        const pushMatch = url.pathname.match(PUSH_ROUTE);
        if (pushMatch) {
          if (!PROVIDER_NAME.test(pushMatch[1])) throw new AppError(404, 'ROUTE_NOT_FOUND');
          if (request.method !== 'POST')
            throw new AppError(405, 'METHOD_NOT_ALLOWED', undefined, 'POST');
          providerName = pushMatch[1];
          const runtime = env as Env & { PUSH_TOKEN?: unknown; PROVIDERS?: unknown };
          await tracing.enterSpan('subscription.push.authenticate', () =>
            authenticateBearer(request, runtime.PUSH_TOKEN),
          );
          const provider = getProvider(runtime.PROVIDERS, providerName);
          if (provider.url !== '') throw new AppError(409, 'PROVIDER_NOT_PUSH_ENABLED');
          const traffic = await readPushPayload(request);
          const result = await (
            await providerCache(env, providerName, provider)
          ).pushTraffic(traffic);
          if (result.status === 'stale') throw new AppError(409, 'STALE_TRAFFIC_REPORT');
          if (result.status === 'conflict') throw new AppError(409, 'TRAFFIC_REPORT_CONFLICT');
          logEvent('info', 'subscription.traffic.received', {
            provider: providerName,
            collectedAt: result.collectedAt,
            updated: result.status === 'created',
          });
          return Response.json(
            {
              provider: providerName,
              collectedAt: result.collectedAt,
              updated: result.status === 'created',
            },
            { headers: { 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } },
          );
        }

        if (request.method !== 'GET')
          throw new AppError(405, 'METHOD_NOT_ALLOWED', undefined, 'GET');

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
        const response = await (
          await providerCache(env, providerName, provider)
        ).getSubscription(provider, target, refresh);
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
