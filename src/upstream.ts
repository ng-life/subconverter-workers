import { upstreamUrl } from './config';
import { AppError, record, type Provider } from './model';

export const MAX_UPSTREAM_BYTES = 1024 * 1024;
const MAX_WARNING_BODY_BYTES = 4096;

interface UpstreamResult {
  body: string;
  userinfo: string | null;
  upstreamBytes: number;
  /** Safe error metadata when optional service information could not be decoded. */
  metadataError: { code: string; detail: string } | null;
}

interface UpstreamRequest {
  url: URL;
  init: RequestInit;
  /** The request body contains credentials and must never be sent to a redirect target. */
  hasSensitiveBody: boolean;
}

function nonNegativeNumber(value: unknown): number {
  const number =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim() !== ''
        ? Number(value)
        : Number.NaN;
  if (!Number.isFinite(number) || number < 0) throw new AppError(502, 'INVALID_SERVICE_INFO');
  return number;
}

/** Convert KiwiVM billing counters to the subscription metadata understood by clients. */
export function bandwagonUserinfo(body: string): string {
  try {
    const service = record(JSON.parse(body));
    if (service.error !== 0 && service.error !== '0')
      throw new AppError(502, 'UPSTREAM_SERVICE_ERROR');

    const multiplier = nonNegativeNumber(service.monthly_data_multiplier);
    if (multiplier <= 0) throw new AppError(502, 'INVALID_SERVICE_INFO');
    const download = Math.floor(nonNegativeNumber(service.data_counter) * multiplier);
    const total = Math.floor(nonNegativeNumber(service.plan_monthly_data) * multiplier);
    const expire = nonNegativeNumber(service.data_next_reset);
    if (
      total <= 0 ||
      !Number.isSafeInteger(download) ||
      !Number.isSafeInteger(total) ||
      !Number.isSafeInteger(expire) ||
      expire <= 0
    )
      throw new AppError(502, 'INVALID_SERVICE_INFO');

    return `upload=0; download=${download}; total=${total}; expire=${expire}`;
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw new AppError(502, 'INVALID_SERVICE_INFO');
  }
}

/** Encode the complete bounded error body so it is legal inside a response header. */
function upstreamWarning(code: string, body: string, status: number): string {
  const bytes = new TextEncoder().encode(body).byteLength;
  if (!bytes) return `${code}; status=${status}`;
  if (bytes > MAX_WARNING_BODY_BYTES)
    return `${code}; status=${status}; upstream_body_omitted=too_large; upstream_body_bytes=${bytes}`;
  return `${code}; upstream_body=${encodeURIComponent(body)}`;
}

async function readBody(response: Response): Promise<{ body: string; bytes: number }> {
  if (Number(response.headers.get('content-length')) > MAX_UPSTREAM_BYTES)
    throw new AppError(502, 'UPSTREAM_TOO_LARGE');
  if (!response.body)
    throw new AppError(
      502,
      'EMPTY_SUBSCRIPTION',
      undefined,
      `EMPTY_SUBSCRIPTION; status=${response.status}`,
    );
  const reader = response.body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
  let bytes = 0;
  let body = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_UPSTREAM_BYTES) throw new AppError(502, 'UPSTREAM_TOO_LARGE');
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally {
    await reader.cancel();
    reader.releaseLock();
  }
  return { body, bytes };
}

/**
 * KiwiVM may challenge GET requests from shared Cloudflare egress addresses.
 * Its service-info endpoint also accepts form POSTs, which return the regular
 * JSON payload and keep the API key out of the requested URL.
 */
function upstreamRequest(provider: Provider, sourceUrl: URL): UpstreamRequest {
  const url = new URL(sourceUrl);
  const isKiwiVmServiceInfo =
    provider.body !== undefined &&
    url.hostname === 'api.64clouds.com' &&
    url.pathname === '/v1/getServiceInfo';
  const headers = { 'user-agent': 'subconverter-workers/1.0', ...provider.headers };

  if (!isKiwiVmServiceInfo)
    return {
      url,
      init: { headers, redirect: 'manual' },
      hasSensitiveBody: false,
    };

  const form = new URLSearchParams(url.searchParams);
  url.search = '';
  return {
    url,
    init: {
      method: 'POST',
      headers: {
        accept: 'application/json',
        'content-type': 'application/x-www-form-urlencoded',
        ...headers,
      },
      body: form.toString(),
      redirect: 'manual',
    },
    hasSensitiveBody: true,
  };
}

/**
 * Fetch a bounded UTF-8 subscription from a public HTTPS origin.
 * Redirects are followed manually so authenticated headers never cross origins.
 */
export async function fetchSubscription(provider: Provider): Promise<UpstreamResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutSeconds * 1000);
  let response: Response | undefined;
  try {
    let url = upstreamUrl(provider.url);
    for (let redirects = 0; ; redirects++) {
      const request = upstreamRequest(provider, url);
      response = await fetch(request.url, { ...request.init, signal: controller.signal });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 3) throw new AppError(502, 'UPSTREAM_REDIRECT_ERROR');
      const next = upstreamUrl(new URL(location, url).href);
      // Never replay KiwiVM form credentials to a redirect target, even on the
      // same origin. The documented endpoint does not require redirects.
      if (
        request.hasSensitiveBody ||
        (next.origin !== url.origin && Object.keys(provider.headers).length)
      )
        throw new AppError(502, 'UPSTREAM_REDIRECT_ERROR');
      url = next;
    }
    if (!response.body && !response.ok)
      throw new AppError(
        502,
        'UPSTREAM_HTTP_ERROR',
        undefined,
        `UPSTREAM_HTTP_ERROR; status=${response.status}`,
      );
    const upstream = await readBody(response);
    if (!response.ok)
      throw new AppError(
        502,
        'UPSTREAM_HTTP_ERROR',
        undefined,
        upstreamWarning('UPSTREAM_HTTP_ERROR', upstream.body, response.status),
      );
    if (provider.body === undefined && !upstream.body)
      throw new AppError(502, 'EMPTY_SUBSCRIPTION');
    return provider.body === undefined
      ? {
          body: upstream.body,
          userinfo: response.headers.get('subscription-userinfo'),
          upstreamBytes: upstream.bytes,
          metadataError: null,
        }
      : staticSubscription(provider.body, upstream, response.status);
  } catch (e) {
    const error =
      e instanceof AppError
        ? e
        : new AppError(
            502,
            controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAILED',
          );
    // Static node availability does not depend on the optional metadata origin.
    if (provider.body !== undefined)
      return {
        body: provider.body,
        userinfo: null,
        upstreamBytes: 0,
        metadataError: { code: error.code, detail: error.detail ?? error.code },
      };
    throw error;
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}

/**
 * Service metadata is optional for a static provider. A temporary KiwiVM
 * business error must not make otherwise valid proxy nodes unavailable.
 */
function staticSubscription(
  body: string,
  upstream: { body: string; bytes: number },
  status: number,
): UpstreamResult {
  try {
    return {
      body,
      userinfo: bandwagonUserinfo(upstream.body),
      upstreamBytes: upstream.bytes,
      metadataError: null,
    };
  } catch (error) {
    return {
      body,
      userinfo: null,
      upstreamBytes: upstream.bytes,
      metadataError:
        error instanceof AppError
          ? {
              code: error.code,
              detail: upstreamWarning(error.code, upstream.body, status),
            }
          : {
              code: 'INVALID_SERVICE_INFO',
              detail: upstreamWarning('INVALID_SERVICE_INFO', upstream.body, status),
            },
    };
  }
}
