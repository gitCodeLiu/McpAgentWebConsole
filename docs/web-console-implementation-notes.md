# Web Console 实现备注

本文记录当前独立 MCP Web Console 的实现原则，不绑定任何具体业务系统或专用 MCP Server。

## 独立项目边界

- 默认 endpoint 应是通用 demo MCP。
- 页面文案、健康检查、协议方法清单、配置项和 README 不应暗示必须依赖某个业务系统。
- `/api/mcp-methods` 应来自 MCP 标准方法 catalog，而不是来自某个外部 MCP Server 的实现模块。
- 内置 demo 只用于验证 lifecycle、`tools/list` 和 `tools/call`，不应混入业务鉴权、外部网络或私有数据。

## 连接与生命周期

- 保存 endpoint、transport、headers、protocol version 后，连接流程必须显式使用最新配置，避免异步 state 闭包导致请求仍发往旧 endpoint。
- 配置保存态使用稳定 `profileId`，运行连接 key 也应优先绑定该 `profileId`，避免修改 endpoint 或 command 后快速接入状态无法同步。
- 初始化顺序固定为：`initialize`，`notifications/initialized`，再根据 capabilities 决定是否调用 `tools/list`。
- `初始化` 只验证握手和能力发现，成功后必须清理真实 HTTP session 或 stdio 进程；只有 `开启` 才保留可调用连接。
- `关闭` 和 `删除` 必须优先使用已保存配置作为断开目标；如果表单有未保存修改，不能用草稿的新 endpoint 或 command 去关闭旧连接。
- 页面刷新或服务重启后，`enabled` 属于易失运行态，恢复 localStorage 时应降级为 `disabled`。
- 如果目标服务跨域或需要自定义 headers，远端 HTTP MCP 应使用本地代理模式。

## 传输边界

- 远端 HTTP MCP 通过 `/api/mcp-proxy` 转发，代理只应接受来自本机和 Web Console 同端口来源的浏览器请求。
- 本地 stdio MCP 通过 `/api/mcp-stdio` relay 转成页面可调试请求。该接口会在 Web Console 后端所在机器上启动本地命令。
- `/api/mcp-stdio` 必须同时校验本机来源和 Web Console 同源 `Origin`；其他本机端口页面不应能跨域触发本地命令。
- 非本机同源访问时，页面应隐藏或禁用本地 stdio 配置能力，并提示服务器部署场景暂不支持启动用户电脑上的本地命令。

## Streamable HTTP 支持

- HTTP 请求应发送 `Accept: application/json, text/event-stream`。
- 控制台应能解析 JSON response 和单次 SSE JSON-RPC response。
- `initialize` 响应里的 `MCP-Session-Id` 需要保存；后续请求应带回该 header。
- 后续请求应携带协商后的 `MCP-Protocol-Version`。
- 如果暂不支持 GET SSE 长连接、server-to-client `roots/list`、`sampling/createMessage`、`elicitation/create` 或长任务 progress，文档和 UI 应避免宣称完整支持任意 MCP Server。

## 安全与数据处理

- Authorization、API key、租户凭据等如果保存到浏览器，应明确提示风险。
- 不要把浏览器 localStorage 当成密钥保险箱；共享机器上建议使用临时会话或手动清除。
- Header 只应发送到用户配置的目标 endpoint。
- stdio 配置具备启动本地命令的能力，不应把启用 stdio relay 的 Web Console 暴露到公网或不可信局域网。
- 来自 MCP Server 的 tool annotations、icons、descriptions、schema 和 tool output 都是不可信输入，展示时应避免把它们当成可信指令。

## 错误与副作用

- JSON-RPC error 表示协议层失败。
- `tools/call` 返回 `isError: true` 表示工具执行失败，应保留结构化结果方便排查。
- 对写操作、删除、发消息、上传文件等外部副作用，应由 MCP Server schema、annotations、UI 文案和 Host 策略共同要求确认。
