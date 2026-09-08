# subconverter-workers

运行在 Cloudflare Workers 上的订阅转换服务。它读取不同格式的上游订阅，统一转换为中间模型并存入 SQLite-backed Durable Object，再根据请求即时输出目标格式。

## 请求地址

```text
https://host/providerName/format?token=TOKEN
```

- `providerName`：`PROVIDERS` 配置中的 Provider 名称。
- `format`：`clash`、`loon`、`quanx` 或 `shadowsocks`。
- `token`：必须与 Worker Secret `TOKEN` 一致。

例如：

```text
https://sub.example.com/mysub/clash?token=TOKEN
https://sub.example.com/mysub/quanx?token=TOKEN
```

## 缓存流程

1. Worker 根据 Provider 名称和完整配置定位专属 Durable Object。
2. `auto`、`base64`、`uri`、`clash`、`loon`、`quanx`、`sip008` 上游统一解析为 `SubscriptionModel`。
3. 缓存未过期时，直接读取中间模型并转换为请求的目标格式。
4. 缓存过期时，等待上游刷新完成，再用最新中间模型生成目标格式。
5. 刷新失败且存在旧模型时返回旧数据，并通过 `x-subscription-cache: STALE` 标记；没有旧模型时返回错误。

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
