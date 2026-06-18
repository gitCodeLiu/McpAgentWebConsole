# 文档索引

这里存放当前独立项目的 MCP 协议背景、接入原则和实现约束。本文档集不绑定任何具体业务系统；外部 MCP Server 可以通过远端 HTTP endpoint 接入，本机命令型 MCP 可以在本机同源 Web Console 下通过 stdio relay 调试。

## 协议资料

- [MCP 协议知识手册](./mcp-protocol-handbook.md)：基于官方文档整理 MCP 的角色模型、生命周期、transport、tools/resources/prompts、会话和安全边界。

## 项目实现资料

- [Web Console 实现备注](./web-console-implementation-notes.md)：记录当前独立项目的实现原则、连接边界、安全注意事项和错误处理约定。

## 常用接入形态

### 远端 HTTP MCP

1. 在目标 MCP Server 侧准备 HTTP JSON-RPC endpoint，例如 `http://127.0.0.1:8000/mcp/`。
2. 在控制台打开配置管理，选择 `远端 HTTP`，填写目标 endpoint。
3. 填写目标服务需要的协议版本与 HTTP headers。
4. 保存配置后可先初始化验证能力，也可以直接开启进入可调用状态。

### 本地 stdio MCP

1. 确认 Web Console 是本机部署，并通过 `http://127.0.0.1:8765` 或同源 `localhost` 地址打开。
2. 在配置管理中选择 `本地 stdio`，填写 `Command`、`Arguments JSON` 和可选 `Working Directory`。
3. 点击初始化可只验证握手和能力发现；点击开启会保持本地 stdio 进程用于后续调用。
4. 关闭或删除配置时，控制台会尝试关闭对应 stdio 进程。

### 配置生命周期

配置保存在当前浏览器 `localStorage` 中。保存态和运行态分开管理：

- `已创建`：配置已保存，但没有完成能力发现。
- `已初始化`：完成 `initialize`、`initialized` 和能力发现；真实连接已清理，不可直接调用。
- `已开启`：当前连接保持中，可以调用协议或工具。
- `已关闭`：已清理 session 或 stdio 进程。
- `异常`：初始化、开启、关闭或调用过程中出现错误。
