import { AppError, inputTypes, record, type InputType, type Provider } from './model';

const MAX_PROVIDER_BODY_BYTES = 1024 * 1024;

export function upstreamUrl(value: unknown): URL {
  if (typeof value !== 'string') throw new Error('Invalid URL');
  const url = new URL(value);
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (
    url.protocol !== 'https:' ||
    url.username ||
    url.password ||
    url.hash ||
    !host.includes('.') ||
    host.endsWith('.local') ||
    host.endsWith('.localhost') ||
    host.endsWith('.internal') ||
    host.includes(':') ||
    /^[\d.]+$/.test(host)
  ) {
    throw new Error('Expected public HTTPS hostname');
  }
  return url;
}

/** Validate and normalize one named provider from a JSON or object binding. */
export function getProvider(raw: unknown, name: string): Provider {
  try {
    const providers = record(typeof raw === 'string' ? JSON.parse(raw) : raw);
    if (!Object.hasOwn(providers, name)) throw new AppError(404, 'PROVIDER_NOT_FOUND');
    const p = record(providers[name]);
    const type = p.type ?? 'auto';
    if (!inputTypes.includes(type as InputType)) throw new Error('Invalid input type');
    let body: string | undefined;
    if (p.body !== undefined) {
      if (type !== 'quanx' || typeof p.body !== 'string' || !p.body.trim())
        throw new Error('Invalid static subscription body');
      if (new TextEncoder().encode(p.body).byteLength > MAX_PROVIDER_BODY_BYTES)
        throw new Error('Static subscription body is too large');
      body = p.body;
    }
    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(p.headers === undefined ? {} : record(p.headers))) {
      if (
        typeof value !== 'string' ||
        /[\r\n]/.test(value) ||
        !/^[!#$%&'*+.^_`|~\w-]+$/.test(key) ||
        /^(host|content-length|connection|transfer-encoding)$/i.test(key)
      )
        throw new Error('Invalid header');
      headers[key.toLowerCase()] = value;
    }
    const number = (value: unknown, fallback: number, max: number): number => {
      const v = value ?? fallback;
      if (typeof v !== 'number' || !Number.isInteger(v) || v < 1 || v > max)
        throw new Error('Invalid interval');
      return v;
    };
    const url = p.url === '' ? '' : upstreamUrl(p.url).href;
    if (!url && body === undefined) throw new Error('Push provider requires a static body');
    return {
      name,
      type: type as InputType,
      url,
      body,
      headers: Object.fromEntries(Object.entries(headers).sort(([a], [b]) => a.localeCompare(b))),
      // Keep accepting the original option so existing deployments do not break.
      cacheTtlSeconds: number(p.cacheTtlSeconds ?? p.minRefreshIntervalSeconds, 300, 604800),
      timeoutSeconds: number(p.timeoutSeconds, 10, 20),
    };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(500, 'INVALID_PROVIDER_CONFIG');
  }
}

/** Produce stable identities without exposing provider configuration or tokens. */
export async function digest(value: string): Promise<string> {
  return Array.from(
    new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value))),
    (b) => b.toString(16).padStart(2, '0'),
  ).join('');
}
