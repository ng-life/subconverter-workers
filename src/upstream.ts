import { upstreamUrl } from './config';
import { AppError, type Provider } from './model';

export const MAX_UPSTREAM_BYTES = 1024 * 1024;

/**
 * Fetch a bounded UTF-8 subscription from a public HTTPS origin.
 * Redirects are followed manually so authenticated headers never cross origins.
 */
export async function fetchSubscription(
  provider: Provider,
): Promise<{ body: string; userinfo: string | null }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), provider.timeoutSeconds * 1000);
  let response: Response | undefined;
  try {
    let url = upstreamUrl(provider.url);
    for (let redirects = 0; ; redirects++) {
      response = await fetch(url, {
        headers: { 'user-agent': 'subconverter-workers/1.0', ...provider.headers },
        redirect: 'manual',
        signal: controller.signal,
      });
      if (![301, 302, 303, 307, 308].includes(response.status)) break;
      await response.body?.cancel();
      const location = response.headers.get('location');
      if (!location || redirects >= 3) throw new AppError(502, 'UPSTREAM_REDIRECT_ERROR');
      const next = upstreamUrl(new URL(location, url).href);
      if (next.origin !== url.origin && Object.keys(provider.headers).length)
        throw new AppError(502, 'UPSTREAM_REDIRECT_ERROR');
      url = next;
    }
    if (!response.ok) throw new AppError(502, 'UPSTREAM_HTTP_ERROR');
    if (Number(response.headers.get('content-length')) > MAX_UPSTREAM_BYTES)
      throw new AppError(502, 'UPSTREAM_TOO_LARGE');
    if (!response.body) throw new AppError(502, 'EMPTY_SUBSCRIPTION');
    const reader = response.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true, ignoreBOM: false });
    let size = 0;
    let body = '';
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_UPSTREAM_BYTES) throw new AppError(502, 'UPSTREAM_TOO_LARGE');
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } finally {
      await reader.cancel();
      reader.releaseLock();
    }
    return { body, userinfo: response.headers.get('subscription-userinfo') };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(
      502,
      controller.signal.aborted ? 'UPSTREAM_TIMEOUT' : 'UPSTREAM_FETCH_FAILED',
    );
  } finally {
    clearTimeout(timer);
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => {});
  }
}
