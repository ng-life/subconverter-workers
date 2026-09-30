# 仓库指南

## 项目概况

这是运行在 Cloudflare Workers 上的订阅转换服务。入口位于 `src/index.ts`；解析器把上游数据转换为统一的 `SubscriptionModel`，Durable Object 在 `src/cache.ts` 中缓存模型，序列化器按请求格式生成响应。支持的输入与输出格式以 `src/model.ts` 为准。

## 修改代码时

- 保持“解析为统一模型、按请求即时序列化”的结构；不要在 Durable Object 中缓存各输出格式的副本。
- 新增或调整输入格式时，检查 `src/parsers.ts` 及对应解析测试；调整输出格式时，检查 `src/serializers.ts` 及对应转换测试。
- 缓存、刷新、流量上报或 Durable Object 存储变更，应同步检查 `src/cache.ts`、`src/index.ts` 和相关测试。
- Provider 配置应通过 `src/config.ts` 校验；上游请求与响应大小、超时、重定向和错误处理集中在 `src/upstream.ts`。
- 日志和 Trace 通过 `src/observability.ts` 与 Cloudflare `tracing` 接入。不得记录 Token、订阅正文、Provider 请求头、完整上游 URL 或 API Key；新增字段应先确认不包含凭据或用户订阅内容。
- 尽量保留现有错误码、响应头和缓存语义的兼容性；行为变更时同步更新 `README.md` 和测试。

## 本地开发与命令

- Node.js + npm 项目，使用 `npm install` 安装依赖。
- 本地变量参考 `.dev.vars.example`，复制为未跟踪的 `.dev.vars` 后填入本地值。
- `npm run dev` 启动 Wrangler 本地开发服务器。
- `npm run format` 格式化；`npm run format:check` 检查格式。
- `npm run typecheck` 执行 TypeScript 检查；`npm test` 运行 Vitest 测试。
- `npm run check` 串行运行格式检查、类型检查、测试和 Wrangler dry-run 构建。
- `npm run deploy` 会部署到 Cloudflare；除非用户明确要求部署，不要运行此命令。

## 配置与凭据

- `wrangler.jsonc` 是 Worker、Durable Object、迁移和可观测性配置的来源。
- `TOKEN`、`PUSH_TOKEN`、生产环境 `PROVIDERS` 应作为 Cloudflare Worker Secret 管理。不得把真实凭据写入仓库、测试快照或日志。
- 不要提交 `.dev.vars`、`dist/` 或其他本地产物；修改前检查 Git 状态并保留用户已有改动。

