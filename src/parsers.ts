import { parseDocument } from 'yaml';
import { AppError, normalize, record, str, type Dict, type InputType, type Parsed, type ProxyNode } from './model';

export function decode64(value: string): string {
  const s = value.replace(/\s/g, '').replace(/-/g, '+').replace(/_/g, '/');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(s) || s.replace(/=+$/, '').length % 4 === 1) throw new Error('Invalid base64');
  return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(Uint8Array.from(atob(s), c => c.charCodeAt(0)));
}

function splitFirst(s: string, separator: string): [string, string] {
  const i = s.indexOf(separator);
  if (i < 0) throw new Error('Missing separator');
  return [s.slice(0, i).trim(), s.slice(i + separator.length).trim()];
}
function endpoint(s: string): { server: string; port: string } {
  const m = s.match(/^(\[[^\]]+\]|[^:]+):(\d+)$/);
  if (!m) throw new Error('Invalid endpoint');
  return { server: m[1], port: m[2] };
}
function opts(parts: string[]): Dict {
  return Object.fromEntries(parts.filter(Boolean).map(s => splitFirst(s, '=')));
}
function bool(v: unknown): boolean {
  if (v === true || v === 'true' || v === '1') return true;
  if (v === false || v === 'false' || v === '0') return false;
  throw new Error('Invalid boolean');
}
function common(n: Dict, o: Dict, native: 'loon' | 'quanx'): void {
  const map = native === 'loon'
    ? { 'tls-name': 'servername', 'skip-cert-verify': 'skip-cert-verify', udp: 'udp', 'fast-open': 'tfo', 'over-tls': 'tls' }
    : { 'tls-host': 'servername', 'udp-relay': 'udp', 'fast-open': 'tfo', 'over-tls': 'tls' };
  for (const [from, to] of Object.entries(map)) if (o[from] !== undefined) n[to] = to === 'servername' ? o[from] : bool(o[from]);
  if (o['tls-verification'] !== undefined) n['skip-cert-verify'] = !bool(o['tls-verification']);
}

function uri(line: string): Dict {
  const scheme = line.slice(0, line.indexOf('://')).toLowerCase();
  if (scheme === 'vmess') {
    const o = record(JSON.parse(decode64(line.slice(8))));
    const n: Dict = { type: 'vmess', name: o.ps, server: o.add, port: o.port, uuid: o.id, alterId: Number(o.aid ?? 0), cipher: o.scy || 'auto', network: o.net || 'tcp', tls: o.tls === 'tls' };
    if (o.sni) n.servername = o.sni;
    if (o.alpn) n.alpn = str(o.alpn).split(',');
    if (o.fp) n['client-fingerprint'] = o.fp;
    if (o.type && o.type !== 'none') n['_unsupported'] = true;
    if (n.network === 'ws') n['ws-opts'] = { path: o.path || '/', headers: o.host ? { Host: o.host } : {} };
    if (n.network === 'grpc') n['grpc-opts'] = { 'grpc-service-name': o.path || '' };
    return n;
  }
  if (scheme === 'ssr') {
    const decoded = decode64(line.slice(6));
    const [base, query = ''] = decoded.split('/?');
    const m = base.match(/^(.*):(\d+):([^:]+):([^:]+):([^:]+):([^:]+)$/);
    if (!m) throw new Error('Invalid SSR');
    const q = new URLSearchParams(query);
    return { type: 'ssr', server: m[1], port: m[2], protocol: m[3], cipher: m[4], obfs: m[5], password: decode64(m[6]), name: q.has('remarks') ? decode64(q.get('remarks')!) : m[1], 'protocol-param': q.has('protoparam') ? decode64(q.get('protoparam')!) : '', 'obfs-param': q.has('obfsparam') ? decode64(q.get('obfsparam')!) : '' };
  }
  if (scheme === 'ss') {
    const [raw, fragment = ''] = line.slice(5).split('#');
    const [authority, query = ''] = raw.split('?');
    const full = authority.includes('@') ? authority.replace(/\/$/, '') : decode64(authority.replace(/\/$/, ''));
    const at = full.lastIndexOf('@');
    if (at < 0) throw new Error('Invalid SS');
    const user = full.slice(0, at);
    const [cipher, password] = splitFirst(user.includes(':') ? decodeURIComponent(user) : decode64(decodeURIComponent(user)), ':');
    const n: Dict = { type: 'ss', ...endpoint(full.slice(at + 1)), cipher, password, name: decodeURIComponent(fragment) };
    const q = new URLSearchParams(query);
    if (q.has('plugin')) {
      const [plugin, ...rest] = q.get('plugin')!.split(';');
      const p: Dict = {};
      for (const item of rest) { const i = item.indexOf('='); p[i < 0 ? item : item.slice(0, i)] = i < 0 ? true : item.slice(i + 1); }
      n.plugin = plugin === 'simple-obfs' || plugin === 'obfs-local' ? 'obfs' : plugin;
      n['plugin-opts'] = n.plugin === 'obfs' ? { mode: p.obfs, host: p['obfs-host'] } : p;
    }
    if ([...q.keys()].some(k => k !== 'plugin')) n['_unsupported'] = true;
    return n;
  }
  if (!['trojan', 'vless', 'hysteria2', 'hy2', 'tuic', 'http', 'https', 'socks5'].includes(scheme)) throw new Error('Unsupported URI');
  const u = new URL(line);
  const q = u.searchParams;
  const n: Dict = { type: scheme === 'hy2' ? 'hysteria2' : scheme === 'https' ? 'http' : scheme, server: u.hostname, port: u.port || (scheme === 'http' ? 80 : 443), name: decodeURIComponent(u.hash.slice(1)) };
  if (scheme === 'vless' || scheme === 'tuic') n.uuid = decodeURIComponent(u.username);
  else if (['http', 'https', 'socks5'].includes(scheme)) n.username = decodeURIComponent(u.username);
  else n.password = decodeURIComponent(u.username + (u.password ? ':' + u.password : ''));
  if (u.password && ['tuic', 'http', 'https', 'socks5'].includes(scheme)) n.password = decodeURIComponent(u.password);
  if (['trojan', 'https', 'hysteria2', 'hy2', 'tuic'].includes(scheme)) n.tls = true;
  if (q.has('security')) {
    n.tls = q.get('security') !== 'none';
    if (q.get('security') === 'reality') n['reality-opts'] = { 'public-key': q.get('pbk'), 'short-id': q.get('sid') || '' };
    else if (!['tls', 'none'].includes(q.get('security')!)) n['_unsupported'] = true;
  }
  if (q.has('sni') || q.has('peer')) n.servername = q.get('sni') || q.get('peer');
  if (q.has('allowInsecure') || q.has('insecure')) n['skip-cert-verify'] = bool(q.get('allowInsecure') ?? q.get('insecure'));
  if (q.has('alpn')) n.alpn = q.get('alpn')!.split(',');
  if (q.has('fp')) n['client-fingerprint'] = q.get('fp');
  if (q.has('flow')) n.flow = q.get('flow');
  if (q.has('type')) n.network = q.get('type');
  if (n.network === 'ws') n['ws-opts'] = { path: q.get('path') || '/', headers: q.has('host') ? { Host: q.get('host') } : {} };
  if (n.network === 'grpc') n['grpc-opts'] = { 'grpc-service-name': q.get('serviceName') || '' };
  const known = new Set(['security', 'sni', 'peer', 'allowInsecure', 'insecure', 'alpn', 'fp', 'flow', 'type', 'path', 'host', 'serviceName', 'pbk', 'sid', 'encryption']);
  if ([...q.keys()].some(k => !known.has(k)) || (q.has('encryption') && q.get('encryption') !== 'none') || (u.pathname && u.pathname !== '/')) n['_unsupported'] = true;
  return n;
}

// A quoted comma is data in Loon; escapes are decoded only within quotes.
function csv(line: string): string[] {
  const result: string[] = []; let part = ''; let quoted = false; let escape = false;
  for (const c of line) {
    if (escape) { part += c; escape = false; }
    else if (quoted && c === '\\') escape = true;
    else if (c === '"') quoted = !quoted;
    else if (c === ',' && !quoted) { result.push(part.trim()); part = ''; }
    else part += c;
  }
  if (quoted || escape) throw new Error('Unclosed quote');
  result.push(part.trim()); return result;
}

function loon(line: string): Dict {
  const [name, rhs] = splitFirst(line, '=');
  const [kind, server, port, ...tail] = csv(rhs);
  const type = ({ shadowsocks: 'ss', shadowsocksr: 'ssr', https: 'http' } as Record<string, string>)[kind.toLowerCase()] || kind.toLowerCase();
  const n: Dict = { name, type, server, port };
  if (['ss', 'ssr', 'vmess'].includes(type)) n.cipher = tail.shift();
  if (['vmess', 'vless'].includes(type)) n.uuid = tail.shift();
  else if (['ss', 'ssr', 'trojan'].includes(type)) n.password = tail.shift();
  else if (['http', 'socks5'].includes(type) && tail.length && !tail[0].includes('=')) { n.username = tail.shift(); n.password = tail.shift(); }
  const o = opts(tail);
  common(n, o, 'loon');
  if (kind.toLowerCase() === 'https' || type === 'trojan') n.tls = true;
  if (o.transport) n.network = o.transport;
  if (n.network === 'ws') n['ws-opts'] = { path: o.path || '/', headers: o.host ? { Host: o.host } : {} };
  if (type === 'ss' && o['obfs-name']) { n.plugin = 'obfs'; n['plugin-opts'] = { mode: o['obfs-name'], host: o['obfs-host'] || '' }; }
  if (type === 'ssr') for (const k of ['protocol', 'protocol-param', 'obfs', 'obfs-param']) if (o[k] !== undefined) n[k] = o[k];
  if (type === 'vmess') n.alterId = Number(o['alterId'] || 0);
  const known = new Set(['tls-name', 'skip-cert-verify', 'udp', 'fast-open', 'over-tls', 'transport', 'path', 'host', 'obfs-name', 'obfs-host', 'protocol', 'protocol-param', 'obfs', 'obfs-param', 'alterId']);
  if (Object.keys(o).some(k => !known.has(k))) n['_unsupported'] = true;
  return n;
}

function quanx(line: string): Dict {
  const [first, ...tail] = csv(line);
  const [kind, address] = splitFirst(first, '=');
  const o = opts(tail);
  const n: Dict = { type: kind === 'shadowsocks' ? (o['ssr-protocol'] ? 'ssr' : 'ss') : kind, ...endpoint(address), name: o.tag };
  if (o.method) n.cipher = o.method;
  if (kind === 'vmess') { n.uuid = o.password; n.alterId = o['aead'] === 'false' ? 1 : 0; }
  else if (o.password) n.password = o.password;
  if (o.username) n.username = o.username;
  common(n, o, 'quanx');
  if (n.type === 'ssr') {
    n.protocol = o['ssr-protocol']; n['protocol-param'] = o['ssr-protocol-param'] || '';
    n.obfs = o.obfs || 'plain'; n['obfs-param'] = o['obfs-host'] || '';
  } else if (o.obfs === 'ws' || o.obfs === 'wss') {
    if (n.type === 'ss') { n.plugin = 'v2ray-plugin'; n['plugin-opts'] = { mode: 'websocket', tls: o.obfs === 'wss', host: o['obfs-host'] || '', path: o['obfs-uri'] || '/' }; }
    else { n.network = 'ws'; n.tls = o.obfs === 'wss'; n['ws-opts'] = { path: o['obfs-uri'] || '/', headers: o['obfs-host'] ? { Host: o['obfs-host'] } : {} }; }
  } else if (n.type === 'ss' && o.obfs) { n.plugin = 'obfs'; n['plugin-opts'] = { mode: o.obfs, host: o['obfs-host'] || '' }; }
  else if (o.obfs === 'over-tls') n.tls = true;
  else if (o.obfs) n['_unsupported'] = true;
  const known = new Set(['tag', 'method', 'password', 'username', 'aead', 'tls-host', 'tls-verification', 'udp-relay', 'fast-open', 'over-tls', 'obfs', 'obfs-host', 'obfs-uri', 'ssr-protocol', 'ssr-protocol-param']);
  if (Object.keys(o).some(k => !known.has(k))) n['_unsupported'] = true;
  return n;
}

export function parseSubscription(source: string, type: InputType): Parsed {
  try {
    let body = source.replace(/^\uFEFF/, '').trim();
    if (type === 'base64') { body = decode64(body).trim(); type = 'uri'; }
    if (type === 'auto') {
      if (/^(?:\{|\[)/.test(body) && !/^\[(?:Proxy|General|server_local)\]/i.test(body)) {
        const doc: unknown = JSON.parse(body);
        type = !Array.isArray(doc) && Object.hasOwn(record(doc), 'proxies') ? 'clash' : 'sip008';
      } else if (/^\s*proxies\s*:/m.test(body)) type = 'clash';
      else if (/^[\w+-]+:\/\//m.test(body)) type = 'uri';
      else if (/^(shadowsocks|vmess|trojan|http|socks5)\s*=/m.test(body)) type = 'quanx';
      else if (/^\[|^.+?\s*=\s*(Shadowsocks|ShadowsocksR|vmess|vless|trojan|http|https|socks5),/im.test(body)) type = 'loon';
      else { body = decode64(body).trim(); type = 'uri'; }
    }
    let items: unknown[]; let parser: (v: unknown) => Dict;
    if (type === 'clash') {
      const doc = parseDocument(body, { uniqueKeys: true });
      if (doc.errors.length) throw new Error('Invalid YAML');
      const value = record(doc.toJS({ maxAliasCount: 30 }));
      if (!Array.isArray(value.proxies)) throw new Error('Missing proxies');
      items = value.proxies; parser = record;
    } else if (type === 'sip008') {
      const value: unknown = JSON.parse(body);
      items = Array.isArray(value) ? value : record(value).servers as unknown[];
      if (!Array.isArray(items)) throw new Error('Missing servers');
      parser = value => { const s = record(value); const n: Dict = { type: 'ss', name: s.remarks, server: s.server, port: s.server_port, cipher: s.method, password: s.password };
        if (s.plugin) { const q = new URLSearchParams({ plugin: str(s.plugin) + (s.plugin_opts ? ';' + str(s.plugin_opts) : '') }); return { ...uri(`ss://${btoa('x:x')}@example.com:443?${q}`), ...n }; } return n; };
    } else {
      const section = type === 'loon' ? 'proxy' : 'server_local';
      let active = true;
      items = body.split(/\r?\n/).map(s => s.trim()).filter(line => {
        if (/^\[.*\]$/.test(line)) { active = line.slice(1, -1).toLowerCase() === section; return false; }
        return active && !!line && !line.startsWith('#') && !line.startsWith(';') && !line.startsWith('//');
      });
      parser = value => (type === 'uri' ? uri : type === 'loon' ? loon : quanx)(String(value));
    }
    if (items.length > 10000) throw new AppError(502, 'TOO_MANY_NODES');
    const nodes: ProxyNode[] = []; let skipped = 0;
    const names = new Set(['PROXY', 'DIRECT', 'REJECT', 'GLOBAL']);
    for (const item of items) {
      try {
        const n = normalize(parser(item));
        let name = n.name; let suffix = 2;
        while (names.has(name)) name = `${n.name} (${suffix++})`;
        names.add(name); n.name = name; nodes.push(n);
      } catch { skipped++; }
    }
    if (!nodes.length) throw new AppError(502, 'NO_VALID_NODES');
    return { nodes, skipped };
  } catch (e) {
    if (e instanceof AppError) throw e;
    throw new AppError(502, 'INVALID_SUBSCRIPTION');
  }
}
