import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { decode64, parseSubscription } from '../src/parsers';
import { serialize } from '../src/serializers';
import { getProvider } from '../src/config';
import { targets, type InputType } from '../src/model';

const uuid = '52396e06-041a-4cc2-be5c-8525eb457809';
const ss = `ss://${btoa('aes-128-gcm:p:a:ss')}@example.com:443#Hong%20Kong`;
const vmess = `vmess://${btoa(JSON.stringify({ v: '2', ps: 'VMess', add: 'example.org', port: '443', id: uuid, aid: '0', net: 'ws', type: 'none', host: 'cdn.example.org', path: '/ws', tls: 'tls', sni: 'tls.example.org' }))}`;

describe('subscription formats', () => {
  it.each(targets)('converts base64 SS to %s native output', (target) => {
    const result = serialize(parseSubscription(btoa(ss), 'base64'), target);
    expect(result.count).toBe(1);
    if (target === 'shadowsocks')
      expect(JSON.parse(result.body)).toMatchObject({
        version: 1,
        servers: [
          { server: 'example.com', server_port: 443, method: 'aes-128-gcm', password: 'p:a:ss' },
        ],
      });
    if (target === 'clash')
      expect(parse(result.body)).toMatchObject({
        proxies: [{ name: 'Hong Kong', password: 'p:a:ss' }],
        rules: ['MATCH,PROXY'],
      });
    if (target === 'loon')
      expect(result.body).toBe('Hong Kong = Shadowsocks,example.com,443,aes-128-gcm,"p:a:ss"\n');
    if (target === 'quanx')
      expect(result.body).toBe(
        'shadowsocks=example.com:443, method=aes-128-gcm, password=p:a:ss, tag=Hong Kong\n',
      );
  });

  it.each(['auto', 'uri'] as InputType[])('parses Unicode, IPv6 and legacy SS with %s', (type) => {
    const body = `ss://${btoa('aes-256-gcm:secret@[2001:db8::1]:8388')}#%E9%A6%99%E6%B8%AF`;
    const { nodes } = parseSubscription(body, type);
    expect(nodes[0]).toMatchObject({ name: '香港', server: '2001:db8::1', password: 'secret' });
    expect(serialize({ schemaVersion: 1, nodes, skipped: 0 }, 'quanx').body).toContain(
      '[2001:db8::1]:8388',
    );
  });

  it('accepts URL-safe base64 without padding and rejects garbage', () => {
    expect(decode64('aGVsbG8')).toBe('hello');
    expect(() => decode64('<html>')).toThrow();
    expect(() => parseSubscription('<html>Forbidden</html>', 'auto')).toThrow();
  });

  it.each(['loon', 'quanx'] as const)(
    'keeps WS TLS, SNI and password through %s roundtrip',
    (target) => {
      const first = parseSubscription(vmess, 'uri');
      const output = serialize(first, target);
      const again = parseSubscription(output.body, target);
      expect(again.nodes[0]).toMatchObject({
        type: 'vmess',
        uuid,
        network: 'ws',
        tls: true,
        servername: 'tls.example.org',
        'ws-opts': { path: '/ws', headers: { Host: 'cdn.example.org' } },
      });
    },
  );

  it('extracts only node sections from full configurations', () => {
    const loon =
      '[General]\ndns-server=system\n[Proxy]\nHK = Shadowsocks,example.com,443,aes-128-gcm,"p,a=ss"\n[Rule]\nFINAL,DIRECT';
    const nodes = parseSubscription(loon, 'auto');
    expect(nodes.nodes[0].password).toBe('p,a=ss');
    expect(nodes.skipped).toBe(0);
    expect(serialize(nodes, 'loon').body).toContain('"p,a=ss"');
    expect(() => serialize(nodes, 'quanx')).toThrow('NO_COMPATIBLE_NODES');
  });

  it('handles all input formats and automatic detection', () => {
    const sources: [InputType, string][] = [
      [
        'clash',
        'proxies:\n  - {name: HK, type: ss, server: example.com, port: 443, cipher: aes-128-gcm, password: pass}',
      ],
      [
        'sip008',
        '{"version":1,"servers":[{"remarks":"HK","server":"example.com","server_port":443,"method":"aes-128-gcm","password":"pass"}]}',
      ],
      ['loon', 'HK = Shadowsocks,example.com,443,aes-128-gcm,"pass"'],
      ['quanx', 'shadowsocks=example.com:443, method=aes-128-gcm, password=pass, tag=HK'],
      ['base64', btoa(ss)],
      ['uri', ss],
    ];
    for (const [type, source] of sources) {
      expect(parseSubscription(source, type).nodes).toHaveLength(1);
      expect(parseSubscription(source, 'auto').nodes).toHaveLength(1);
    }
  });

  it('skips invalid and incompatible nodes, disambiguates names', () => {
    const parsed = parseSubscription(
      [ss, ss, 'ss://invalid', `trojan://secret@example.org:443#Trojan`].join('\n'),
      'uri',
    );
    const out = serialize(parsed, 'shadowsocks');
    expect(out.count).toBe(2);
    expect(out.skipped).toBe(2);
    expect(parsed.nodes.map((n) => n.name)).toEqual(['Hong Kong', 'Hong Kong (2)', 'Trojan']);
  });

  it('keeps advanced Clash fields', () => {
    const parsed = parseSubscription(
      `proxies:\n - {name: reality, type: vless, server: example.com, port: 443, uuid: ${uuid}, tls: true, reality-opts: {public-key: test}, client-fingerprint: chrome}`,
      'clash',
    );
    expect(parse(serialize(parsed, 'clash').body).proxies[0]['reality-opts']).toEqual({
      'public-key': 'test',
    });
  });

  it.each(['loon', 'quanx'] as const)('roundtrips VLESS Reality through %s', (target) => {
    const source =
      `vless://${uuid}@edge.example.com:443?` +
      'security=reality&type=tcp&flow=xtls-rprx-vision&fp=chrome&' +
      'pbk=test-public-key&sid=deadbeef&sni=cover.example.com#Reality';
    const output = serialize(parseSubscription(source, 'uri'), target);
    const again = parseSubscription(output.body, target);

    expect(output.count).toBe(1);
    expect(output.skipped).toBe(0);
    expect(again.nodes[0]).toMatchObject({
      type: 'vless',
      uuid,
      network: 'tcp',
      tls: true,
      flow: 'xtls-rprx-vision',
      servername: 'cover.example.com',
      'reality-opts': { 'public-key': 'test-public-key', 'short-id': 'deadbeef' },
    });
    if (target === 'loon') {
      expect(output.body).toContain('flow=xtls-rprx-vision');
      expect(output.body).toContain('public-key="test-public-key"');
      expect(output.body).toContain('short-id=deadbeef');
      expect(output.body).toContain('sni=cover.example.com');
    } else {
      expect(output.body).toContain('method=none');
      expect(output.body).toContain('reality-base64-pubkey=test-public-key');
      expect(output.body).toContain('reality-hex-shortid=deadbeef');
      expect(output.body).toContain('vless-flow=xtls-rprx-vision');
    }
  });

  it('converts panel-style VLESS Reality links to Clash without losing supported fields', () => {
    const source =
      `vless://${uuid}@edge.example.com:443?` +
      'mode=multi&security=reality&encryption=none&type=tcp&flow=xtls-rprx-vision&' +
      'pbk=test-public-key&sid=deadbeef&sni=cover.example.com&' +
      'servername=cover.example.com&spx=%2F&fp=chrome#Reality';
    const parsed = parseSubscription(source, 'uri');
    const proxy = parse(serialize(parsed, 'clash').body).proxies[0];

    expect(parsed.nodes[0]._unsupported).toBeUndefined();
    expect(proxy).toMatchObject({
      name: 'Reality',
      type: 'vless',
      server: 'edge.example.com',
      port: 443,
      uuid,
      network: 'tcp',
      tls: true,
      flow: 'xtls-rprx-vision',
      servername: 'cover.example.com',
      'client-fingerprint': 'chrome',
      'reality-opts': { 'public-key': 'test-public-key', 'short-id': 'deadbeef' },
    });
  });

  it.each([
    'sni=one.example.com&servername=two.example.com',
    'sni=one.example.com&spx=%2Fcustom',
    'sni=one.example.com&mode=packet-up',
  ])('rejects lossy VLESS Reality aliases or options: %s', (options) => {
    const parsed = parseSubscription(
      `vless://${uuid}@example.com:443?security=reality&pbk=test&sid=&${options}`,
      'uri',
    );
    expect(() => serialize(parsed, 'clash')).toThrow('NO_COMPATIBLE_NODES');
  });

  it('maps obfs plugins between SIP002, Loon, QuanX and SIP008', () => {
    const source = ss.replace(
      '#Hong%20Kong',
      '/?plugin=obfs-local%3Bobfs%3Dtls%3Bobfs-host%3Dcdn.example.com#HK',
    );
    const parsed = parseSubscription(source, 'uri');
    expect(serialize(parsed, 'loon').body).toContain('obfs-name=tls,obfs-host=cdn.example.com');
    expect(serialize(parsed, 'quanx').body).toContain('obfs=tls, obfs-host=cdn.example.com');
    const sip = serialize(parsed, 'shadowsocks').body;
    expect(JSON.parse(sip).servers[0]).toMatchObject({
      plugin: 'obfs-local',
      plugin_opts: 'obfs=tls;obfs-host=cdn.example.com',
    });
    expect(parseSubscription(sip, 'sip008').nodes[0]['plugin-opts']).toEqual({
      mode: 'tls',
      host: 'cdn.example.com',
    });
  });

  it('rejects duplicate YAML keys, bad ports and unsupported URI options', () => {
    expect(() => parseSubscription('proxies: []\nproxies: []', 'clash')).toThrow();
    expect(() => parseSubscription(ss.replace(':443', ':99999'), 'uri')).toThrow('NO_VALID_NODES');
    const parsed = parseSubscription(
      `vless://${uuid}@example.com:443?security=tls&type=ws&unknown=1`,
      'uri',
    );
    expect(() => serialize(parsed, 'clash')).toThrow('NO_COMPATIBLE_NODES');
  });
});

describe('provider config', () => {
  it('supports JSON strings and JSON bindings with independent intervals', () => {
    const providers = {
      mysub: { url: 'https://example.com/sub', type: 'auto', cacheTtlSeconds: 600 },
    };
    expect(getProvider(providers, 'mysub')).toEqual(
      getProvider(JSON.stringify(providers), 'mysub'),
    );
    expect(getProvider(providers, 'mysub').cacheTtlSeconds).toBe(600);
    expect(
      getProvider({ mysub: { url: 'https://example.com/sub' } }, 'mysub').cacheTtlSeconds,
    ).toBe(300);
  });
  it('accepts the legacy refresh interval as the cache TTL', () => {
    expect(
      getProvider(
        { mysub: { url: 'https://example.com/sub', minRefreshIntervalSeconds: 600 } },
        'mysub',
      ).cacheTtlSeconds,
    ).toBe(600);
  });
  it.each([
    'http://example.com',
    'https://localhost',
    'https://127.0.0.1',
    'https://[::1]',
    'https://u:p@example.com',
    'https://x.local',
  ])('rejects unsafe upstream %s', (url) => {
    expect(() => getProvider({ mysub: { url } }, 'mysub')).toThrow('INVALID_PROVIDER_CONFIG');
  });
  it('rejects prototype names, invalid intervals and header injection', () => {
    expect(() => getProvider({}, 'toString')).toThrow('PROVIDER_NOT_FOUND');
    expect(() =>
      getProvider({ a: { url: 'https://example.com', cacheTtlSeconds: 0 } }, 'a'),
    ).toThrow();
    expect(() =>
      getProvider({ a: { url: 'https://example.com', headers: { authorization: 'x\r\ny' } } }, 'a'),
    ).toThrow();
  });
});
