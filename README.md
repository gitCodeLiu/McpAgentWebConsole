# MCP Agent Web Console

一个独立的 React + TypeScript Web 控制台，用来在浏览器里模拟 MCP Client 连接 MCP Server、协商 capabilities、发现 Tools 并发起 JSON-RPC 调用。

## 功能

- 通过本地代理连接 Streamable HTTP MCP endpoint。
- 通过本机 stdio relay 调试本地命令型 MCP Server。
- 在当前浏览器保存 MCP Server 配置，并按 `创建 → 初始化 → 开启 → 关闭 → 修改 → 删除` 管理 Console 配置状态。
- 执行 `initialize`，根据 Server `capabilities` 标记 MCP 协议方法是否可由 Client 发起。
- 显示并自动维护 `MCP-Session-Id`，可视化 `initialize`、`initialized` notification、`tools/list`、operation、shutdown。
- 通过 `tools/list` 读取 Tools 列表，并用表单或 JSON 调用 `tools/call`。
- 在页面中配置 MCP endpoint、client name、protocol version、headers 和默认 Tool 参数。
- 统一 JSON 查看与编辑体验，支持折叠、格式化、压缩和复制。
- 内置本地 demo MCP endpoint，便于验证初始化、Tool 发现和调用流程。

## 安装

```bash
npm install
```

## 构建

```bash
npm run build
```

## 运行构建产物

```bash
npm run build
npm run serve
```

打开：

```text
http://127.0.0.1:8765/
```

局域网共享页面并允许同事使用 Streamable HTTP MCP 代理：

```bash
npm run serve -- --host 0.0.0.0 --port 8765 --allow-lan-proxy
```

`--allow-lan-proxy` 只放开 Streamable HTTP MCP 代理；`stdio` relay 仍只接受本机请求。

## Docker

Docker 镜像会运行同一个本地 Node HTTP server：前端静态文件、`/api/mcp-proxy`、`/api/mcp-stdio` 和 demo MCP 都由容器里的 `node server.mjs` 提供。

构建镜像：

```bash
docker build -t mcp-agent-web-console .
```

运行容器：

```bash
docker run --rm -p 8765:8765 mcp-agent-web-console
```

打开：

```text
http://127.0.0.1:8765/
```

Docker 场景下的 stdio transport 边界：

- `stdio transport` 会在容器内启动命令，不会直接启动宿主机上的命令。
- 如果要调试宿主机项目里的 stdio MCP，需要把对应目录挂载进容器，并在页面里填写容器内路径。
- 如果要直接调试宿主机已有命令或绝对路径，推荐使用本机 `npm run serve`，不要通过 Docker 间接访问。

示例：把当前项目挂载到容器内 `/workspace`，页面里的 `Working Directory` 可填写 `/workspace`。

```bash
docker run --rm -p 8765:8765 \
  -v "$PWD:/workspace" \
  mcp-agent-web-console
```

## 开发

```bash
npm run dev
```

Vite 会把 `/api/*` 代理到 `http://127.0.0.1:8765`。如果需要同源 API，请同时运行 Node 服务：

```bash
npm run serve
```

## Web 服务接口

| 接口 | 用途 |
|---|---|
| `GET /` | Web 控制台页面 |
| `GET /api/health` | Web 服务健康检查 |
| `GET /api/mcp-methods` | MCP 标准协议方法清单 |
| `POST /api/mcp` | 本地 demo MCP endpoint |
| `DELETE /api/mcp` | 结束本地 demo MCP session |
| `POST /api/mcp-proxy` | Streamable HTTP MCP 调试代理，用于规避浏览器跨域限制 |
| `DELETE /api/mcp-proxy` | 转发 Streamable HTTP session termination 请求 |
| `POST /api/mcp-stdio` | 本机 stdio relay，用于把本地 MCP Server 进程转成页面可调试的 HTTP 请求 |

## 官方能力支持范围

本项目定位是便捷的 MCP 调试控制台：优先按官方协议完成能力发现，并提供面向调试的调用入口。它不是完整 MCP Host，也不承诺覆盖所有 Client feature。

| 官方能力 | 当前支持 | 说明 |
|---|---|---|
| Lifecycle | 已支持 | 执行 `initialize`、`notifications/initialized`，进入 operation phase 后可调用；关闭时清理 session 或 stdio 进程 |
| Server capabilities | 已支持 | 使用 `initialize.result.capabilities` 标记当前 Server 声明的协议方法 |
| Tools | 已支持 | 支持 `tools/list`、Tool schema 表单、JSON arguments 和 `tools/call` |
| Resources | 能力入口调试 | Server 声明 `resources` 后显示 Resources 入口，可手工调用 `resources/list`、`resources/read` 等方法，暂未提供专用资源浏览器 |
| Prompts | 能力入口调试 | Server 声明 `prompts` 后显示 Prompts 入口，可手工调用 `prompts/list`、`prompts/get`，暂未提供专用 Prompt 浏览器 |
| Completion | 能力入口调试 | Server 声明 `completion/completions` 后显示 Completion 入口，可手工调用 `completion/complete`，暂未提供补全交互 UI |
| Logging | 能力入口调试 | Server 声明 `logging` 后显示 Logging 入口，可调用 `logging/setLevel`；暂未实现 server-to-client log message 长连接接收 |
| Roots / Sampling / Elicitation | 暂不支持 Client handler | 这些属于 Server 向 Client 发起的能力请求；当前控制台不声明这些 Client capabilities，也不实现对应 handler |
| Streamable HTTP POST | 部分支持 | 支持 JSON response 和单次 SSE JSON-RPC response |
| Streamable HTTP GET SSE | 暂不支持 | 暂未实现用于接收 Server 主动消息的 GET SSE 长连接与恢复 |
| stdio transport | 部分支持 | 本机同源页面可通过 relay 启动本机 MCP Server 进程；局域网访问不开放 stdio |

## Console 配置状态

配置保存在当前浏览器的 `localStorage`，不会写入服务器数据库，也不会跨浏览器同步。

这里的“开启/关闭”是 Web Console 对配置运行态的管理，不是 MCP 规范里的独立方法名；对应到底层 MCP lifecycle 时，开启会完成 initialization 并进入 operation phase，关闭会清理 session 或 stdio 进程。

| 动作 | 含义 |
|---|---|
| 保存 | 写入当前浏览器，出现在快速接入列表中 |
| 初始化 | 执行 `initialize`、`notifications/initialized` 和能力发现；完成后清理真实 session 或 stdio 进程，不进入 operation phase |
| 开启 | 初始化并保持当前连接，进入 operation phase |
| 关闭 | 清理当前 HTTP session 或 stdio 进程，并把配置标记为已关闭 |
| 修改 | 保存新参数；如果连接目标变化，会先尝试关闭旧连接 |
| 删除 | 删除浏览器本地配置，并先尝试关闭已保存配置对应的连接 |

刷新页面或重启 Web Console 后，之前的 `已开启` 状态会降级为 `已关闭`，避免页面显示已经丢失的运行态连接。

## 文档

- [文档索引](./docs/README.md)
- [MCP 协议知识手册](./docs/mcp-protocol-handbook.md)
- [Web Console 实现备注](./docs/web-console-implementation-notes.md)

## 安全边界

- 默认只建议绑定 `127.0.0.1`，不要把本服务直接暴露到公网或不可信局域网。
- `/api/mcp-proxy` 是 Streamable HTTP 调试代理，默认只接受来自本机的请求；如需局域网同事共同调试 Streamable HTTP MCP，可使用 `--allow-lan-proxy` 显式开启。
- `/api/mcp-stdio` 会在 Web Console 后端所在机器上启动本地命令，只接受本机且 Web Console 同源页面发起的请求。页面只有在本机同源访问时才展示 stdio transport 配置，例如 `http://127.0.0.1:8765` 或 `http://localhost:8765`；服务器部署场景的 stdio 管理功能后续开发。
- 调试不同 stdio MCP 时不需要重启 Web Console。直接在页面里修改 `Command`、`Arguments JSON`、`Working Directory` 后点击初始化或开启即可。
- 配置里的“保持连接”控制切换 MCP 时的行为：关闭时切到其他 MCP 会主动断开当前 stdio 进程或清理 HTTP session；开启时会保留当前连接，后续切回时尽量复用。
- 不要把启用了 stdio relay 的 Web Console 暴露到公网或共享网络；stdio 配置具备启动本地命令的能力。
- 代理会转发页面配置里的 headers，请不要在不可信浏览器或共享机器里保存长期有效密钥。
- 当前代理适合普通 JSON response 和单次 SSE JSON-RPC response 调试，尚未实现 Streamable HTTP 的 GET SSE 长连接能力。

## 目录结构

```text
.
├── docs/
├── src/
│   ├── App.tsx
│   ├── main.tsx
│   └── styles.css
├── server.mjs
├── index.html
├── package.json
├── vite.config.ts
└── README.md
```

## 检查

```bash
npm run test
npm run build
node --check server.mjs
```
