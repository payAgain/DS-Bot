# OpenMausBot 连接器源码审查

审查对象：本地 `OpenMausBot` 源码，Git revision
`11d0093f29f89d0c97738bae7a0be85fd2047a92`，提交日期 2026-11-06。
本报告描述该 revision 的实现，不将其声称为上游最新版本。

## 连接器并非单一实现

| 类型 | 上游入口 | 工作方式 | DS-Bot 接入方式 |
| --- | --- | --- | --- |
| 应用市场 | `src/components/PluginsPanel.tsx`、`server/composio.ts` | Composio 工具包，带账号授权、目录和工具执行 | 在现有连接器页增加应用来源，适配同一服务协议 |
| 官方 MCP 服务 | `src/lib/hosted-mcp-apps.ts` | Whop、Agentcard 各自的 Streamable HTTP MCP 和浏览器 OAuth | 加入原生目录，沿用 DSH 的 MCP 工具网关 |
| 邮箱 | `server/email/`、`server/email-connector.e2e.test.ts` | 独立邮箱协议与邮件工具 | DS-Bot 已有 IMAP/SMTP 机制；不经过 Composio |
| 专门的业务连接 | `server/routes/x-connector.ts`、`server/postiz/`、`server/highlevel/` | 各自的 API、登录/中转服务及工具 | 分别适配，不能只添加名称后宣称可用 |
| MCP Apps 界面 | `server/mcp-app-connections.ts` | 读取 MCP 的交互式 UI 资源并执行其操作 | 属于 MCP Apps 界面支持，不是应用市场服务端 |

## 官方客户端为什么不要求用户填项目密钥

`electron/managed-composio.mjs` 的 `ensureManagedComposioCredentials` 首先检查
已有安装凭据的 `/v1/me`；只有明确的 401 才轮换凭据，网络故障不清除已有身份。
首次安装通过 `POST /v1/installations` 获取安装 ID 和独立 bearer token。

`cloudflare/composio-broker/src/index.ts` 接收该身份，为每个安装分配独立
Composio user/session。真正的 `COMPOSIO_API_KEY` 是 Worker 的服务端 secret，
不会下发客户端。项目密钥属于服务部署者；用户只负责对选择的应用做账号授权。
注册能否成功还受 Worker 的 `REGISTRATION_MODE`、限流及部署侧访问策略影响。

因此，官方客户端的体验来自“客户端 + 已运营的连接服务”，源码不包含可直接取来
使用的官方项目密钥。复制卡片或本地安装 Worker 代码也不会自动拥有该服务端配置。

## 完整调用链

1. `PluginsPanel` 读取 `/api/connectors/catalog`。`listToolkits` 每页最多读 500 个，
   最多走 100 页，去重并检查页码、游标和总数，缓存十分钟；取不到市场目录时返回
   `CURATED` 中的 24 个应用。静态条目不证明账号授权可用。
2. 点击连接，经 `authorizeService` 调 `/v1/connectors/:slug/authorize`。
   broker 创建短期 Connect Link，浏览器打开该链接，用户重新登录目标应用。
   `planAccountLink` 避免替换已有有效账号，并为多账号要求独立 alias。
3. `src/lib/connector-poll.ts` 每五秒回查，按本次新增/状态变更的账号判断结果，
   避免拿旧账号的 ACTIVE 状态误判新授权成功；轮询最多 24 次。
4. 账号清单走 `/v1/connectors/connected`，指定应用状态走 `/v1/connectors`。
   删除单个账号走 `/v1/connectors/:slug/accounts/:accountId`，服务端先核验归属。
5. `connector-proxy.ts` 为 Bot 提供 MCP 桥接。常用 Gmail/Calendar 动作在
   `connector-app-tools.ts` 映射为 `COMPOSIO_MULTI_EXECUTE_TOOL` 的一次工具调用；
   还支持 Composio 自身的搜索、Schema 和工具列表。
6. 实际请求经过 `/api/internal/connectors/mcp`，由内部 capability 确定 Bot 与会话，
   `connector-verdict.ts`、作用域及审批逻辑再次核对真实目标工具，再由
   `relayMcp` 发往 broker `/v1/mcp`。卡片中显示“已连接”并不直接授予所有 Bot 权限。

`connector-arguments.ts` 会根据 Schema 兼容部分模型参数形状，
`connector-tools-list.ts` 缓存同一后端上次成功的工具列表。
这些是官方的附加易用性措施；当前 DS-Bot 适配尚未逐项移植，也不能声称工具行为完全相同。
上游还支持一个应用连接多个账号；当前 DS-Bot 托管适配尚未验证执行时的显式账号绑定，
所以仍限制每个应用一个有效账号，避免把调用发到其他账号。这是当前适配器的限制，
不是对整个 Composio 协议能力的断言。

## 本轮落实的修正

- 以官方源码的服务划分为依据，加入 Whop、Agentcard 原生 MCP 目录。
- 为扩展应用加入有来源的 24 项内置目录；服务失败时仍可搜索浏览，但不能发起授权。
- 读取完整在线目录后再搜索并做本地分页，修复“第一页之外的应用搜不到”。
- 检查重复游标、停滞页和缺失条目，将不完整目录及真实请求错误传给界面。
- 保留原生连接器和 DSH 权限/审批；不复制上游本机账号、令牌、项目密钥。

## 尚未通过的真实验收

已有的实网探测得到官方域名的 Cloudflare 403/1010 或 Node 直连失败。
2026-11-08 21:34 JST 的只读复查中，Node 请求官方 `/health` 在八秒后超时；
Whop MCP 返回 401，Agentcard MCP 返回 405，说明后两个地址有 HTTP 响应，
不表示已通过 OAuth 或工具执行验收。
源码审查不能确定该拒绝的具体部署侧原因，也不能证明官方注册开放。
本轮协议夹具与隔离 DSH 能验证客户端逻辑；无法替代真实新账号 OAuth
及一次实际应用工具执行。Whop/Agentcard 的真实 OAuth 同样需单独验证。

如官方服务不接受当前客户端，要保持免用户项目密钥的体验，需要可用且允许接入的
同协议服务；若部署自己的 broker，项目密钥由服务部署者配置，不能再把它放回默认
用户连接流程。当前审查没有改动网络配置，也没有部署新的远端 broker。
