# Contributing

感谢参与 MCP Agent Web Console。提交变更前，请先确认它仍然保持“独立连接任意 MCP HTTP endpoint”的定位，不把页面或文档绑定到某个具体 MCP Server。

## 本地开发

```bash
npm install
npm run dev
```

如果需要同源 `/api/*`，另起 Node 服务：

```bash
npm run serve
```

## 提交前检查

```bash
npm run test
npm run build
node --check server.mjs
```

## 设计原则

- 页面默认是通用 MCP Agent 控制台，不绑定具体服务。
- 协议接口和工具接口必须分开展示。
- 能力可用性以 `initialize.result.capabilities` 为准。
- 不要在浏览器端把 localStorage 描述为安全密钥库。
- 新手说明保持可发现，但不占据主操作区。
- 支持范围要如实表达；未实现 GET SSE 监听时，不宣称完整 Streamable HTTP Client。

## 文档要求

功能变更需要同步更新：

- `README.md`
- 如果新增用户可见配置，补充配置持久化和安全说明
