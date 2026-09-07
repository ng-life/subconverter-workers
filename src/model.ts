export const targets = ['clash', 'loon', 'quanx', 'shadowsocks'] as const;
export type Target = (typeof targets)[number];
export const inputTypes = ['auto', 'base64', 'uri', 'clash', 'loon', 'quanx', 'sip008'] as const;
export type InputType = (typeof inputTypes)[number];
export type Dict = Record<string, unknown>;
export interface ProxyNode extends Dict {
  name: string;
  type: string;
  server: string;
  port: number;
}

/**
 * Provider-independent subscription data stored in Durable Object storage.
 * Parsers normalize every supported source format into this model, while
 * serializers convert it to the requested output format at request time.
 */
export interface SubscriptionModel {
  schemaVersion: 1;
  nodes: ProxyNode[];
  skipped: number;
}

export interface Output {
  body: string;
  contentType: string;
  skipped: number;
  count: number;
}

export interface Provider {
  type: InputType;
  url: string;
  headers: Record<string, string>;
  cacheTtlSeconds: number;
  timeoutSeconds: number;
}
export class AppError extends Error {
  constructor(
    public status: number,
    public code: string,
    public retryAfter?: number,
  ) {
    super(code);
  }
}
export function record(v: unknown): Dict {
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error('Expected object');
  return v as Dict;
}
export function str(v: unknown, fallback = ''): string {
  return typeof v === 'string' ? v : typeof v === 'number' ? String(v) : fallback;
}
export function text(v: unknown): string {
  const s = str(v);
  if (!s || /[\x00-\x1f\x7f]/.test(s)) throw new Error('Invalid text');
  return s;
}
export function port(v: unknown): number {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1 || n > 65535) throw new Error('Invalid port');
  return n;
}
export function normalize(v: unknown): ProxyNode {
  const r = record(v);
  const n: ProxyNode = {
    ...r,
    type: text(r.type).toLowerCase(),
    server: text(r.server).replace(/^\[|\]$/g, ''),
    port: port(r.port),
    name: str(r.name) || str(r.server),
  };
  if (/[\s,/#?@]/.test(n.server)) throw new Error('Invalid server');
  n.name = n.name.replace(/[\x00-\x1f\x7f]/g, ' ').trim() || n.server;
  if (['ss', 'ssr', 'trojan', 'hysteria2', 'tuic'].includes(n.type)) n.password = text(n.password);
  if (['ss', 'ssr', 'vmess'].includes(n.type)) n.cipher = text(n.cipher);
  if (['vmess', 'vless', 'tuic'].includes(n.type)) n.uuid = text(n.uuid);
  if (
    ['vmess', 'vless'].includes(n.type) &&
    !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(str(n.uuid))
  )
    throw new Error('Invalid UUID');
  return n;
}
