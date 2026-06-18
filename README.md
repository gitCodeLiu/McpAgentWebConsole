# MCP Agent Web Console

一个独立的 React + TypeScript Web 控制台，用来在浏览器里模拟 Agent 接入远端 HTTP MCP 或本机 stdio MCP、查看协议能力、发现工具并发起调用。

## 功能

- 通过本地代理连接 MCP HTTP endpoint。
- 通过本机 stdio relay 调试本地命令型 MCP Server。
- 在当前浏览器保存 MCP 配置，并按 `创建 → 初始化 → 开启 → 关闭 → 修改 → 删除` 管理生命周期。
- 执行 `initialize`，根据 `capabilities` 标记标准 MCP 协议接口是否可用。
- 显示并自动维护 `MCP-Session-Id`，可视化 `initialize`、`initialized`、`tools/list`、`enabled`、`closed` 生命周期状态。
- 通过 `tools/list` 读取工具列表，并用表单或 JSON 调用 `tools/call`。
- 在页面中配置 endpoint、client name、protocol version、headers 和默认工具参数。
- 统一 JSON 查看与编辑体验，支持折叠、格式化、压缩和复制。
- 内置本地 demo MCP endpoint，便于验证握手、工具发现和调用流程。

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

## Docker

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
| `POST /api/mcp-proxy` | 本地 HTTP 转发入口，用于规避浏览器跨域限制 |
| `DELETE /api/mcp-proxy` | 转发 HTTP MCP session termination 请求 |
| `POST /api/mcp-stdio` | 本机 stdio MCP relay，用于把本地命令型 MCP 转成页面可调试的 HTTP 请求 |

## 配置生命周期

配置保存在当前浏览器的 `localStorage`，不会写入服务器数据库，也不会跨浏览器同步。

| 动作 | 含义 |
|---|---|
| 保存 | 写入当前浏览器，出现在快速接入列表中 |
| 初始化 | 执行 `initialize`、`notifications/initialized` 和能力发现；完成后清理真实 session 或 stdio 进程，不进入可调用状态 |
| 开启 | 初始化并保持当前连接，进入可调用状态 |
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
- `/api/mcp-proxy` 是本地调试代理，只接受来自本机的请求，并且 CORS 只放行同端口的 `localhost` / `127.0.0.1` / `::1` 来源。
- `/api/mcp-stdio` 会在 Web Console 后端所在机器上启动本地命令，只接受本机且 Web Console 同源页面发起的请求。页面只有在本机同源访问时才展示本地 stdio 配置，例如 `http://127.0.0.1:8765` 或 `http://localhost:8765`；服务器部署场景的 stdio 管理功能后续开发。
- 调试不同 stdio MCP 时不需要重启 Web Console。直接在页面里修改 `Command`、`Arguments JSON`、`Working Directory` 后点击初始化或开启即可。
- 配置里的“保持连接”控制切换 MCP 时的行为：关闭时切到其他 MCP 会主动断开当前 stdio 进程或清理 HTTP session；开启时会保留当前连接，后续切回时尽量复用。
- 不要把启用了 stdio relay 的 Web Console 暴露到公网或共享网络；stdio 配置具备启动本地命令的能力。
- 代理会转发页面配置里的 headers，请不要在不可信浏览器或共享机器里保存长期有效密钥。
- 当前代理适合普通 JSON response 和单次 SSE JSON-RPC response 调试，不是完整的长连接 Streamable HTTP relay。

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
