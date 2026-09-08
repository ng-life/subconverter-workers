# subconverter-workers

运行在 Cloudflare Workers 上的订阅转换服务。它读取不同格式的上游订阅，统一转换为中间模型并存入 SQLite-backed Durable Object，再根据请求即时输出目标格式。

## 请求地址

```text
https://host/providerName/format?token=TOKEN
```

- `providerName`：`PROVIDERS` 配置中的 Provider 名称。
- `format`：`clash`、`loon`、`quanx` 或 `shadowsocks`。
- `token`：必须与 Worker Secret `TOKEN` 一致。
- `refresh`：可选；设置为 `true` 或 `1` 时忽略 TTL 并强制刷新缓存。

例如：

```text
https://sub.example.com/mysub/clash?token=TOKEN
https://sub.example.com/mysub/quanx?token=TOKEN
https://sub.example.com/mysub/quanx?token=TOKEN&refresh=true
```

## 缓存流程

1. Worker 根据 Provider 名称和完整配置定位专属 Durable Object。
2. `auto`、`base64`、`uri`、`clash`、`loon`、`quanx`、`sip008` 上游统一解析为 `SubscriptionModel`。
3. 缓存未过期时，直接读取中间模型并转换为请求的目标格式。
4. 缓存过期时，等待上游刷新完成，再用最新中间模型生成目标格式。
5. 刷新失败且存在旧模型时返回旧数据，并通过 `x-subscription-cache: STALE` 标记；没有旧模型时返回错误。
6. 请求带 `refresh=true` 或 `refresh=1` 时，即使缓存未过期也会等待强制刷新完成。

静态 Provider 的服务信息请求失败时，节点仍会正常返回，并通过 `x-subscription-warning` 提供经过清理的诊断信息。例如，HTTP 拒绝为 `UPSTREAM_HTTP_ERROR; status=403`，KiwiVM 业务错误则包含受限长度的 `upstream_code` 和百分号编码的 `upstream_message`。响应不会包含完整上游 URL、API Key 或上游正文。

Durable Object 只保存一份中间模型，不保存各目标格式的副本。

## 日志与 Trace

`wrangler.jsonc` 已开启持久化 Logs、Invocation Logs 和 Traces。业务代码使用结构化 JSON 日志，并通过 Cloudflare 原生 `tracing.enterSpan()` 记录以下自定义 Span：

- `subscription.request`：完整请求处理。
- `subscription.authenticate`：Token 校验。
- `subscription.cache`：缓存判断、刷新及转换。
- `subscription.cache.refresh`：完整缓存刷新。
- `subscription.upstream.fetch`：上游订阅请求。
- `subscription.parse`：上游格式转中间模型。
- `subscription.serialize`：中间模型转目标格式。

主要日志事件包括请求完成或失败、缓存刷新开始、刷新成功或失败，以及缓存模型或格式转换异常。日志只记录 Provider 名称、目标格式、状态、耗时和节点数量，不记录访问 Token、Provider 请求头、完整上游 URL 或订阅内容。

当前日志和 Trace 的 `head_sampling_rate` 均为 `1`，即全量记录。流量增大后可以降低采样率控制存储量。

## Provider 配置

`PROVIDERS` 可以配置为 JSON 文本绑定：

```json
{
  "mysub": {
    "type": "auto",
    "url": "https://example.com/subscribe",
    "headers": {
      "authorization": "Bearer upstream-token"
    },
    "cacheTtlSeconds": 300,
    "timeoutSeconds": 10
  }
}
```

`cacheTtlSeconds` 默认为 300 秒。旧配置项 `minRefreshIntervalSeconds` 仍然兼容，但新配置应使用 `cacheTtlSeconds`。

### 静态 QuanX 节点与搬瓦工流量

当节点由自己维护、`url` 仅用于查询搬瓦工 KiwiVM 服务信息时，可以在 QuanX Provider 中增加 `body`：

```json
{
  "bandwagon": {
    "type": "quanx",
    "url": "https://api.64clouds.com/v1/getServiceInfo?veid=YOUR_VEID&api_key=YOUR_API_KEY",
    "body": "vless=server.example.com:443, method=none, password=UUID, obfs=over-tls, obfs-host=example.com, reality-base64-pubkey=PUBLIC_KEY, reality-hex-shortid=SHORT_ID, vless-flow=xtls-rprx-vision, udp-relay=true, tag=bandwagon-vless\nshadowsocks=server.example.com:38388, method=chacha20-ietf-poly1305, password=PASSWORD, fast-open=false, udp-relay=true, tag=nas-shadowsocks",
    "cacheTtlSeconds": 300,
    "timeoutSeconds": 10
  }
}
```

- `body` 是静态 QuanX 节点正文，多条节点必须用换行分隔。
- Worker 请求 `url`，使用 `data_counter`、`plan_monthly_data` 和 `monthly_data_multiplier` 生成 `Subscription-Userinfo`。
- `data_next_reset` 会写入 `expire`，表示下次流量重置时间，并非 VPS 服务到期时间。
- `url` 中包含管理 API Key，生产环境必须使用 `wrangler secret put PROVIDERS`，不要写入 `wrangler.jsonc` 或提交到仓库。

本地开发时可以复制示例变量：

```bash
cp .dev.vars.example .dev.vars
npm install
npm run dev
```

生产环境应将 `TOKEN` 配置为 Worker Secret，不要提交到仓库。

## 验证与部署

```bash
npm run format
npm run check
npm run deploy
```

`npm run check` 会依次执行格式检查、TypeScript 类型检查、测试和 Wrangler dry-run。
