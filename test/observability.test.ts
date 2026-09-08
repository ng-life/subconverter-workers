import { describe, expect, it, vi } from 'vitest';
import { errorMetadata, logEvent } from '../src/observability';

describe('structured observability', () => {
  it('writes queryable JSON at the requested severity', () => {
    const output = vi.spyOn(console, 'warn').mockImplementation(() => {});

    logEvent('warn', 'subscription.test', {
      provider: 'mysub',
      status: 401,
      omitted: undefined,
    });

    expect(output).toHaveBeenCalledOnce();
    expect(JSON.parse(String(output.mock.calls[0][0]))).toEqual({
      event: 'subscription.test',
      provider: 'mysub',
      status: 401,
    });
  });

  it('reduces exceptions to bounded metadata', () => {
    expect(errorMetadata({ code: 'UPSTREAM_TIMEOUT', name: 'AppError', secret: 'hidden' })).toEqual(
      {
        errorCode: 'UPSTREAM_TIMEOUT',
        errorName: 'AppError',
      },
    );
  });
});
