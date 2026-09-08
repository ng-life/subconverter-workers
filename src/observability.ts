export type LogLevel = 'info' | 'warn' | 'error';
export type LogFields = Record<string, boolean | number | string | null | undefined>;

/**
 * Emit one JSON object per line so Workers Observability can index every field.
 * Callers must never pass tokens, provider headers, or complete upstream URLs.
 * Cloudflare already adds timestamps, invocation IDs, Ray IDs, and deployment
 * metadata, so duplicating those platform fields here would only add noise.
 */
export function logEvent(level: LogLevel, event: string, fields: LogFields = {}): void {
  const line = JSON.stringify({ event, ...fields });

  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

/** Return bounded, non-sensitive error metadata suitable for logs and spans. */
export function errorMetadata(error: unknown): { errorCode: string; errorName: string } {
  if (error && typeof error === 'object') {
    const value = error as { code?: unknown; name?: unknown };
    return {
      errorCode: typeof value.code === 'string' ? value.code : 'UNEXPECTED_ERROR',
      errorName: typeof value.name === 'string' ? value.name : 'Error',
    };
  }

  return { errorCode: 'UNEXPECTED_ERROR', errorName: typeof error };
}
