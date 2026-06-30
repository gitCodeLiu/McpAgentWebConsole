#!/usr/bin/env node
import {spawn} from 'node:child_process';
import {createReadStream, existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {createServer} from 'node:http';
import {extname, join, relative, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));
const webRoot = existsSync(join(projectRoot, 'dist', 'index.html')) ? join(projectRoot, 'dist') : projectRoot;
const defaultHost = '127.0.0.1';
const defaultPort = 8765;
const defaultProtocolVersion = '2025-11-25';
const supportedProtocolVersions = new Set([defaultProtocolVersion, '2025-06-18', '2025-03-26', '2024-11-05']);
const demoSession = {initializeSeen: false, initialized: false, protocolVersion: defaultProtocolVersion, sessionId: ''};
const stdioSessions = new Map();
const stdioIdleMs = 10 * 60 * 1000;

const standardMcpMethods = [
  {method: 'initialize', kind: 'request', direction: 'client_to_server', category: 'lifecycle', description: '初始化 MCP 会话，协商协议版本和能力。'},
  {method: 'notifications/initialized', kind: 'notification', direction: 'client_to_server', category: 'lifecycle', description: '客户端通知服务端初始化已完成。'},
  {method: 'ping', kind: 'request', direction: 'bidirectional', category: 'base', description: '健康检查；任一方都可发送。'},
  {method: 'notifications/cancelled', kind: 'notification', direction: 'bidirectional', category: 'base', description: '取消先前发出的请求。'},
  {method: 'notifications/progress', kind: 'notification', direction: 'bidirectional', category: 'base', description: '长任务进度通知。'},
  {method: 'logging/setLevel', kind: 'request', direction: 'client_to_server', category: 'logging', description: '客户端设置服务端日志级别。'},
  {method: 'notifications/message', kind: 'notification', direction: 'server_to_client', category: 'logging', description: '服务端向客户端发送日志消息。'},
  {method: 'tools/list', kind: 'request', direction: 'client_to_server', category: 'tools', description: '列出 Server 暴露的 Tools。'},
  {method: 'tools/call', kind: 'request', direction: 'client_to_server', category: 'tools', description: '调用 Server 暴露的 Tool。'},
  {method: 'notifications/tools/list_changed', kind: 'notification', direction: 'server_to_client', category: 'tools', description: 'Server 通知 Tools 列表变化。'},
  {method: 'resources/list', kind: 'request', direction: 'client_to_server', category: 'resources', description: '列出 Server 暴露的 Resources。'},
  {method: 'resources/read', kind: 'request', direction: 'client_to_server', category: 'resources', description: '读取指定 Resource URI。'},
  {method: 'resources/templates/list', kind: 'request', direction: 'client_to_server', category: 'resources', description: '列出 Server 暴露的 Resource templates。'},
  {method: 'resources/subscribe', kind: 'request', direction: 'client_to_server', category: 'resources', description: '订阅资源更新通知。'},
  {method: 'resources/unsubscribe', kind: 'request', direction: 'client_to_server', category: 'resources', description: '取消资源更新订阅。'},
  {method: 'notifications/resources/list_changed', kind: 'notification', direction: 'server_to_client', category: 'resources', description: '服务端通知资源列表变化。'},
  {method: 'notifications/resources/updated', kind: 'notification', direction: 'server_to_client', category: 'resources', description: '服务端通知已订阅资源更新。'},
  {method: 'prompts/list', kind: 'request', direction: 'client_to_server', category: 'prompts', description: '列出 Server 暴露的 Prompts。'},
  {method: 'prompts/get', kind: 'request', direction: 'client_to_server', category: 'prompts', description: '获取指定 Prompt。'},
  {method: 'notifications/prompts/list_changed', kind: 'notification', direction: 'server_to_client', category: 'prompts', description: 'Server 通知 Prompts 列表变化。'},
  {method: 'completion/complete', kind: 'request', direction: 'client_to_server', category: 'completion', description: '请求 Prompt 或 Resource template 参数补全。'},
  {method: 'roots/list', kind: 'request', direction: 'server_to_client', category: 'roots', description: '服务端向客户端请求 roots 列表。'},
  {method: 'notifications/roots/list_changed', kind: 'notification', direction: 'client_to_server', category: 'roots', description: '客户端通知 roots 列表变化。'},
  {method: 'sampling/createMessage', kind: 'request', direction: 'server_to_client', category: 'sampling', description: '服务端请求客户端/模型生成消息。'},
  {method: 'elicitation/create', kind: 'request', direction: 'server_to_client', category: 'elicitation', description: '服务端请求客户端向用户收集结构化输入。'}
];

const mimeTypes = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.mjs', 'text/javascript; charset=utf-8'],
  ['.ts', 'text/plain; charset=utf-8'],
  ['.tsx', 'text/plain; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.json', 'application/json; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
  ['.png', 'image/png'],
  ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'],
  ['.webp', 'image/webp'],
  ['.ico', 'image/x-icon']
]);

const host = readArg('--host') || process.env.MCP_AGENT_WEB_HOST || defaultHost;
const port = Number(readArg('--port') || process.env.MCP_AGENT_WEB_PORT || defaultPort);
const allowLanProxy = readFlag('--allow-lan-proxy') || isEnabled(process.env.MCP_AGENT_WEB_ALLOW_LAN_PROXY);

const server = createServer((req, res) => {
  void handleRequest(req, res).catch((error) => {
    sendErrorJson(req, res, 500, 'INTERNAL_ERROR', error instanceof Error ? error.message : String(error));
  });
});

server.listen(port, host, () => {
  console.log(`MCP Agent HTTP console: http://${host}:${port}`);
  if (allowLanProxy) console.log('LAN Streamable HTTP MCP proxy: enabled');
});

async function handleRequest(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || `${host}:${port}`}`);
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(req));
    res.end();
    return;
  }
  if (req.method === 'GET') {
    await handleGet(req, res, url);
    return;
  }
  if (req.method === 'POST') {
    await handlePost(req, res, url);
    return;
  }
  if (req.method === 'DELETE') {
    await handleDelete(req, res, url);
    return;
  }
  sendErrorJson(req, res, 405, 'METHOD_NOT_ALLOWED', '请求方法不支持');
}

async function handleGet(req, res, url) {
  if (url.pathname === '/') {
    await sendStatic(req, res, join(webRoot, 'index.html'));
    return;
  }
  if (url.pathname === '/api/health') {
    sendJson(req, res, {ok: true, server: 'mcp-agent-console'});
    return;
  }
  if (url.pathname === '/api/mcp-methods') {
    const methods = protocolMethodsStatus();
    sendJson(req, res, {
      ok: true,
      count: methods.length,
      supported_count: methods.filter((item) => item.supported).length,
      methods
    });
    return;
  }
  if (url.pathname.startsWith('/assets/') || url.pathname.startsWith('/static/')) {
    const staticPath = url.pathname.startsWith('/static/')
      ? url.pathname.slice('/static/'.length)
      : url.pathname.slice(1);
    await sendStatic(req, res, join(webRoot, staticPath));
    return;
  }
  sendErrorJson(req, res, 404, 'NOT_FOUND', '接口不存在');
}

async function handlePost(req, res, url) {
  if (url.pathname === '/api/mcp') {
    await handleDemoMcpRequest(req, res);
    return;
  }
  if (url.pathname === '/api/mcp-proxy') {
    await handleMcpProxy(req, res);
    return;
  }
  if (url.pathname === '/api/mcp-stdio') {
    await handleMcpStdio(req, res);
    return;
  }
  sendErrorJson(req, res, 404, 'NOT_FOUND', '接口不存在');
}

async function handleDelete(req, res, url) {
  if (url.pathname === '/api/mcp') {
    handleDemoMcpTerminate(req, res);
    return;
  }
  if (url.pathname === '/api/mcp-proxy') {
    await handleMcpProxyTerminate(req, res);
    return;
  }
  sendErrorJson(req, res, 404, 'NOT_FOUND', '接口不存在');
}

async function handleDemoMcpRequest(req, res) {
  try {
    const payload = await readJsonBody(req);
    const response = handleDemoMcp(payload, demoSession);
    if (response === null) {
      res.writeHead(202, {...corsHeaders(req), 'Content-Length': '0'});
      res.end();
      return;
    }
    const headers = demoSession.sessionId ? {'MCP-Session-Id': demoSession.sessionId} : {};
    sendJson(req, res, response, 200, headers);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    sendErrorJson(req, res, message.includes('JSON') ? 400 : 500, message.includes('JSON') ? 'BAD_JSON' : 'INTERNAL_ERROR', message);
  }
}

function handleDemoMcpTerminate(req, res) {
  const sessionId = req.headers['mcp-session-id'];
  const value = Array.isArray(sessionId) ? sessionId[0] : sessionId;
  if (demoSession.sessionId && value && value !== demoSession.sessionId) {
    sendErrorJson(req, res, 404, 'SESSION_NOT_FOUND', 'MCP session 不存在或已过期');
    return;
  }
  demoSession.initializeSeen = false;
  demoSession.initialized = false;
  demoSession.sessionId = '';
  sendJson(req, res, {ok: true, terminated: true});
}

async function handleMcpStdio(req, res) {
  try {
    if (!isLoopbackHost(remoteAddress(req))) {
      throw new HttpError(400, 'BAD_REQUEST', '本地 stdio relay 只接受来自本机的请求；请在本机部署并通过 127.0.0.1 或 localhost 使用');
    }
    if (!req.headers.origin) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', '本地 stdio relay 只接受 Web Console 同源页面发起的浏览器请求');
    }
    if (!isSameOriginRequest(req)) {
      throw new HttpError(403, 'FORBIDDEN_ORIGIN', '本地 stdio relay 只接受 Web Console 同源页面发起的请求');
    }
    const body = await readJsonBody(req);
    const command = String(body.command || '').trim();
    if (!command) throw new HttpError(400, 'BAD_REQUEST', 'command 不能为空');
    const args = Array.isArray(body.args) ? body.args.map((item) => String(item)) : [];
    const cwd = typeof body.cwd === 'string' && body.cwd.trim() ? resolve(body.cwd.trim()) : projectRoot;
    const sessionKey = stdioSessionKey({command, args, cwd});
    if (body.close) {
      closeStdioSession(sessionKey);
      sendJson(req, res, {ok: true, closed: true});
      return;
    }
    if (!body.payload || Array.isArray(body.payload) || typeof body.payload !== 'object') {
      throw new HttpError(400, 'BAD_REQUEST', 'payload 必须是 JSON object');
    }
    const existing = stdioSessions.get(sessionKey);
    if (body.reuse && existing && !existing.closed && existing.initializeResponse && body.payload.method === 'initialize') {
      sendJson(req, res, {...existing.initializeResponse, id: body.payload.id});
      return;
    }
    if (body.restart) closeStdioSession(sessionKey);
    const session = getStdioSession(sessionKey, {command, args, cwd});
    const response = await session.send(body.payload);
    if (response === null) {
      res.writeHead(202, {...corsHeaders(req), 'Content-Length': '0'});
      res.end();
      return;
    }
    sendJson(req, res, response);
  } catch (error) {
    if (error instanceof HttpError) {
      sendErrorJson(req, res, error.status, error.code, error.message);
      return;
    }
    sendErrorJson(req, res, 502, 'STDIO_RELAY_ERROR', error instanceof Error ? error.message : String(error));
  }
}

function getStdioSession(sessionKey, spec) {
  const existing = stdioSessions.get(sessionKey);
  if (existing && !existing.closed) {
    existing.touch();
    return existing;
  }
  const session = new StdioMcpSession(spec);
  stdioSessions.set(sessionKey, session);
  return session;
}

function closeStdioSession(sessionKey) {
  const existing = stdioSessions.get(sessionKey);
  if (existing) existing.close();
  stdioSessions.delete(sessionKey);
}

function stdioSessionKey({command, args, cwd}) {
  return JSON.stringify({command, args, cwd});
}

async function handleMcpProxy(req, res) {
  try {
    if (!isProxyClientAllowed(req)) {
      throw new HttpError(400, 'BAD_REQUEST', '本地代理只接受来自本机的请求；如需局域网共享，请用 --allow-lan-proxy 启动并从同源页面访问');
    }
    const body = await readJsonBody(req);
    const targetUrl = String(body.targetUrl || '').trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      throw new HttpError(400, 'BAD_REQUEST', 'targetUrl 必须是 http:// 或 https:// 地址');
    }
    if (!body.payload || Array.isArray(body.payload) || typeof body.payload !== 'object') {
      throw new HttpError(400, 'BAD_REQUEST', 'payload 必须是 JSON object');
    }
    const headers = {
      Accept: req.headers.accept || 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    };
    if (body.headers && !Array.isArray(body.headers) && typeof body.headers === 'object') {
      for (const [key, value] of Object.entries(body.headers)) {
        if (key && value !== null && value !== undefined) headers[key] = String(value);
      }
    }
    for (const key of ['mcp-protocol-version', 'mcp-session-id']) {
      const value = req.headers[key];
      if (value) headers[headerTitleCase(key)] = Array.isArray(value) ? value[0] : value;
    }
    const upstream = await fetch(targetUrl, {
      method: 'POST',
      headers,
      body: JSON.stringify(body.payload),
      signal: AbortSignal.timeout(60000)
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    const responseHeaders = {
      ...corsHeaders(req),
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Access-Control-Expose-Headers': 'MCP-Session-Id',
      'Content-Length': String(buffer.length)
    };
    const sessionId = upstream.headers.get('mcp-session-id');
    if (sessionId) responseHeaders['MCP-Session-Id'] = sessionId;
    res.writeHead(upstream.status, responseHeaders);
    res.end(buffer);
  } catch (error) {
    if (error instanceof HttpError) {
      sendErrorJson(req, res, error.status, error.code, error.message);
      return;
    }
    sendErrorJson(req, res, 502, 'PROXY_ERROR', error instanceof Error ? error.message : String(error));
  }
}

async function handleMcpProxyTerminate(req, res) {
  try {
    if (!isProxyClientAllowed(req)) {
      throw new HttpError(400, 'BAD_REQUEST', '本地代理只接受来自本机的请求；如需局域网共享，请用 --allow-lan-proxy 启动并从同源页面访问');
    }
    const body = await readJsonBody(req);
    const targetUrl = String(body.targetUrl || '').trim();
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
      throw new HttpError(400, 'BAD_REQUEST', 'targetUrl 必须是 http:// 或 https:// 地址');
    }
    const headers = {
      Accept: req.headers.accept || 'application/json, text/event-stream'
    };
    if (body.headers && !Array.isArray(body.headers) && typeof body.headers === 'object') {
      for (const [key, value] of Object.entries(body.headers)) {
        if (key && value !== null && value !== undefined) headers[key] = String(value);
      }
    }
    for (const key of ['mcp-protocol-version', 'mcp-session-id']) {
      const value = req.headers[key];
      if (value) headers[headerTitleCase(key)] = Array.isArray(value) ? value[0] : value;
    }
    const upstream = await fetch(targetUrl, {
      method: 'DELETE',
      headers,
      signal: AbortSignal.timeout(60000)
    });
    const buffer = Buffer.from(await upstream.arrayBuffer());
    res.writeHead(upstream.status, {
      ...corsHeaders(req),
      'Content-Type': upstream.headers.get('content-type') || 'application/json; charset=utf-8',
      'Access-Control-Expose-Headers': 'MCP-Session-Id',
      'Content-Length': String(buffer.length)
    });
    res.end(buffer);
  } catch (error) {
    if (error instanceof HttpError) {
      sendErrorJson(req, res, error.status, error.code, error.message);
      return;
    }
    sendErrorJson(req, res, 502, 'PROXY_ERROR', error instanceof Error ? error.message : String(error));
  }
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  if (!chunks.length) return {};
  const text = Buffer.concat(chunks).toString('utf8');
  const parsed = JSON.parse(text);
  if (!parsed || Array.isArray(parsed) || typeof parsed !== 'object') {
    throw new Error('请求体必须是 JSON object');
  }
  return parsed;
}

async function sendStatic(req, res, candidatePath) {
  const resolvedPath = resolve(candidatePath);
  const root = resolve(webRoot);
  if (!isInsidePath(root, resolvedPath)) {
    sendErrorJson(req, res, 403, 'STATIC_FORBIDDEN', '静态路径不允许访问');
    return;
  }
  if (!existsSync(resolvedPath)) {
    sendErrorJson(req, res, 404, 'STATIC_NOT_FOUND', '静态文件不存在');
    return;
  }
  const type = mimeTypes.get(extname(resolvedPath).toLowerCase()) || 'application/octet-stream';
  const content = await readFile(resolvedPath);
  res.writeHead(200, {...corsHeaders(req), 'Content-Type': type, 'Content-Length': String(content.length)});
  createReadStream(resolvedPath).pipe(res);
}

function sendJson(req, res, payload, status = 200, headers = {}) {
  const body = Buffer.from(JSON.stringify(payload, null, 2));
  res.writeHead(status, {
    ...corsHeaders(req),
    ...headers,
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': String(body.length)
  });
  res.end(body);
}

function sendErrorJson(req, res, status, code, message) {
  sendJson(req, res, {ok: false, error: {code, message, details: {}}}, status);
}

function corsHeaders(req) {
  const origin = req.headers.origin;
  const headers = {
    'Access-Control-Allow-Methods': 'GET,POST,DELETE,OPTIONS',
    'Access-Control-Allow-Headers': 'Accept, Content-Type, Authorization, MCP-Protocol-Version, MCP-Session-Id',
    'Access-Control-Expose-Headers': 'MCP-Session-Id'
  };
  if (origin && isAllowedOrigin(req, origin)) {
    headers['Access-Control-Allow-Origin'] = origin;
    headers.Vary = 'Origin';
  }
  return headers;
}

function protocolMethodsStatus() {
  return standardMcpMethods
    .map((item, order) => ({...item, supported: false, order}))
    .sort((a, b) => a.category.localeCompare(b.category) || a.order - b.order);
}

function handleDemoMcp(payload, session) {
  const method = String(payload.method || '');
  const requestId = payload.id;
  const isNotification = !Object.hasOwn(payload, 'id');
  if (payload.jsonrpc !== '2.0' || !method) return jsonrpcError(requestId, -32600, 'Invalid JSON-RPC request');
  if (isNotification) {
    if (method === 'notifications/initialized') session.initialized = Boolean(session.initializeSeen);
    return null;
  }
  if (method === 'ping') return {jsonrpc: '2.0', id: requestId, result: {}};
  if (method === 'initialize') {
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {};
    const protocolVersion = supportedProtocolVersions.has(params.protocolVersion) ? params.protocolVersion : defaultProtocolVersion;
    session.initializeSeen = true;
    session.initialized = false;
    session.protocolVersion = protocolVersion;
    session.sessionId = `demo-${Date.now().toString(36)}`;
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        protocolVersion,
        serverInfo: {name: 'demo-mcp-server', title: 'Demo MCP Server', version: '0.1.0'},
        capabilities: {tools: {listChanged: false}},
        instructions: 'A small generic demo endpoint for checking MCP web console behavior.'
      }
    };
  }
  if (!session.initialized) return jsonrpcError(requestId, -32002, 'MCP session is not initialized');
  if (method === 'tools/list') {
    return {
      jsonrpc: '2.0',
      id: requestId,
      result: {
        tools: [
          {
            name: 'demo_echo',
            title: 'Echo',
            description: 'Return the message passed in arguments.',
            inputSchema: {
              type: 'object',
              properties: {message: {type: 'string', description: 'Text to echo.'}},
              required: ['message']
            }
          },
          {
            name: 'demo_time',
            title: 'Current Time',
            description: 'Return the server time in ISO-8601 format.',
            inputSchema: {type: 'object', properties: {}}
          }
        ]
      }
    };
  }
  if (method === 'tools/call') {
    const params = payload.params && typeof payload.params === 'object' && !Array.isArray(payload.params) ? payload.params : {};
    const args = params.arguments && typeof params.arguments === 'object' && !Array.isArray(params.arguments) ? params.arguments : {};
    if (params.name === 'demo_echo') return toolResult(requestId, {message: String(args.message || '')});
    if (params.name === 'demo_time') return toolResult(requestId, {time: new Date().toISOString()});
    return jsonrpcError(requestId, -32602, `Unknown demo tool: ${params.name}`);
  }
  return jsonrpcError(requestId, -32601, `Method not found: ${method}`);
}

function toolResult(requestId, data) {
  return {
    jsonrpc: '2.0',
    id: requestId,
    result: {
      content: [{type: 'text', text: JSON.stringify(data)}],
      structuredContent: data,
      isError: false
    }
  };
}

function jsonrpcError(requestId, code, message) {
  return {jsonrpc: '2.0', id: requestId, error: {code, message}};
}

class StdioMcpSession {
  constructor({command, args, cwd}) {
    this.command = command;
    this.args = args;
    this.cwd = cwd;
    this.pending = new Map();
    this.stdoutBuffer = '';
    this.stderrTail = '';
    this.closed = false;
    this.child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env
    });
    this.child.stdout.setEncoding('utf8');
    this.child.stderr.setEncoding('utf8');
    this.child.stdout.on('data', (chunk) => this.handleStdout(chunk));
    this.child.stderr.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + chunk).slice(-4000);
    });
    this.child.on('error', (error) => this.close(error));
    this.child.on('exit', (code, signal) => {
      this.close(new Error(`stdio MCP exited: code=${code ?? 'null'} signal=${signal ?? 'null'}${this.stderrTail ? ` stderr=${this.stderrTail}` : ''}`));
    });
    this.touch();
  }

  touch() {
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => this.close(), stdioIdleMs);
  }

  send(payload) {
    if (this.closed) return Promise.reject(new Error('stdio MCP session is closed'));
    this.touch();
    const isNotification = !Object.hasOwn(payload, 'id');
    const line = JSON.stringify(payload) + '\n';
    if (isNotification) {
      this.child.stdin.write(line);
      return Promise.resolve(null);
    }
    const requestId = payload.id;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(String(requestId));
        reject(new Error(`stdio MCP request timed out: ${payload.method || requestId}`));
      }, 60000);
      this.pending.set(String(requestId), {resolve, reject, timeout});
      this.child.stdin.write(line, (error) => {
        if (!error) return;
        clearTimeout(timeout);
        this.pending.delete(String(requestId));
        reject(error);
      });
    }).then((response) => {
      if (payload.method === 'initialize') this.initializeResponse = response;
      return response;
    });
  }

  handleStdout(chunk) {
    this.stdoutBuffer += chunk;
    const lines = this.stdoutBuffer.split(/\r?\n/);
    this.stdoutBuffer = lines.pop() || '';
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let message;
      try {
        message = JSON.parse(trimmed);
      } catch {
        this.stderrTail = (this.stderrTail + `\n[stdout non-json] ${trimmed}`).slice(-4000);
        continue;
      }
      if (message && Object.hasOwn(message, 'id')) {
        const pending = this.pending.get(String(message.id));
        if (pending) {
          clearTimeout(pending.timeout);
          this.pending.delete(String(message.id));
          pending.resolve(message);
        }
      }
    }
  }

  close(error) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.idleTimer);
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(error || new Error('stdio MCP session closed'));
    }
    this.pending.clear();
    if (this.child && !this.child.killed) this.child.kill();
  }
}

function isAllowedOrigin(req, origin) {
  try {
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || !isLoopbackHost(parsed.hostname)) return false;
    const hostHeader = String(req.headers.host || `${host}:${port}`);
    const expected = new URL(`http://${hostHeader}`);
    return parsed.protocol === expected.protocol && parsed.hostname === expected.hostname && effectivePort(parsed) === effectivePort(expected);
  } catch {
    return false;
  }
}

function isSameOriginRequest(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  try {
    const parsed = new URL(origin);
    const hostHeader = String(req.headers.host || `${host}:${port}`);
    const expected = new URL(`http://${hostHeader}`);
    return parsed.protocol === expected.protocol && parsed.hostname === expected.hostname && effectivePort(parsed) === effectivePort(expected);
  } catch {
    return false;
  }
}

function isProxyClientAllowed(req) {
  if (isLoopbackHost(remoteAddress(req))) return true;
  if (!allowLanProxy) return false;
  return isSameOriginRequest(req);
}

function effectivePort(url) {
  if (url.port) return url.port;
  return url.protocol === 'https:' ? '443' : '80';
}

function isLoopbackHost(value) {
  const normalized = String(value || '').replace(/^::ffff:/, '').trim().toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function remoteAddress(req) {
  return req.socket.remoteAddress || '';
}

function isInsidePath(root, candidate) {
  const rel = relative(root, candidate);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function readArg(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : '';
}

function readFlag(name) {
  return process.argv.includes(name);
}

function isEnabled(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function headerTitleCase(value) {
  return value.split('-').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join('-');
}

class HttpError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}
