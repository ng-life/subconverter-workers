import { DurableObject } from 'cloudflare:workers';
import { AppError, targets, type Output, type Provider, type Target } from './model';
import { parseSubscription } from './parsers';
import { serialize } from './serializers';
import { fetchSubscription } from './upstream';

type StoredOutput = Output | { error: string; status: number };
type StateRow = { attempt: number; fetched: number; userinfo: string | null; error: string | null };

export class SubscriptionCache extends DurableObject<Env> {
  private inFlight?: Promise<void>;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS metadata (id INTEGER PRIMARY KEY CHECK(id=1), attempt INTEGER NOT NULL, fetched INTEGER NOT NULL, userinfo TEXT, error TEXT)');
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS outputs (target TEXT PRIMARY KEY, value TEXT NOT NULL)');
    ctx.storage.sql.exec('INSERT OR IGNORE INTO metadata VALUES (1, 0, 0, NULL, NULL)');
  }

  private state(): StateRow {
    return this.ctx.storage.sql.exec<StateRow>('SELECT attempt, fetched, userinfo, error FROM metadata WHERE id=1').one();
  }

  async getSubscription(provider: Provider, target: Target): Promise<Response> {
    const before = this.state();
    let cache = 'HIT';
    if (this.inFlight) {
      // A previous successful generation can be served while a refresh is running.
      if (!before.fetched) await this.inFlight;
      cache = before.fetched ? 'STALE' : 'HIT';
    } else if (!before.attempt || Date.now() >= before.attempt + provider.minRefreshIntervalSeconds * 1000) {
      cache = before.fetched ? 'REFRESH' : 'MISS';
      // Set the shared promise before the first suspension. Persist the attempt before fetch.
      this.inFlight = this.refresh(provider);
      try { await this.inFlight; } finally { this.inFlight = undefined; }
    }
    const state = this.state();
    const retryAfter = Math.max(0, Math.ceil((state.attempt + provider.minRefreshIntervalSeconds * 1000 - Date.now()) / 1000));
    if (!state.fetched) {
      return Response.json({ error: cache === 'MISS' ? (state.error || 'UPSTREAM_FETCH_FAILED') : 'CACHE_NOT_READY' }, {
        status: cache === 'MISS' ? 502 : 503, headers: { 'retry-after': String(Math.max(1, retryAfter)), 'cache-control': 'no-store' },
      });
    }
    if (state.error) cache = 'STALE';
    const row = this.ctx.storage.sql.exec<{ value: string }>('SELECT value FROM outputs WHERE target=?', target).one();
    const output = JSON.parse(row.value) as StoredOutput;
    const headers = new Headers({
      'cache-control': 'no-store', 'x-subscription-cache': cache,
      'x-subscription-fetched-at': new Date(state.fetched).toISOString(),
      'x-subscription-cache-age': String(Math.max(0, Math.floor((Date.now() - state.fetched) / 1000))),
      'x-subscription-refresh-after': String(retryAfter),
    });
    if ('error' in output) return Response.json({ error: output.error }, { status: output.status, headers });
    headers.set('content-type', output.contentType);
    headers.set('x-subscription-node-count', String(output.count));
    headers.set('x-subscription-skipped', String(output.skipped));
    if (state.userinfo !== null) headers.set('subscription-userinfo', state.userinfo);
    return new Response(output.body, { headers });
  }

  private async refresh(provider: Provider): Promise<void> {
    this.ctx.storage.sql.exec('UPDATE metadata SET attempt=? WHERE id=1', Date.now());
    // SQL is synchronous in memory; sync ensures the attempt survives an eviction before I/O.
    await this.ctx.storage.sync();
    try {
      const upstream = await fetchSubscription(provider);
      const parsed = parseSubscription(upstream.body, provider.type);
      const outputs = new Map<Target, StoredOutput>();
      let successes = 0;
      for (const target of targets) {
        try { outputs.set(target, serialize(parsed, target)); successes++; }
        catch (e) {
          if (!(e instanceof AppError) || e.status !== 422) throw e;
          outputs.set(target, { error: e.code, status: e.status });
        }
      }
      if (!successes) throw new AppError(502, 'NO_COMPATIBLE_NODES');
      this.ctx.storage.transactionSync(() => {
        for (const [target, output] of outputs) this.ctx.storage.sql.exec('INSERT OR REPLACE INTO outputs VALUES (?, ?)', target, JSON.stringify(output));
        this.ctx.storage.sql.exec('UPDATE metadata SET fetched=?, userinfo=?, error=NULL WHERE id=1', Date.now(), upstream.userinfo);
      });
    } catch (e) {
      const code = e instanceof AppError ? e.code : 'SUBSCRIPTION_REFRESH_FAILED';
      this.ctx.storage.sql.exec('UPDATE metadata SET error=? WHERE id=1', code);
    }
  }
}
