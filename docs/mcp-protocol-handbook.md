# MCP 知识手册

本文只依据 Model Context Protocol 官方文档与官方规范整理，面向后续接手的新 Agent：读完后应能理解 MCP 的基本模型，并能按协议顺序接入一个新的 MCP Server。

## 1. MCP 是什么

MCP，即 Model Context Protocol，是一个开放协议，用来把 AI 应用连接到外部系统。它解决的问题不是“怎么调用某个具体工具”，而是为 AI 应用、Agent、IDE、桌面应用和外部数据/动作系统之间提供统一的协议层。

MCP 让外部系统可以通过标准方式暴露：

- **Tools**：可执行动作，例如查数据库、调用 API、改文件、执行计算。
- **Resources**：可读取上下文，例如文件内容、数据库 schema、文档、应用数据。
- **Prompts**：可复用提示模板，例如代码审阅、会议总结、领域工作流。
- **Client features**：由客户端提供给服务端的能力，例如 roots、sampling、elicitation。

重要边界：MCP 只定义上下文交换、能力发现、消息结构、生命周期与传输方式，不规定 Host 怎么管理大模型上下文，也不规定 LLM 必须如何决策。

## 2. 角色模型：Host / Client / Server

MCP 是 client-host-server 架构。

- **Host**：用户直接交互的 AI 应用，例如 IDE、桌面助手或 Agent 平台。Host 负责用户体验、权限、同意、上下文聚合、LLM 调用和多个 server 的协调。
- **Client**：Host 为每一个 MCP Server 创建的协议连接组件。一个 client 对应一个 server，维护一个独立会话，负责初始化、能力协商、消息路由、订阅和通知。
- **Server**：提供特定上下文和能力的程序，可以是本地进程，也可以是远程服务。Server 通过 MCP 暴露 tools、resources、prompts 等能力，也可以在客户端支持时向 client 请求 sampling、roots、elicitation。

一个 Host 可以同时管理多个 Client；每个 Client 与一个 Server 建立 1:1 连接。Server 之间默认隔离，Server 不应看到完整对话，也不应看到其他 Server 的内部上下文；跨 Server 的组合由 Host 控制。

## 3. 协议分层

MCP 有两层：

- **Data layer**：基于 JSON-RPC 2.0 的消息协议，定义 request、response、notification、lifecycle、capabilities、tools、resources、prompts、roots、sampling、elicitation 等语义。
- **Transport layer**：定义消息如何传输，包括 stdio 与 Streamable HTTP。自定义 transport 可以存在，但必须保留 MCP 的 JSON-RPC 消息格式和生命周期要求。

所有实现都必须支持基础协议和生命周期管理；其他组件按需要实现，并通过 capability negotiation 声明。

## 4. Transport：stdio、Streamable HTTP、SSE

### stdio

stdio 面向本地进程通信：

- Client 启动 MCP Server 子进程。
- Client 写 Server 的 `stdin`，Server 写 `stdout`。
- 每条消息是一个 JSON-RPC request、response 或 notification。
- 消息以换行分隔，消息内部不能包含嵌入换行。
- Server 可以把日志写到 `stderr`；Client 可以捕获、转发或忽略 `stderr`，不应把所有 `stderr` 都视为错误。
- `stdout` 只能输出有效 MCP 消息；`stdin` 也只能写有效 MCP 消息。

### Streamable HTTP

Streamable HTTP 是当前标准远程传输方式：

- Server 提供一个 MCP endpoint，例如 `https://example.com/mcp`。
- Client 对每个 JSON-RPC 消息发起新的 HTTP `POST`。
- Client 的 `Accept` 应包含 `application/json` 和 `text/event-stream`。
- 如果请求是 JSON-RPC request，Server 可以返回一个 JSON response，也可以返回 `text/event-stream` 并通过 SSE 流式发送多条消息。
- Client 也可以用 HTTP `GET` 打开 SSE 流，接收 Server 主动发来的 request 或 notification。
- HTTP transport 支持会话：Server 可以在 initialize 响应头里返回 `MCP-Session-Id`；之后 Client 必须在后续请求携带该 header。
- HTTP 后续请求必须携带协商后的 `MCP-Protocol-Version` header。
- 本地 HTTP Server 应绑定 localhost；Server 必须校验 `Origin` 防 DNS rebinding，远程/敏感服务应有鉴权。

### SSE 的历史与兼容位置

不要把 SSE 误认为当前独立的第三种标准 transport。当前标准 transport 是：

1. stdio
2. Streamable HTTP

SSE 在当前规范中有两个位置：

- 作为 Streamable HTTP 内部的可选流式机制，用于 POST 返回流式响应或 GET 监听 Server 消息。
- 作为历史兼容：Streamable HTTP 替代了 `2024-11-05` 版本的旧 HTTP+SSE transport。需要兼容旧 Server 时，Client 可以先对用户给的 URL 发送 `InitializeRequest`；若返回 400/404/405，再尝试 GET 并期待旧 SSE transport 的 `endpoint` event。

## 5. Lifecycle：必须先 initialize

MCP 是有状态协议，连接必须按生命周期进行。

### 阶段

1. **Initialization**：协议版本协商、能力协商、双方实现信息交换。
2. **Operation**：按协商后的能力正常通信。
3. **Shutdown**：通过底层 transport 关闭连接；stdio 通常关闭输入流并等待子进程退出，HTTP 关闭连接/会话。

### 初始化顺序

1. Client 首先发送 `initialize` request，包含：
   - `protocolVersion`
   - `capabilities`
   - `clientInfo`
2. Server 返回 `InitializeResult`，包含：
   - 协商后的 `protocolVersion`
   - Server `capabilities`
   - `serverInfo`
   - 可选 `instructions`
3. Client 成功收到 initialize response 后，必须发送 `notifications/initialized`。
4. 进入 operation 阶段后，双方只能使用已协商能力。

初始化前的限制：

- Client 在收到 Server 的 initialize response 前，不应发送除 `ping` 以外的请求。
- Server 在收到 `notifications/initialized` 前，不应发送除 `ping` 和 logging 外的请求/通知。
- 不能未 initialize 就调用 `tools/list`、`resources/list`、`prompts/list` 等能力方法。

### 版本协商

Client 在 `initialize` 里发送自己支持的协议版本，通常应发送最新支持版本。Server 支持该版本就返回同版本；否则返回它支持的另一版本。Client 不支持 Server 返回版本时，应断开连接。

HTTP transport 下，initialize 之后的后续请求还应带上 `MCP-Protocol-Version: <negotiated-version>`。

### 能力协商

Capabilities 决定本会话可以用什么。常见能力：

- Client：`roots`、`sampling`、`elicitation`、`tasks`、`experimental`
- Server：`tools`、`resources`、`prompts`、`logging`、`completions`、`tasks`、`experimental`

能力对象可以带子能力，例如：

- `listChanged`：tools/resources/prompts/root 列表变化通知。
- `subscribe`：resources 是否支持订阅单个资源变化。
- `sampling.tools`：sampling 请求中是否允许模型使用工具。
- `elicitation.form` / `elicitation.url`：client 支持哪种用户信息收集模式。

## 6. 基础协议

MCP 消息必须遵守 JSON-RPC 2.0。

### Request

Request 用于发起操作，双方都可以发送。必须包含：

- `jsonrpc: "2.0"`
- `id`：字符串或整数，不能是 `null`，同一 session 内请求方不能重复使用。
- `method`
- 可选 `params`

### Response

Response 只回复 request。成功响应包含相同 `id` 和 `result`；失败响应包含相同 `id` 和 `error`。错误对象至少包含整数 `code` 与字符串 `message`，可带 `data`。

### Notification

Notification 是单向消息，不能包含 `id`，接收方不能回复。例如 `notifications/initialized`、`notifications/progress`、`notifications/tools/list_changed`。

### Ping

`ping` 是可选健康检查机制，但接收方收到 `ping` request 后必须尽快返回空 result。双方都可以发起。超时可视为连接不可用，并触发重连或关闭。

### Cancellation

取消通过 `notifications/cancelled` notification 表达。它引用同方向已发起且仍在进行中的请求 ID，可带 `reason`。Client 不能取消 `initialize`。接收方应尽量停止处理并释放资源，但也可以在请求已完成或不可取消时忽略。

### Progress

长耗时请求可以通过 `_meta.progressToken` 请求进度通知。接收方可发送 `notifications/progress`，包含 `progressToken`、递增的 `progress`、可选 `total` 和可选 `message`。进度通知不等于最终响应，最终仍要按 request/response 结束。

### Logging

Logging 是 Server capability。Server 声明 `logging` 后，可以通过 `notifications/message` 向 Client 发结构化日志；Client 可以用 `logging/setLevel` 设置最小日志级别。日志级别遵循 syslog 风格：`debug`、`info`、`notice`、`warning`、`error`、`critical`、`alert`、`emergency`。日志不能包含凭证、密钥、PII 或有助攻击的内部细节。

### Pagination

`tools/list`、`resources/list`、`resources/templates/list`、`prompts/list` 等 list 操作可能分页。分页使用不透明 `cursor`，Server 决定页大小；Client 不能假设固定页大小。响应有 `nextCursor` 时，Client 应继续带 cursor 拉取下一页。

### Schema

官方规范的消息结构以 TypeScript schema 为事实源，并提供自动生成的 JSON Schema。MCP 中的 schema 默认使用 JSON Schema 2020-12；没有 `$schema` 时按 2020-12 处理。实现至少必须支持 2020-12，并优雅处理不支持的显式 dialect。

## 7. Server 能力

Server 能力都不是基础协议之外的“必选项”。一个 MCP Server 不一定有 tools，也不一定有 resources 或 prompts；Client 必须先看 initialize 返回的 capabilities。

### Tools

用途：让模型执行动作。Tools 是 model-controlled：模型可以基于上下文自动决定调用，但 Host/Client 应提供用户可见性和敏感操作确认。

声明能力：

```json
{"capabilities":{"tools":{"listChanged":true}}}
```

发现与调用：

- `tools/list`：列出工具，支持 pagination。
- `tools/call`：调用工具。
- `notifications/tools/list_changed`：工具列表变化通知，仅在声明 `listChanged` 时使用。

Tool 定义重点：

- `name`：Server 内唯一，建议 1-128 字符，大小写敏感，只使用字母、数字、下划线、连字符、点。
- `title`：可选展示名。
- `description`：说明用途。
- `inputSchema`：参数 JSON Schema，必须是有效 object。无参数工具推荐 `{ "type": "object", "additionalProperties": false }`。
- `outputSchema`：可选结构化输出 schema。
- `annotations` 与 `execution`：可选元信息，Client 不应无条件信任来自不可信 Server 的 annotations。

错误处理：

- 协议错误：未知工具、请求结构错误、Server 内部错误，返回 JSON-RPC error。
- 工具执行错误：业务失败、输入校验失败、外部 API 失败，通常返回 tool result 且 `isError: true`。Client 应把 tool execution error 提供给模型用于自我修正。

### Resources

用途：让 Server 向 Client 暴露可读上下文。Resources 是 application-driven，Host/Client 决定如何展示、选择、检索并放入模型上下文。

声明能力：

```json
{"capabilities":{"resources":{"subscribe":true,"listChanged":true}}}
```

发现与读取：

- `resources/list`：列出固定资源，支持 pagination。
- `resources/templates/list`：列出参数化资源模板。
- `resources/read`：按 URI 读取资源内容。
- `resources/subscribe` / `resources/unsubscribe`：订阅或取消订阅资源变化，仅在 `subscribe` 为 true 时使用。
- `notifications/resources/list_changed`：资源列表变化。
- `notifications/resources/updated`：订阅资源变化。

Resource 定义重点：

- `uri`：资源唯一标识。
- `name`、`title`、`description`、`mimeType`、`size`、`icons`：展示与处理元信息。
- 内容可以是 text，也可以是 base64 blob。

常见 URI scheme 包括 `https://`、`file://`、`git://` 和自定义 scheme。Client 必须把资源内容和 URI 当作不可信输入处理。

### Prompts

用途：Server 暴露可复用提示模板。Prompts 是 user-controlled：通常由用户显式选择，例如 slash command、命令面板、菜单。

声明能力：

```json
{"capabilities":{"prompts":{"listChanged":true}}}
```

发现与获取：

- `prompts/list`：列出 prompt，支持 pagination。
- `prompts/get`：获取某个 prompt，可传 arguments。
- `notifications/prompts/list_changed`：prompt 列表变化。

Prompt 定义重点：

- `name`、`title`、`description`、`arguments`、`icons`
- `prompts/get` 返回 `messages`，message 角色为 `user` 或 `assistant`，content 可为 text、image、audio 或 embedded resource。

Server 应校验 prompt 参数；Client 应处理分页和能力协商。

### Completion

用途：Server 为 prompt 参数或 resource template 参数提供自动补全建议。

声明能力：

```json
{"capabilities":{"completions":{}}}
```

调用：

- `completion/complete`

请求里用 `ref` 指明补全目标：

- `ref/prompt`：按 prompt name。
- `ref/resource`：按 resource template URI。

返回 `completion.values`，最多 100 项，可带 `total` 和 `hasMore`。Client 应 debounce 高频请求、缓存结果并优雅处理缺失结果。

### Logging

见基础协议中的 Logging。注意它是 Server capability：Server 要发送日志通知，必须声明 `logging`。

## 8. Client 能力

Client 能力是 Host/Client 提供给 Server 的能力。Server 只有在 Client 初始化时声明对应 capability 后，才应请求这些方法。

### Roots

用途：Client 告诉 Server 当前文件系统工作范围。Roots 是协调机制，不是安全边界；真正安全要靠 OS 权限、沙箱和 Host 策略。

声明能力：

```json
{"capabilities":{"roots":{"listChanged":true}}}
```

Server 请求：

- `roots/list`：Server 向 Client 请求 root 列表。
- `notifications/roots/list_changed`：Client 通知 roots 变化。

Root 当前必须是 `file://` URI，可带可读 `name`。Server 应尊重 root 边界并处理 root 不可用。

### Sampling

用途：Server 请求 Client 代为调用 LLM。这样 Server 不需要自己的模型 API key，Client 仍控制模型选择、权限、审查和用户同意。

声明能力：

```json
{"capabilities":{"sampling":{}}}
```

若支持 sampling 内部工具使用：

```json
{"capabilities":{"sampling":{"tools":{}}}}
```

Server 请求：

- `sampling/createMessage`

请求可包含 `messages`、`modelPreferences`、`systemPrompt`、`maxTokens`，也可在 Client 声明 `sampling.tools` 时包含 `tools` 与 `toolChoice`。模型偏好是建议而非强制，Client 最终决定模型。

安全要点：

- Client 应让用户能审查、拒绝或编辑 sampling 请求。
- Server 不能向未声明 `sampling.tools` 的 Client 发送带 tools 的 sampling 请求。
- tool result message 不能混入 text/image/audio 等其他内容；每个 tool_use 都必须有对应 tool_result 后才能继续。

### Elicitation

用途：Server 在执行过程中通过 Client 向用户补充询问信息。

声明能力：

```json
{"capabilities":{"elicitation":{"form":{},"url":{}}}}
```

空对象兼容旧行为，等价于只支持 form mode：

```json
{"capabilities":{"elicitation":{}}}
```

Server 请求：

- `elicitation/create`

两种模式：

- `form`：通过 Client 内嵌表单收集结构化数据，必须带 `requestedSchema`。适合非敏感信息。
- `url`：把用户引导到外部 URL 做敏感或安全交互，例如认证、支付、输入密钥。敏感信息不能经 form mode 传给 MCP Client。

Client 必须清楚展示哪个 Server 在请求信息、为什么请求、将如何使用；必须提供拒绝/取消入口。URL mode 必须显示目标域名并取得用户同意后再跳转。

## 9. 一个 MCP Server 必须具备什么

最小 MCP Server 必须：

- 支持一种 transport：stdio、Streamable HTTP 或自定义 transport。
- 使用有效 JSON-RPC 2.0 消息。
- 支持 lifecycle：处理 `initialize`，返回协议版本、capabilities、serverInfo；等待 `notifications/initialized` 后进入正常操作。
- 遵守能力协商：只提供已声明能力对应的方法；对未支持方法返回合适错误，例如 `-32601 Method not found`。
- 对请求返回 response，对 notification 不返回 response。
- 处理 request id、错误对象、超时/取消等基础协议语义。
- 如果收到 `ping`，返回空 result。
- 按 transport 规则处理消息边界、HTTP header、session、stdout/stderr 等。

它不必须具备：

- tools
- resources
- prompts
- completions
- logging
- roots/sampling/elicitation 支持
- SSE streaming
- resource subscription
- listChanged notifications

但一旦声明某能力，就必须按对应规范支持该能力的协议方法或通知行为。

## 10. 新 Agent 接入一个新 MCP Server 的流程

### 10.1 先确认 transport

1. 如果是本地命令/脚本：按 stdio 启动子进程，建立 stdin/stdout 通道。
2. 如果是远程 URL：优先按 Streamable HTTP endpoint 处理。
3. 如果用户提供的是旧 SSE endpoint：先尝试 Streamable HTTP initialize；若 400/404/405，再按旧 HTTP+SSE 兼容流程探测。
4. 如果只是普通 REST API，不是 MCP endpoint，不要直接当 MCP Server；需要适配层。

### 10.2 initialize

发送 `initialize`：

- `protocolVersion` 使用本 Client 支持的最新版本。
- `capabilities` 只声明本 Client 真实支持的能力，例如没有 UI 就不要声明 elicitation；没有 LLM 调用通道就不要声明 sampling。
- `clientInfo` 写清 name/version。

收到 response 后：

- 校验 `protocolVersion` 是否兼容。
- 保存 `serverInfo`、`instructions`、`capabilities`。
- HTTP 下保存 `MCP-Session-Id`，后续请求带上 `MCP-Session-Id` 和 `MCP-Protocol-Version`。
- 发送 `notifications/initialized`。

### 10.3 发现能力

只对已声明的能力做发现：

- 有 `tools`：调用 `tools/list`，按 `nextCursor` 翻页。
- 有 `resources`：调用 `resources/list` 和 `resources/templates/list`，按 `nextCursor` 翻页。
- 有 `prompts`：调用 `prompts/list`，按 `nextCursor` 翻页。
- 有 `completions`：在用户填写 prompt/resource template 参数时按需调用 `completion/complete`。
- 有 `logging`：可调用 `logging/setLevel`，并准备接收 `notifications/message`。
- 不支持某能力：UI 或 Agent 状态应显示“Server 未声明”，不要调用对应方法。

### 10.4 调用 tools

1. 从 `tools/list` 中取真实 `name`，不要猜测工具名。
2. 按 `inputSchema` 生成参数表单或 JSON 参数。
3. 对敏感工具调用做用户确认。
4. 调用 `tools/call`。
5. 区分两类错误：
   - JSON-RPC error：协议或请求结构问题，通常不要盲目重试。
   - `result.isError: true`：工具执行错误，可把内容反馈给模型，让模型修正参数后再试。
6. 若有 `outputSchema`，Client 应校验 `structuredContent`。

### 10.5 读取 resources

1. 先 list/template list。
2. 用户或 Host 决定需要哪些 URI。
3. 调 `resources/read`。
4. text/blob 按 MIME 类型处理。
5. 对大列表、动态资源、订阅变化按 capability 处理。

### 10.6 使用 prompts

1. `prompts/list` 发现模板。
2. 用户显式选择 prompt。
3. 根据 `arguments` 填参数；如支持 `completions`，可补全。
4. `prompts/get` 获取 messages。
5. Host 决定如何放入 LLM 对话。

### 10.7 处理 Server 请求 Client

当 Server 向 Client 发送 request：

- `roots/list`：只有声明 roots 时才应响应；返回当前 file roots。
- `sampling/createMessage`：只有声明 sampling 时才处理；应有人审查、模型选择、权限控制。
- `elicitation/create`：只有声明 elicitation 对应 mode 时才处理；form 不收敏感信息，url 要展示目标域名并征得同意。

未声明或未实现的方法应返回 JSON-RPC error，例如 `-32601 Method not found`，不要静默吞掉。

### 10.8 处理通知与动态变化

- `notifications/tools/list_changed`：重新 `tools/list`。
- `notifications/resources/list_changed`：重新 `resources/list` / `resources/templates/list`。
- `notifications/resources/updated`：重新 read 或提示用户资源变化。
- `notifications/prompts/list_changed`：重新 `prompts/list`。
- `notifications/progress`：更新 UI 进度，不当成最终结果。
- `notifications/message`：展示或记录日志。
- `notifications/cancelled`：停止对应请求处理。

### 10.9 关闭

- stdio：关闭子进程输入流，等待退出；超时后 SIGTERM，再超时 SIGKILL。
- HTTP：关闭连接；若有 session 且不再使用，可按规范发送 DELETE 带 `MCP-Session-Id`，Server 也可能返回 405。

## 11. 常见误区

- **把工具接口和协议接口混为一谈**：`tools/list` / `tools/call` 是 MCP 协议方法；某个具体 tool 的 name 和 arguments 是 Server 暴露的业务接口。
- **未 initialize 就调用 tools/list**：违反 lifecycle。先 initialize，收到 response，再发 `notifications/initialized`，然后根据 capabilities 决定能否 list。
- **假设所有 Server 都有 tools**：错误。Server 可以只有 resources、只有 prompts，甚至只做其他能力。必须看 capabilities。
- **把 SSE 当成当前独立 transport**：当前标准 transport 是 stdio 与 Streamable HTTP；SSE 是 Streamable HTTP 可选流式机制，也是旧 HTTP+SSE 的兼容路径。
- **把 roots 当安全边界**：roots 是协调范围，不是强制沙箱。安全要靠 Host、OS 权限和沙箱。
- **把 logging 当基础必有能力**：Server 要发 `notifications/message` 必须声明 `logging`。
- **忽略 pagination**：list 返回可能有 `nextCursor`，必须循环拉取。
- **把 tool execution error 当协议错误**：`isError: true` 是工具执行结果，和 JSON-RPC error 不同。
- **在 form elicitation 里索要密钥**：敏感信息必须用 URL mode 等不经 MCP Client 的方式处理。
- **相信不可信 annotations/icons/output**：来自 Server 的 metadata 和 content 都应按不可信输入处理。

## 12. 官方文档链接清单

### Getting started / Learn

- [What is the Model Context Protocol (MCP)?](https://modelcontextprotocol.io/docs/getting-started/intro)
- [Architecture overview](https://modelcontextprotocol.io/docs/learn/architecture)
- [Understanding MCP servers](https://modelcontextprotocol.io/docs/learn/server-concepts)
- [Understanding MCP clients](https://modelcontextprotocol.io/docs/learn/client-concepts)
- [Versioning](https://modelcontextprotocol.io/docs/learn/versioning)
- [Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server)
- [Build an MCP client](https://modelcontextprotocol.io/docs/develop/build-client)
- [Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)
- [Connect to remote MCP Servers](https://modelcontextprotocol.io/docs/develop/connect-remote-servers)
- [MCP Inspector](https://modelcontextprotocol.io/docs/tools/inspector)
- [Debugging](https://modelcontextprotocol.io/docs/tools/debugging)

### Specification 2025-11-25

- [Specification index](https://modelcontextprotocol.io/specification/2025-11-25/index)
- [Architecture](https://modelcontextprotocol.io/specification/2025-11-25/architecture/index)
- [Base protocol overview](https://modelcontextprotocol.io/specification/2025-11-25/basic/index)
- [Lifecycle](https://modelcontextprotocol.io/specification/2025-11-25/basic/lifecycle)
- [Transports](https://modelcontextprotocol.io/specification/2025-11-25/basic/transports)
- [Authorization](https://modelcontextprotocol.io/specification/2025-11-25/basic/authorization)
- [Ping](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/ping)
- [Cancellation](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/cancellation)
- [Progress](https://modelcontextprotocol.io/specification/2025-11-25/basic/utilities/progress)
- [Roots](https://modelcontextprotocol.io/specification/2025-11-25/client/roots)
- [Sampling](https://modelcontextprotocol.io/specification/2025-11-25/client/sampling)
- [Elicitation](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation)
- [Server features overview](https://modelcontextprotocol.io/specification/2025-11-25/server/index)
- [Tools](https://modelcontextprotocol.io/specification/2025-11-25/server/tools)
- [Resources](https://modelcontextprotocol.io/specification/2025-11-25/server/resources)
- [Prompts](https://modelcontextprotocol.io/specification/2025-11-25/server/prompts)
- [Completion](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/completion)
- [Logging](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/logging)
- [Pagination](https://modelcontextprotocol.io/specification/2025-11-25/server/utilities/pagination)
- [Schema Reference](https://modelcontextprotocol.io/specification/2025-11-25/schema)
