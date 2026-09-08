import { stringify } from 'yaml';
import {
  AppError,
  record,
  str,
  type Dict,
  type Output,
  type ProxyNode,
  type SubscriptionModel,
  type Target,
} from './model';

const baseKeys = new Set([
  'name',
  'type',
  'server',
  'port',
  'cipher',
  'password',
  'uuid',
  'username',
  'alterId',
  'network',
  'tls',
  'servername',
  'sni',
  'skip-cert-verify',
  'udp',
  'tfo',
  'ws-opts',
  'plugin',
  'plugin-opts',
  'protocol',
  'protocol-param',
  'obfs',
  'obfs-param',
  'flow',
  'client-fingerprint',
  'reality-opts',
  'server_check_url',
]);
const clashTypes = new Set([
  'ss',
  'ssr',
  'vmess',
  'vless',
  'trojan',
  'http',
  'socks5',
  'hysteria2',
  'tuic',
  'hysteria',
  'snell',
  'wireguard',
]);
function simple(v: unknown): string {
  const s = str(v);
  if (/[\r\n\x00-\x1f\x7f,"\\]/.test(s) || s !== s.trim()) throw new Error('Unrepresentable value');
  return s;
}
function quoted(v: unknown): string {
  const s = str(v);
  if (/[\x00-\x1f\x7f]/.test(s)) throw new Error('Unrepresentable value');
  return JSON.stringify(s);
}
function bool(n: ProxyNode, key: string, fallback = false): boolean {
  if (n[key] === undefined) return fallback;
  if (typeof n[key] !== 'boolean') throw new Error('Invalid boolean');
  return n[key];
}
function transport(n: ProxyNode): { network: string; path: string; host: string } {
  const network = str(n.network, 'tcp');
  if (!['tcp', 'ws'].includes(network)) throw new Error('Unsupported transport');
  const ws = n['ws-opts'] === undefined ? {} : record(n['ws-opts']);
  if (Object.keys(ws).some((k) => !['path', 'headers'].includes(k)))
    throw new Error('Unsupported websocket options');
  const headers = ws.headers === undefined ? {} : record(ws.headers);
  if (Object.keys(headers).some((k) => k.toLowerCase() !== 'host'))
    throw new Error('Unsupported websocket headers');
  return {
    network,
    path: simple(ws.path || '/'),
    host: simple(headers.Host ?? headers.host ?? ''),
  };
}
function plugin(n: ProxyNode): Dict {
  const p = record(n['plugin-opts'] ?? {});
  if (n.plugin === 'obfs') {
    if (
      !['http', 'tls'].includes(str(p.mode)) ||
      Object.keys(p).some((k) => !['mode', 'host'].includes(k))
    )
      throw new Error('Unsupported obfs');
  } else if (n.plugin === 'v2ray-plugin') {
    if (
      (p.mode && p.mode !== 'websocket') ||
      Object.keys(p).some((k) => !['mode', 'tls', 'host', 'path', 'mux'].includes(k)) ||
      p.mux === true
    )
      throw new Error('Unsupported plugin');
  } else if (n.plugin) throw new Error('Unsupported plugin');
  return p;
}
function reality(n: ProxyNode): Dict | undefined {
  if (n['reality-opts'] === undefined) return undefined;
  const options = record(n['reality-opts']);
  if (
    n.type !== 'vless' ||
    n.tls !== true ||
    !simple(options['public-key']) ||
    Object.keys(options).some((key) => !['public-key', 'short-id'].includes(key))
  )
    throw new Error('Unsupported Reality options');
  if (options['short-id'] !== undefined) simple(options['short-id']);
  return options;
}
function checkNative(n: ProxyNode, target: Target): void {
  if (Object.keys(n).some((k) => !baseKeys.has(k))) throw new Error('Unsupported fields');
  if (!['ss', 'ssr', 'vmess', 'vless', 'trojan', 'http', 'socks5'].includes(n.type))
    throw new Error('Unsupported type');
  if (n.type === 'vmess' && Number(n.alterId ?? 0) !== 0) throw new Error('Legacy VMess');
  if (n.type === 'ss' && str(n.cipher).startsWith('2022-')) throw new Error('Unsupported SS2022');
  if (n.type !== 'ss' && (n.plugin || n['plugin-opts'])) throw new Error('Unexpected plugin');
  const t = transport(n);
  if (t.network !== 'tcp' && !['vmess', 'vless'].includes(n.type))
    throw new Error('Unsupported transport');
  if (n.type === 'ss' && n.tls === true) throw new Error('Unexpected TLS');
  plugin(n);
  const realityOptions = reality(n);
  if (n.flow !== undefined && (n.type !== 'vless' || n.flow !== 'xtls-rprx-vision'))
    throw new Error('Unsupported VLESS flow');
  // Loon and Quantumult X select their own TLS fingerprint for Reality.
  if (n['client-fingerprint'] !== undefined && !realityOptions)
    throw new Error('Unsupported client fingerprint');
}

function loon(n: ProxyNode): string {
  checkNative(n, 'loon');
  const realityOptions = reality(n);
  if (n.plugin === 'v2ray-plugin') throw new Error('Unsupported plugin');
  const name = simple(n.name).replace(/=/g, '﹦');
  const type =
    n.type === 'ss'
      ? 'Shadowsocks'
      : n.type === 'ssr'
        ? 'ShadowsocksR'
        : n.type === 'http' && n.tls
          ? 'https'
          : n.type;
  const parts = [type, simple(n.server), String(n.port)];
  if (['ss', 'ssr', 'vmess'].includes(n.type)) parts.push(simple(n.cipher));
  if (['vmess', 'vless'].includes(n.type)) parts.push(quoted(n.uuid));
  else if (['ss', 'ssr', 'trojan'].includes(n.type)) parts.push(quoted(n.password));
  else if (n.username || n.password) parts.push(simple(n.username), quoted(n.password));
  const p = plugin(n);
  const t = transport(n);
  if (n.plugin === 'obfs') {
    parts.push(`obfs-name=${simple(p.mode)}`);
    if (p.host) parts.push(`obfs-host=${simple(p.host)}`);
  }
  if (n.type === 'ssr')
    for (const key of ['protocol', 'protocol-param', 'obfs', 'obfs-param'])
      if (n[key]) parts.push(`${key}=${simple(n[key])}`);
  if (['vmess', 'vless'].includes(n.type)) {
    parts.push(`transport=${t.network}`, `over-tls=${bool(n, 'tls')}`);
    if (n.type === 'vless' && n.flow) parts.push(`flow=${simple(n.flow)}`);
    if (t.network === 'ws') {
      parts.push(`path=${t.path}`);
      if (t.host) parts.push(`host=${t.host}`);
    }
  }
  if (realityOptions) {
    parts.push(`public-key=${quoted(realityOptions['public-key'])}`);
    if (realityOptions['short-id']) parts.push(`short-id=${simple(realityOptions['short-id'])}`);
  }
  if (n.tls || n.type === 'trojan') {
    if (n.servername || n.sni)
      parts.push(`${realityOptions ? 'sni' : 'tls-name'}=${simple(n.servername || n.sni)}`);
    parts.push(`skip-cert-verify=${bool(n, 'skip-cert-verify')}`);
  }
  if (n.type === 'socks5' && n.tls) throw new Error('Unsupported TLS');
  for (const [key, out] of [
    ['udp', 'udp'],
    ['tfo', 'fast-open'],
  ])
    if (n[key] !== undefined) parts.push(`${out}=${bool(n, key)}`);
  return `${name} = ${parts.join(',')}`;
}

function quanx(n: ProxyNode): string {
  checkNative(n, 'quanx');
  const realityOptions = reality(n);
  const host = n.server.includes(':') ? `[${n.server}]` : n.server;
  const parts = [
    `${['ss', 'ssr'].includes(n.type) ? 'shadowsocks' : n.type}=${simple(host)}:${n.port}`,
  ];
  if (n.type === 'vless') parts.push('method=none');
  else if (n.cipher) parts.push(`method=${simple(n.cipher)}`);
  if (n.type === 'vmess') parts.push(`password=${simple(n.uuid)}`, 'aead=true');
  else if (n.type === 'vless') parts.push(`password=${simple(n.uuid)}`);
  else if (n.password) parts.push(`password=${simple(n.password)}`);
  if (n.username) parts.push(`username=${simple(n.username)}`);
  const p = plugin(n);
  const t = transport(n);
  if (n.plugin === 'obfs') {
    parts.push(`obfs=${simple(p.mode)}`);
    if (p.host) parts.push(`obfs-host=${simple(p.host)}`);
  }
  if (n.plugin === 'v2ray-plugin') {
    parts.push(`obfs=${p.tls ? 'wss' : 'ws'}`, `obfs-uri=${simple(p.path || '/')}`);
    if (p.host) parts.push(`obfs-host=${simple(p.host)}`);
  }
  if (n.type === 'ssr') {
    parts.push(`ssr-protocol=${simple(n.protocol)}`, `obfs=${simple(n.obfs || 'plain')}`);
    if (n['protocol-param']) parts.push(`ssr-protocol-param=${simple(n['protocol-param'])}`);
    if (n['obfs-param']) parts.push(`obfs-host=${simple(n['obfs-param'])}`);
  }
  if (['vmess', 'vless'].includes(n.type)) {
    if (t.network === 'ws') {
      parts.push(`obfs=${n.tls ? 'wss' : 'ws'}`, `obfs-uri=${t.path}`);
      if (t.host) parts.push(`obfs-host=${t.host}`);
    } else if (n.tls) parts.push('obfs=over-tls');
    if (n.type === 'vless') {
      if (n.tls && (n.servername || n.sni) && !t.host)
        parts.push(`obfs-host=${simple(n.servername || n.sni)}`);
      if (realityOptions) {
        parts.push(`reality-base64-pubkey=${simple(realityOptions['public-key'])}`);
        if (realityOptions['short-id'])
          parts.push(`reality-hex-shortid=${simple(realityOptions['short-id'])}`);
      }
      if (n.flow) parts.push(`vless-flow=${simple(n.flow)}`);
      if (n.tls) parts.push(`tls-verification=${!bool(n, 'skip-cert-verify')}`);
    }
  } else if (['trojan', 'http', 'socks5'].includes(n.type))
    parts.push(`over-tls=${bool(n, 'tls', n.type === 'trojan')}`);
  if ((n.tls || n.type === 'trojan' || p.tls) && n.type !== 'vless') {
    if (n.servername || n.sni) parts.push(`tls-host=${simple(n.servername || n.sni)}`);
    parts.push(`tls-verification=${!bool(n, 'skip-cert-verify')}`);
  }
  for (const [key, out] of [
    ['udp', 'udp-relay'],
    ['tfo', 'fast-open'],
  ])
    if (n[key] !== undefined) parts.push(`${out}=${bool(n, key)}`);
  if (n['server_check_url']) parts.push(`server_check_url=${simple(n['server_check_url'])}`);
  parts.push(`tag=${simple(n.name)}`);
  return parts.join(', ');
}

function sip008(n: ProxyNode): Dict {
  if (
    n.type !== 'ss' ||
    Object.keys(n).some(
      (k) =>
        ![
          'name',
          'type',
          'server',
          'port',
          'cipher',
          'password',
          'plugin',
          'plugin-opts',
          'udp',
          'tfo',
          // QuanX-only health-check metadata does not affect the SIP008 connection.
          'server_check_url',
        ].includes(k),
    )
  )
    throw new Error('Unsupported SS options');
  const result: Dict = {
    remarks: n.name,
    server: n.server,
    server_port: n.port,
    method: n.cipher,
    password: n.password,
  };
  const p = plugin(n);
  if (n.plugin === 'obfs') {
    result.plugin = 'obfs-local';
    result.plugin_opts = `obfs=${simple(p.mode)}${p.host ? ';obfs-host=' + simple(p.host) : ''}`;
  } else if (n.plugin) {
    result.plugin = n.plugin;
    result.plugin_opts = Object.entries(p)
      .filter(([k, v]) => k !== 'mode' && v !== false && v !== undefined)
      .map(([k, v]) => (v === true ? k : `${k}=${simple(v)}`))
      .join(';');
  }
  return result;
}

/** Convert the intermediate model on demand, skipping nodes the target cannot represent. */
export function serialize(model: SubscriptionModel, target: Target): Output {
  let skipped = model.skipped;
  const values: (Dict | string)[] = [];
  for (const n of model.nodes) {
    try {
      if (n['_unsupported']) throw new Error('Unsupported source options');
      if (target === 'clash') {
        if (!clashTypes.has(n.type)) throw new Error('Unsupported protocol');
        const proxy = { ...n };
        // QuanX's per-node test URL is client metadata, not a Clash proxy field.
        delete proxy['server_check_url'];
        // Clash's Trojan uses sni; VMess/VLESS use servername.
        if (n.type === 'trojan' && n.servername) {
          proxy.sni = n.servername;
          delete proxy.servername;
        }
        values.push(proxy);
      } else values.push(target === 'loon' ? loon(n) : target === 'quanx' ? quanx(n) : sip008(n));
    } catch {
      skipped++;
    }
  }
  if (!values.length) throw new AppError(422, 'NO_COMPATIBLE_NODES');
  let body: string;
  let contentType: string;
  if (target === 'clash') {
    body = stringify({
      'mixed-port': 7890,
      'allow-lan': false,
      mode: 'rule',
      'log-level': 'info',
      proxies: values,
      'proxy-groups': [
        { name: 'PROXY', type: 'select', proxies: values.map((v) => (v as Dict).name) },
      ],
      rules: ['MATCH,PROXY'],
    });
    contentType = 'application/yaml; charset=utf-8';
  } else if (target === 'shadowsocks') {
    body = JSON.stringify({ version: 1, servers: values }, null, 2) + '\n';
    contentType = 'application/json; charset=utf-8';
  } else {
    body = values.join('\n') + '\n';
    contentType = 'text/plain; charset=utf-8';
  }
  if (new TextEncoder().encode(body).length > 1024 * 1024)
    throw new AppError(502, 'OUTPUT_TOO_LARGE');
  return { body, contentType, skipped, count: values.length };
}
