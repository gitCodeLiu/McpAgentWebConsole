# MCP Agent Web Console

一个独立的 React + TypeScript Web 控制台，用来在浏览器里模拟 Agent 接入 MCP HTTP endpoint、查看协议能力、发现工具并发起调用。

## 功能

- 连接任意 MCP HTTP endpoint。
- 执行 `initialize`，根据 `capabilities` 标记标准 MCP 协议接口是否可用。
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
| `POST /api/mcp-proxy` | 本地 HTTP 转发入口，用于规避浏览器跨域限制 |

## 安全边界

- 默认只建议绑定 `127.0.0.1`，不要把本服务直接暴露到公网或不可信局域网。
- `/api/mcp-proxy` 是本地调试代理，只接受来自本机的请求，并且 CORS 只放行 `localhost` / `127.0.0.1` / `::1` 来源。
- 代理会转发页面配置里的 headers，请不要在不可信浏览器或共享机器里保存长期有效密钥。
- 当前代理适合普通 JSON response 和单次 SSE JSON-RPC response 调试，不是完整的长连接 Streamable HTTP relay。

## 目录结构

```text
.
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
