import { DurableObject, tracing } from 'cloudflare:workers';
import {
  AppError,
  type Output,
  type Provider,
  type PushTrafficResult,
  type SubscriptionModel,
  type SubscriptionTraffic,
  type Target,
} from './model';
import { parseSubscription } from './parsers';
import { serialize } from './serializers';
import { fetchSubscription } from './upstream';
import { errorMetadata, logEvent } from './observability';

type CacheStatus = 'HIT' | 'MISS' | 'REFRESH' | 'STALE';

interface CacheRow {
  attemptedAt: number;
  fetchedAt: number;
  userinfo: string | null;
  error: string | null;
  model: string | null;
}

type TrafficRow = Record<string, SqlStorageValue> & {
  collected_at: number;
  received_at: number;
  upload: number | null;
  download: number | null;
  total: number | null;
  reset_at: number | null;
  expire_at: number | null;
  payload_hash: string;
};

export class SubscriptionCache extends DurableObject<Env> {
  private inFlight?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);

    // Use a new table so existing per-format cache data cannot be mistaken for
    // the provider-independent model. Existing objects refresh once on demand.
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS subscription_cache (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        attempted_at INTEGER NOT NULL,
        fetched_at INTEGER NOT NULL,
        userinfo TEXT,
        error TEXT,
        model TEXT
      )
    `);
    ctx.storage.sql.exec(`
      INSERT OR IGNORE INTO subscription_cache
        (id, attempted_at, fetched_at, userinfo, error, model)
      VALUES (1, 0, 0, NULL, NULL, NULL)
    `);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS traffic_metadata (
        id INTEGER PRIMARY KEY CHECK(id = 1),
        collected_at INTEGER NOT NULL,
        received_at INTEGER NOT NULL,
        upload INTEGER,
        download INTEGER,
        total INTEGER,
        reset_at INTEGER,
        expire_at INTEGER,
        payload_hash TEXT NOT NULL
      )
    `);
  }

  async pushTraffic(traffic: SubscriptionTraffic): Promise<PushTrafficResult> {
    const current = this.ctx.storage.sql
      .exec<TrafficRow>(
        'SELECT collected_at, received_at, upload, download, total, reset_at, expire_at, payload_hash FROM traffic_metadata WHERE id = 1',
      )
      .toArray()[0];
    if (current) {
      if (traffic.collectedAt < current.collected_at)
        return { status: 'stale', collectedAt: current.collected_at };
      if (traffic.collectedAt === current.collected_at)
        return {
          status: traffic.payloadHash === current.payload_hash ? 'unchanged' : 'conflict',
          collectedAt: current.collected_at,
        };
    }
    this.ctx.storage.sql.exec(
      `INSERT OR REPLACE INTO traffic_metadata
       (id, collected_at, received_at, upload, download, total, reset_at, expire_at, payload_hash)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)`,
      traffic.collectedAt,
      Math.floor(Date.now() / 1000),
      traffic.upload ?? null,
      traffic.download ?? null,
      traffic.total ?? null,
      traffic.resetAt ?? null,
      traffic.expireAt ?? null,
      traffic.payloadHash,
    );
    return { status: 'created', collectedAt: traffic.collectedAt };
  }

  async getSubscription(
    provider: Provider,
    target: Target,
    forceRefresh = false,
  ): Promise<Response> {
    return tracing.enterSpan('subscription.cache', async (span) => {
      span.setAttributes({
        'subscription.provider': provider.name,
        'subscription.format': target,
        'subscription.cache.force_refresh': forceRefresh,
      });
      const response = await this.resolveSubscription(provider, target, forceRefresh);
      span.setAttributes({
        'http.response.status_code': response.status,
        'subscription.cache.status': response.headers.get('x-subscription-cache') ?? 'NONE',
      });
      return response;
    });
  }

  /** Resolve freshness first, then serialize exactly one requested output format. */
  private async resolveSubscription(
    provider: Provider,
    target: Target,
    forceRefresh: boolean,
  ): Promise<Response> {
    const before = this.state();
    const now = Date.now();
    const ttlMilliseconds = provider.cacheTtlSeconds * 1000;
    const hasModel = before.model !== null;
    const expired = forceRefresh || !hasModel || now >= before.fetchedAt + ttlMilliseconds;
    // A static body can recover an object left empty by an earlier metadata
    // failure immediately after deployment; it does not need to wait out TTL.
    const retryAllowed =
      (provider.body !== undefined && !hasModel) ||
      !before.attemptedAt ||
      now >= before.attemptedAt + ttlMilliseconds;
    let cacheStatus: CacheStatus = 'HIT';

    if (expired) {
      cacheStatus = hasModel ? 'REFRESH' : 'MISS';

      if (this.inFlight) {
        // Expired concurrent requests wait for one refresh before serialization.
        await this.inFlight;
      } else if (forceRefresh || retryAllowed) {
        this.inFlight = this.refresh(provider);
        try {
          await this.inFlight;
        } finally {
          this.inFlight = undefined;
        }
      }
    }

    const state = this.state();
    if (!state.model) return this.cacheUnavailable(state, provider.cacheTtlSeconds);

    // A failed refresh may use the last valid model. It is marked stale and is
    // retried after the configured cache interval.
    if (state.error) cacheStatus = 'STALE';

    let model: SubscriptionModel;
    try {
      model = JSON.parse(state.model) as SubscriptionModel;
      if (model.schemaVersion !== 1 || !Array.isArray(model.nodes)) throw new Error();
    } catch {
      logEvent('error', 'subscription.cache.invalid_model', { provider: provider.name });
      return Response.json(
        { error: 'INVALID_CACHE_MODEL' },
        { status: 500, headers: { 'cache-control': 'no-store' } },
      );
    }

    // Only the normalized intermediate model is cached. The requested format
    // is always generated here, keeping the cache independent of serializers.
    let output: Output;
    try {
      output = tracing.enterSpan('subscription.serialize', (span) => {
        span.setAttributes({
          'subscription.provider': provider.name,
          'subscription.format': target,
          'subscription.input_node_count': model.nodes.length,
        });
        const value = serialize(model, target);
        span.setAttributes({
          'subscription.output_node_count': value.count,
          'subscription.skipped_node_count': value.skipped,
        });
        return value;
      });
    } catch (error) {
      const conversionError =
        error instanceof AppError ? error : new AppError(500, 'OUTPUT_CONVERSION_FAILED');
      logEvent(conversionError.status >= 500 ? 'error' : 'warn', 'subscription.serialize.failed', {
        provider: provider.name,
        format: target,
        status: conversionError.status,
        errorCode: conversionError.code,
      });
      return Response.json(
        { error: conversionError.code },
        { status: conversionError.status, headers: { 'cache-control': 'no-store' } },
      );
    }
    const nextRefreshAt = state.error
      ? state.attemptedAt + ttlMilliseconds
      : state.fetchedAt + ttlMilliseconds;
    const headers = new Headers({
      'cache-control': 'no-store',
      'content-type': output.contentType,
      'x-subscription-cache': cacheStatus,
      'x-subscription-cache-age': String(Math.max(0, Math.floor((now - state.fetchedAt) / 1000))),
      'x-subscription-fetched-at': new Date(state.fetchedAt).toISOString(),
      'x-subscription-node-count': String(output.count),
      'x-subscription-refresh-after': String(Math.max(0, Math.ceil((nextRefreshAt - now) / 1000))),
      'x-subscription-skipped': String(output.skipped),
    });
    const traffic = provider.url === '' ? this.traffic() : undefined;
    if (traffic) {
      const fields: Array<[string, number | null]> = [
        ['upload', traffic.upload],
        ['download', traffic.download],
        ['total', traffic.total],
        ['expire', traffic.expire_at ?? traffic.reset_at],
      ];
      const userinfo = fields
        .filter((entry): entry is [string, number] => entry[1] !== null)
        .map(([key, value]) => `${key}=${value}`)
        .join('; ');
      if (userinfo) headers.set('subscription-userinfo', userinfo);
      headers.set(
        'x-subscription-traffic-updated-at',
        new Date(traffic.collected_at * 1000).toISOString(),
      );
      headers.set(
        'x-subscription-traffic-age',
        String(Math.max(0, Math.floor(Date.now() / 1000) - traffic.collected_at)),
      );
    } else if (state.userinfo !== null) headers.set('subscription-userinfo', state.userinfo);
    if (state.error !== null) headers.set('x-subscription-warning', state.error);

    return new Response(output.body, { headers });
  }

  private traffic(): TrafficRow | undefined {
    return this.ctx.storage.sql
      .exec<TrafficRow>(
        'SELECT collected_at, received_at, upload, download, total, reset_at, expire_at, payload_hash FROM traffic_metadata WHERE id = 1',
      )
      .toArray()[0];
  }

  private state(): CacheRow {
    const row = this.ctx.storage.sql
      .exec<{
        attempted_at: number;
        fetched_at: number;
        userinfo: string | null;
        error: string | null;
        model: string | null;
      }>(
        'SELECT attempted_at, fetched_at, userinfo, error, model FROM subscription_cache WHERE id = 1',
      )
      .one();

    return {
      attemptedAt: row.attempted_at,
      fetchedAt: row.fetched_at,
      userinfo: row.userinfo,
      error: row.error,
      model: row.model,
    };
  }

  private cacheUnavailable(state: CacheRow, cacheTtlSeconds: number): Response {
    const retryAfter = Math.max(
      1,
      Math.ceil((state.attemptedAt + cacheTtlSeconds * 1000 - Date.now()) / 1000),
    );

    return Response.json(
      { error: state.error || 'CACHE_NOT_READY' },
      {
        status: state.error ? 502 : 503,
        headers: { 'cache-control': 'no-store', 'retry-after': String(retryAfter) },
      },
    );
  }

  private async refresh(provider: Provider): Promise<void> {
    return tracing.enterSpan('subscription.cache.refresh', async (span) => {
      const startedAt = Date.now();
      span.setAttributes({
        'subscription.provider': provider.name,
        'subscription.input_format': provider.type,
        'server.address': provider.url ? new URL(provider.url).hostname : 'static',
      });
      logEvent('info', 'subscription.cache.refresh.started', {
        provider: provider.name,
        inputFormat: provider.type,
      });

      this.ctx.storage.sql.exec(
        'UPDATE subscription_cache SET attempted_at = ? WHERE id = 1',
        Date.now(),
      );
      // SQL executes in memory first; sync makes the retry boundary durable before I/O.
      await this.ctx.storage.sync();

      try {
        // The nested spans separate network time from parsing and storage time.
        // Platform-created fetch and SQL spans become children automatically.
        const upstream = await tracing.enterSpan(
          'subscription.upstream.fetch',
          async (fetchSpan) => {
            fetchSpan.setAttributes({
              'subscription.provider': provider.name,
              'server.address': provider.url ? new URL(provider.url).hostname : 'static',
            });
            const result = provider.url
              ? await fetchSubscription(provider)
              : {
                  body: provider.body!,
                  userinfo: null,
                  upstreamBytes: new TextEncoder().encode(provider.body!).byteLength,
                  metadataError: null,
                };
            fetchSpan.setAttribute('subscription.upstream_bytes', result.upstreamBytes);
            fetchSpan.setAttribute('subscription.static_body', provider.body !== undefined);
            if (result.metadataError) {
              fetchSpan.setAttribute('subscription.metadata.error_code', result.metadataError.code);
            }
            return result;
          },
        );
        const model = tracing.enterSpan('subscription.parse', (parseSpan) => {
          parseSpan.setAttributes({
            'subscription.provider': provider.name,
            'subscription.input_format': provider.type,
          });
          const value = parseSubscription(upstream.body, provider.type);
          parseSpan.setAttributes({
            'subscription.node_count': value.nodes.length,
            'subscription.skipped_node_count': value.skipped,
          });
          return value;
        });

        this.ctx.storage.sql.exec(
          `UPDATE subscription_cache
           SET fetched_at = ?, userinfo = ?, error = ?, model = ?
           WHERE id = 1`,
          Date.now(),
          upstream.userinfo,
          upstream.metadataError?.detail ?? null,
          JSON.stringify(model),
        );
        span.setAttributes({
          'subscription.node_count': model.nodes.length,
          'subscription.skipped_node_count': model.skipped,
        });
        logEvent('info', 'subscription.cache.refresh.completed', {
          provider: provider.name,
          inputFormat: provider.type,
          nodeCount: model.nodes.length,
          skippedCount: model.skipped,
          durationMs: Date.now() - startedAt,
        });
        if (upstream.metadataError)
          logEvent('warn', 'subscription.metadata.failed', {
            provider: provider.name,
            errorCode: upstream.metadataError.code,
          });
      } catch (error) {
        const code = error instanceof AppError ? error.code : 'SUBSCRIPTION_REFRESH_FAILED';
        const metadata = errorMetadata(error);
        span.setAttributes({
          'subscription.error.code': code,
          'subscription.error.name': metadata.errorName,
        });
        this.ctx.storage.sql.exec('UPDATE subscription_cache SET error = ? WHERE id = 1', code);
        logEvent('error', 'subscription.cache.refresh.failed', {
          provider: provider.name,
          inputFormat: provider.type,
          errorCode: code,
          errorName: metadata.errorName,
          durationMs: Date.now() - startedAt,
        });
      }
    });
  }
}
