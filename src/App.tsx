import {useEffect, useMemo, useRef, useState} from 'react';
import type {ReactNode} from 'react';

type JsonValue = null | boolean | number | string | JsonValue[] | {[key: string]: JsonValue};
type JsonObject = {[key: string]: JsonValue};

type ToolSchema = {
  name: string;
  title?: string;
  description?: string;
  inputSchema?: {
    required?: string[];
    properties?: Record<string, JsonSchema>;
  };
};

type JsonSchema = {
  type?: string;
  description?: string;
  enum?: JsonValue[];
  items?: JsonSchema;
};

type ProtocolMethod = {
  method: string;
  kind: string;
  direction: string;
  category: string;
  description: string;
  supported: boolean;
  clientCallable?: boolean;
  order: number;
  supportSource?: string;
};

type McpConfig = {
  transport: 'direct' | 'proxy';
  baseUrl: string;
  targetUrl: string;
  clientName: string;
  protocolVersion: string;
  headers: JsonObject;
  defaultArgs: JsonObject;
};

type McpResponse = {
  result?: JsonValue;
  error?: {message?: string; code?: number | string} | string;
};

type TabName = 'protocol' | 'tools';
type Mode = 'form' | 'json';
type ToolParam = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

const STORAGE_KEY = 'mcpAgentConsoleConfig';
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const DEMO_LOCAL_PRESET = {
  transport: 'direct' as const,
  baseUrl: apiUrl('/api/mcp'),
  targetUrl: '',
  clientName: 'mcp-agent-console',
  protocolVersion: DEFAULT_PROTOCOL_VERSION,
  headers: {},
  defaultArgs: {}
};
const CATEGORY_NAMES: Record<string, string> = {
  lifecycle: '生命周期',
  base: '基础协议',
  tools: 'Tools',
  resources: 'Resources',
  prompts: 'Prompts',
  completion: 'Completion',
  logging: 'Logging',
  roots: 'Roots',
  sampling: 'Sampling',
  elicitation: 'Elicitation'
};
const CATEGORY_ORDER = ['lifecycle', 'base', 'tools', 'resources', 'prompts', 'completion', 'logging', 'roots', 'sampling', 'elicitation'];

export function App() {
  const [tools, setTools] = useState<ToolSchema[]>([]);
  const [protocolMethods, setProtocolMethods] = useState<ProtocolMethod[]>([]);
  const [baseProtocolMethods, setBaseProtocolMethods] = useState<ProtocolMethod[]>([]);
  const [selectedTool, setSelectedTool] = useState<ToolSchema | null>(null);
  const [selectedProtocol, setSelectedProtocol] = useState<ProtocolMethod | null>(null);
  const [args, setArgs] = useState<JsonObject>({});
  const [search, setSearch] = useState('');
  const [activeTab, setActiveTab] = useState<TabName>('protocol');
  const [mode, setMode] = useState<Mode>('form');
  const [configOpen, setConfigOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [config, setConfig] = useState<McpConfig>(() => loadConfig());
  const [draftConfig, setDraftConfig] = useState(() => configToDraft(config));
  const [health, setHealth] = useState({text: '未连接', kind: ''});
  const [resultMeta, setResultMeta] = useState('等待调用');
  const [resultText, setResultText] = useState('{}');
  const [calling, setCalling] = useState(false);
  const [toolsCapability, setToolsCapability] = useState<boolean | null>(null);
  const [sessionId, setSessionId] = useState('');
  const [negotiatedProtocolVersion, setNegotiatedProtocolVersion] = useState('');
  const sessionIdRef = useRef('');
  const protocolVersionRef = useRef('');

  const filteredProtocols = useMemo(() => {
    const q = search.trim().toLowerCase();
    return protocolMethods.filter((item) => {
      if (!q || activeTab !== 'protocol') return true;
      return [item.method, item.category, item.direction, item.description].join(' ').toLowerCase().includes(q);
    });
  }, [activeTab, protocolMethods, search]);

  const filteredTools = useMemo(() => {
    const q = search.trim().toLowerCase();
    return tools.filter((tool) => {
      if (!q || activeTab !== 'tools') return true;
      return [tool.name, tool.title, tool.description].join(' ').toLowerCase().includes(q);
    });
  }, [activeTab, search, tools]);

  const currentProtocol = selectedProtocol
    ? protocolMethods.find((item) => item.method === selectedProtocol.method) ?? selectedProtocol
    : null;
  const selectedName = activeTab === 'protocol' ? currentProtocol?.method : selectedTool?.name;
  const selectedDesc = activeTab === 'protocol'
    ? currentProtocol
      ? `${protocolStatusText(currentProtocol)} · ${CATEGORY_NAMES[currentProtocol.category] || currentProtocol.category} · ${currentProtocol.description}`
      : '选择一个协议接口'
    : firstLine(selectedTool?.description || selectedTool?.title || '');
  const canCall = !calling && (activeTab === 'tools' ? Boolean(selectedTool) : Boolean(currentProtocol?.clientCallable));

  useEffect(() => {
    void initializePage();
  }, []);

  useEffect(() => {
    if (activeTab === 'protocol') {
      const next = selectedProtocol ?? protocolMethods[0] ?? null;
      if (next) selectProtocol(next);
    } else {
      const next = selectedTool ?? tools[0] ?? null;
      if (next) selectTool(next);
    }
  }, [activeTab]);

  async function initializePage() {
    const methods = await loadProtocolMethods();
    const first = methods[0] ?? null;
    setSelectedProtocol(first);
    if (first) setArgs(protocolPayload(first.method, config, selectedTool));
    await connectMcp(methods, config);
  }

  async function loadProtocolMethods() {
    const response = await fetch(apiUrl('/api/mcp-methods'));
    const data = await response.json();
    const methods = (Array.isArray(data.methods) ? data.methods : []).map((item: ProtocolMethod) => ({
      ...item,
      supported: false,
      clientCallable: false,
      supportSource: '待连接'
    }));
    setBaseProtocolMethods(methods);
    setProtocolMethods(methods);
    return methods;
  }

  async function connectMcp(methods = baseProtocolMethods, requestConfig = config) {
    setHealth({text: '连接中', kind: ''});
    sessionIdRef.current = '';
    protocolVersionRef.current = '';
    setSessionId('');
    setNegotiatedProtocolVersion('');
    try {
      const initResult = await mcpRequest(
        {
          jsonrpc: '2.0',
          id: Date.now(),
          method: 'initialize',
          params: {
            protocolVersion: requestConfig.protocolVersion,
            capabilities: {},
            clientInfo: {name: requestConfig.clientName, version: '0.1.0'}
          }
        },
        requestConfig
      );
      if (initResult.error) throw new Error(errorMessage(initResult.error) || 'initialize failed');
      const result = objectValue(initResult.result);
      const capabilities = objectValue(result.capabilities);
      setToolsCapability(Boolean(capabilities.tools));
      const negotiatedVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : requestConfig.protocolVersion;
      const activeConfig = {...requestConfig, protocolVersion: negotiatedVersion};
      setNegotiatedProtocolVersion(negotiatedVersion);
      protocolVersionRef.current = negotiatedVersion;
      const nextMethods = applyServerCapabilities(methods, capabilities, true);
      await mcpRequest({jsonrpc: '2.0', method: 'notifications/initialized'}, activeConfig);
      const nextTools = capabilities.tools ? await loadTools(activeConfig) : [];
      if (!capabilities.tools) {
        setTools([]);
        setSelectedTool(null);
      }
      const nextProtocol = selectedProtocol ? nextMethods.find((item) => item.method === selectedProtocol.method) ?? nextMethods[0] : nextMethods[0];
      if (nextProtocol) {
        setSelectedProtocol(nextProtocol);
        if (activeTab === 'protocol') setArgs(protocolPayload(nextProtocol.method, activeConfig, selectedTool));
      }
      const serverInfo = objectValue(result.serverInfo);
      const serverName = typeof serverInfo.name === 'string' ? ` · ${serverInfo.name}` : '';
      setHealth({text: '已连接', kind: 'ok'});
      setResultMeta(`已完成 initialize${serverName} · ${nextTools.length} 个工具`);
      setResultText(JSON.stringify({endpoint: effectiveEndpoint(requestConfig), transport: requestConfig.transport, capabilities, tools: nextTools.map((tool) => tool.name)}, null, 2));
    } catch (error) {
      applyServerCapabilities(methods, {}, false);
      setTools([]);
      setSelectedTool(null);
      setToolsCapability(null);
      setHealth({text: '连接失败', kind: 'warn'});
      setResultMeta('MCP 连接失败');
      setResultText(formatConnectionError(error));
    }
  }

  async function loadTools(requestConfig = config) {
    const data = await mcpRequest({jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {}}, requestConfig);
    const result = objectValue(data.result);
    const nextTools = Array.isArray(result.tools) ? result.tools as ToolSchema[] : [];
    setTools(nextTools);
    const nextSelected = selectedTool ? nextTools.find((tool) => tool.name === selectedTool.name) ?? nextTools[0] : nextTools[0];
    setSelectedTool(nextSelected ?? null);
    if (activeTab === 'tools' && nextSelected) setArgs(buildDefaultArguments(nextSelected, requestConfig.defaultArgs));
    return nextTools;
  }

  function applyServerCapabilities(methods: ProtocolMethod[], capabilities: JsonObject, connected: boolean) {
    const supported = new Set<string>(connected ? ['initialize', 'notifications/initialized', 'ping', 'notifications/cancelled'] : []);
    const toolsCap = objectValue(capabilities.tools);
    const resourcesCap = objectValue(capabilities.resources);
    const promptsCap = objectValue(capabilities.prompts);
    if (connected && capabilities.tools) {
      supported.add('tools/list');
      supported.add('tools/call');
      if (toolsCap.listChanged) supported.add('notifications/tools/list_changed');
    }
    if (connected && capabilities.resources) {
      supported.add('resources/list');
      supported.add('resources/read');
      supported.add('resources/templates/list');
      if (resourcesCap.subscribe) {
        supported.add('resources/subscribe');
        supported.add('resources/unsubscribe');
        supported.add('notifications/resources/updated');
      }
      if (resourcesCap.listChanged) supported.add('notifications/resources/list_changed');
    }
    if (connected && capabilities.prompts) {
      supported.add('prompts/list');
      supported.add('prompts/get');
      if (promptsCap.listChanged) supported.add('notifications/prompts/list_changed');
    }
    if (connected && capabilities.logging) {
      supported.add('logging/setLevel');
      supported.add('notifications/message');
    }
    if (connected && (capabilities.completions || capabilities.completion)) supported.add('completion/complete');
    const source = connected ? '由 initialize.capabilities 标记' : '待连接';
    const nextMethods = methods.map((item) => ({
      ...item,
      supported: supported.has(item.method),
      clientCallable: supported.has(item.method) && isClientCallable(item),
      supportSource: protocolSupportSource(item, supported.has(item.method), source)
    }));
    setProtocolMethods(nextMethods);
    return nextMethods;
  }

  async function mcpRequest(payload: JsonObject, requestConfig = config): Promise<McpResponse> {
    const method = typeof payload.method === 'string' ? payload.method : '';
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    };
    if (requestConfig.transport === 'direct') Object.assign(headers, sanitizeHeaders(requestConfig.headers));
    if (method !== 'initialize') {
      headers['MCP-Protocol-Version'] = protocolVersionRef.current || negotiatedProtocolVersion || requestConfig.protocolVersion;
      if (sessionIdRef.current || sessionId) headers['MCP-Session-Id'] = sessionIdRef.current || sessionId;
    }
    const response = await fetch(requestUrl(requestConfig), {
      method: 'POST',
      headers,
      body: JSON.stringify(requestBody(payload, requestConfig))
    });
    const nextSessionId = response.headers.get('MCP-Session-Id');
    if (nextSessionId) {
      sessionIdRef.current = nextSessionId;
      setSessionId(nextSessionId);
    }
    if (response.status === 404 && (sessionIdRef.current || sessionId)) {
      sessionIdRef.current = '';
      setSessionId('');
      throw new Error('MCP session expired; please reconnect.');
    }
    const text = await response.text();
    if (!text) return {};
    const contentType = response.headers.get('Content-Type') || '';
    if (contentType.includes('text/event-stream')) return parseSseJsonRpc(text);
    let data: McpResponse;
    try {
      data = JSON.parse(text);
    } catch {
      throw new Error(`响应不是 JSON：HTTP ${response.status} ${text.slice(0, 160)}`);
    }
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${errorMessage(data.error) || response.statusText}`);
    return data;
  }

  function selectTool(tool: ToolSchema) {
    setSelectedTool(tool);
    setArgs(buildDefaultArguments(tool, config.defaultArgs));
  }

  function selectProtocol(protocol: ProtocolMethod) {
    setSelectedProtocol(protocol);
    setArgs(protocolPayload(protocol.method, config, selectedTool));
  }

  async function saveConfig() {
    try {
      const nextConfig = draftToConfig(draftConfig);
      setConfig(nextConfig);
      setDraftConfig(configToDraft(nextConfig));
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
      const methods = await loadProtocolMethods();
      await connectMcp(methods, nextConfig);
      setConfigOpen(false);
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function callSelected() {
    const latestProtocol = selectedProtocol
      ? protocolMethods.find((item) => item.method === selectedProtocol.method) ?? selectedProtocol
      : null;
    if (activeTab === 'protocol' && !latestProtocol?.clientCallable) {
      setResultMeta('当前协议接口不可直接调用');
      setResultText(latestProtocol?.supportSource || '当前连接未声明或该方法不是客户端可发起的方向');
      return;
    }
    const payload = activeTab === 'protocol' ? args : currentToolCallPayload(selectedTool, args);
    setCalling(true);
    setResultMeta('调用中');
    setResultText(JSON.stringify(payload, null, 2));
    const started = performance.now();
    try {
      const data = await mcpRequest(payload);
      setResultMeta(`${data.error ? 'MCP error' : 'OK'} · ${Math.round(performance.now() - started)}ms`);
      setResultText(JSON.stringify(data, null, 2));
    } catch (error) {
      setResultMeta('请求失败');
      setResultText(String(error instanceof Error ? error.message : error));
    } finally {
      setCalling(false);
    }
  }

  async function copyPayload() {
    const payload = activeTab === 'protocol' ? args : currentToolCallPayload(selectedTool, args);
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setResultMeta('请求已复制');
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span /></div>
            <div>
              <h1>MCP Agent 控制台</h1>
              <p>以 Agent 视角接线、握手、调工具</p>
            </div>
          </div>
          <button className="icon-btn" type="button" title="查看使用说明" aria-label="查看使用说明" onClick={() => setHelpOpen(true)}>?</button>
        </div>
        <div className="nav-tabs">
          <button className={`nav-tab ${activeTab === 'protocol' ? 'active' : ''}`} title="查看标准 MCP 协议方法，并按当前服务能力标记可调用项" onClick={() => setActiveTab('protocol')}>协议接口</button>
          <button className={`nav-tab ${activeTab === 'tools' ? 'active' : ''}`} title="查看当前服务通过 tools/list 暴露的工具" onClick={() => setActiveTab('tools')}>工具接口</button>
        </div>
        <div className="search">
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder={activeTab === 'protocol' ? '搜索协议接口' : '搜索工具'} />
          <div className="meta-row">
            <span>{activeTab === 'protocol' ? `${filteredProtocols.length} / ${protocolMethods.length} 个协议接口` : `${filteredTools.length} / ${tools.length} 个工具`}</span>
            <span className={`badge ${health.kind}`}>{health.text}</span>
          </div>
          <div className="scope-meter" aria-label="连接摘要">
            <span><b>{tools.length}</b> tools</span>
            <span><b>{protocolMethods.filter((item) => item.clientCallable).length}</b> callable</span>
          </div>
        </div>
        {activeTab === 'protocol' ? (
          <>
            <div className="section-title">按 initialize 能力标记</div>
            <ProtocolList methods={filteredProtocols} selected={currentProtocol} onSelect={selectProtocol} />
          </>
        ) : (
          <>
            <div className="section-title">当前 endpoint 暴露的工具</div>
            <ToolList tools={filteredTools} totalCount={tools.length} toolsCapability={toolsCapability} selected={selectedTool} onSelect={selectTool} />
          </>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{selectedName || '选择一个接口'}</h2>
            <p>{selectedDesc || '先配置 endpoint，再连接并调用协议或工具。'}</p>
          </div>
          <div className="actions">
            <button className="btn" title="使用当前保存的配置重新 initialize，并刷新 tools/list" onClick={() => void connectMcp()}>连接</button>
            <button className="btn" title="编辑 endpoint、客户端信息、请求头和默认工具参数" onClick={() => setConfigOpen(true)}>配置</button>
            <button className="btn" title="复制左侧请求 JSON，便于调试或复现" onClick={() => void copyPayload()}>复制请求</button>
            <button className="btn primary" title={activeTab === 'protocol' && !currentProtocol?.clientCallable ? '当前连接未声明该能力，或该方法不是客户端可发起的方向' : '发送当前 JSON-RPC 请求'} disabled={!canCall} onClick={() => void callSelected()}>调用</button>
          </div>
        </header>

        <section className="connection-strip" aria-label="当前 MCP 连接">
          <div className="wire-node">
            <span className={`wire-light ${health.kind}`} />
            <div>
              <strong>{health.text}</strong>
              <small>{config.transport === 'proxy' ? '推荐代理转发' : '高级直连 HTTP'}</small>
            </div>
          </div>
          <div className="route-line">
            <span>client</span>
            <code>{effectiveEndpoint(config)}</code>
            <span>MCP</span>
          </div>
          <div className="wire-meta">
            <span>protocol <b>{negotiatedProtocolVersion || config.protocolVersion}</b></span>
            <span>session <b>{sessionId ? 'active' : 'none'}</b></span>
          </div>
        </section>

        <ConfigPanel open={configOpen} draft={draftConfig} setDraft={setDraftConfig} onSave={() => void saveConfig()} onClose={() => setConfigOpen(false)} endpoint={effectiveEndpoint(config)} />
        <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />

        <section className="workspace">
          <section className="panel">
            <div className="panel-head">
              <h3>请求参数</h3>
              {activeTab === 'tools' && (
                <div className="mode-tabs" aria-label="编辑模式">
                  <button className={`tab ${mode === 'form' ? 'active' : ''}`} title="按工具 schema 生成表单" onClick={() => setMode('form')}>表单</button>
                  <button className={`tab ${mode === 'json' ? 'active' : ''}`} title="直接编辑 arguments JSON" onClick={() => setMode('json')}>JSON</button>
                </div>
              )}
            </div>
            <Editor activeTab={activeTab} mode={mode} selectedTool={selectedTool} args={args} setArgs={setArgs} endpoint={effectiveEndpoint(config)} />
          </section>

          <section className="panel result-panel">
            <div className="panel-head">
              <h3>调用结果</h3>
              <span className="result-meta">{resultMeta}</span>
            </div>
            <JsonResultViewer text={resultText} />
          </section>
        </section>
      </main>
    </div>
  );
}

function ProtocolList({methods, selected, onSelect}: {methods: ProtocolMethod[]; selected: ProtocolMethod | null; onSelect: (method: ProtocolMethod) => void}) {
  const groups = CATEGORY_ORDER
    .map((category) => ({
      category,
      items: methods
        .filter((item) => item.category === category)
        .sort((a, b) => Number(!a.clientCallable) - Number(!b.clientCallable) || Number(!a.supported) - Number(!b.supported) || a.order - b.order)
    }))
    .filter((group) => group.items.length);

  if (!methods.length) return <div className="empty">没有匹配的协议接口</div>;
  return (
    <div className="endpoint-list">
      {groups.map((group) => (
        <div className="protocol-group" key={group.category}>
          <div className="protocol-group-title">{CATEGORY_NAMES[group.category] || group.category}</div>
          {group.items.map((item) => (
            <button className={`endpoint ${item.supported ? '' : 'unsupported'} ${selected?.method === item.method ? 'active' : ''}`} title={item.supportSource || item.description} key={item.method} onClick={() => onSelect(item)}>
              <code>{item.method}</code>
              <span>{item.kind} · {item.direction}</span>
              <span>{item.description}</span>
              <span className={`status-pill ${item.clientCallable ? 'supported' : item.supported ? 'declared' : ''}`}>{protocolBadgeText(item)}</span>
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

function ToolList({tools, totalCount, toolsCapability, selected, onSelect}: {tools: ToolSchema[]; totalCount: number; toolsCapability: boolean | null; selected: ToolSchema | null; onSelect: (tool: ToolSchema) => void}) {
  if (toolsCapability === null) return <div className="empty">连接成功后，如果 server 声明 tools 能力，这里会显示工具列表。</div>;
  if (!toolsCapability) return <div className="empty">当前 server 未声明 tools 能力，因此没有可调用工具。</div>;
  if (totalCount === 0) return <div className="empty">当前 server 声明了 tools 能力，但 tools/list 没有返回工具。</div>;
  if (!tools.length) return <div className="empty">没有匹配的工具，请调整搜索关键词。</div>;
  return (
    <div className="tool-list">
      {tools.map((tool) => (
        <button className={`tool-button ${selected?.name === tool.name ? 'active' : ''}`} title={tool.description || tool.title || tool.name} key={tool.name} onClick={() => onSelect(tool)}>
          <span className="tool-name">{tool.name}</span>
          <span className="tool-desc">{firstLine(tool.description || tool.title || '') || '无描述'}</span>
          <ToolParamSummary tool={tool} compact />
        </button>
      ))}
    </div>
  );
}

function ToolParamSummary({tool, compact = false}: {tool: ToolSchema; compact?: boolean}) {
  const params = toolParameters(tool);
  if (!params.length) return <span className={compact ? 'tool-params compact' : 'tool-params'}>无参数</span>;
  const required = params.filter((param) => param.required);
  const optional = params.filter((param) => !param.required);
  const shownRequired = required.slice(0, compact ? 4 : 8);
  const shownOptional = optional.slice(0, compact ? 3 : 8);
  const hiddenCount = params.length - shownRequired.length - shownOptional.length;
  return (
    <span className={compact ? 'tool-params compact' : 'tool-params'}>
      {shownRequired.length ? <span><b>必填</b>{shownRequired.map((param) => <code key={param.name}>{param.name}</code>)}</span> : null}
      {shownOptional.length ? <span><b>可选</b>{shownOptional.map((param) => <code key={param.name}>{param.name}</code>)}</span> : null}
      {hiddenCount > 0 ? <em>+{hiddenCount}</em> : null}
    </span>
  );
}

type ConfigDraft = ReturnType<typeof configToDraft>;

function ConfigPanel({
  open,
  draft,
  setDraft,
  onSave,
  onClose,
  endpoint
}: {
  open: boolean;
  draft: ConfigDraft;
  setDraft: (draft: ConfigDraft) => void;
  onSave: () => void;
  onClose: () => void;
  endpoint: string;
}) {
  if (!open) return null;
  const update = (patch: Partial<ConfigDraft>) => setDraft({...draft, ...patch});
  const applyPreset = () => setDraft(configToDraft(DEMO_LOCAL_PRESET));
  const draftEndpoint = draft.transport === 'proxy' ? draft.targetUrl || endpoint : draft.baseUrl || endpoint;
  const draftTransportLabel = draft.transport === 'proxy' ? '本地代理' : '直连 HTTP';
  const importConfig = () => {
    try {
      const parsed = parseMcpServerConfig(draft.importText);
      setDraft({...configToDraft(parsed), importText: draft.importText});
    } catch (error) {
      setDraft({...draft, importError: String(error instanceof Error ? error.message : error)});
    }
  };
  return (
    <div className="drawer-backdrop" role="presentation">
      <aside className="config-drawer" role="dialog" aria-modal="true" aria-label="MCP 接入配置" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">Connection bay</span>
            <h3>接入配置</h3>
            <p>选择 endpoint、声明客户端身份，并保存到当前浏览器。</p>
          </div>
          <button className="icon-btn" type="button" title="关闭配置" aria-label="关闭配置" onClick={onClose}>x</button>
        </div>

        <div className="drawer-body">
          <section className="config-section">
            <div className="section-kicker">
              <span>快速接入</span>
              <small>选择后仍可继续编辑</small>
            </div>
            <div className="preset-grid">
              <button className="preset-card" type="button" onClick={applyPreset}>
                <b>本地 Demo MCP</b>
                <span>使用 /api/mcp 验证握手、工具列表和 JSON 调用流程。</span>
              </button>
            </div>
          </section>

          <section className="config-section">
            <div className="section-kicker">
              <span>导入配置</span>
              <small>支持 mcpServers 片段</small>
            </div>
            <JsonTextEditor
              label={<LabelWithHelp label="MCP Server 配置 JSON" help="可粘贴单个 server 配置，或包含 mcpServers 的完整配置。支持 type/url/headers 字段。" />}
              value={draft.importText}
              onChange={(value) => update({importText: value, importError: ''})}
              validate={(value) => value.trim() ? parseLooseJsonObject(value) : {}}
              hint="粘贴 Markdown 链接也会自动提取真实 URL。"
              placeholder='{"type":"streamable-http","url":"https://mcp.example.com/mcp","headers":{"Authorization":"Bearer ..."}}'
              minRows={6}
              footer={(
                <>
                <button className="btn" type="button" title="解析上方 JSON 并填充下面配置" onClick={importConfig}>解析配置</button>
                {draft.importError ? <span className="error-text">{draft.importError}</span> : <span className="hint">粘贴 Markdown 链接也会自动提取真实 URL。</span>}
                </>
              )}
            />
          </section>

          <section className="config-section">
            <div className="section-kicker">
              <span>连接方式</span>
              <small>{draft.transport === 'proxy' ? '推荐：远端服务默认用代理' : '高级：仅限同源或 CORS 已放行'}</small>
            </div>
            <div className="transport-choice" role="group" aria-label="连接方式">
              <button className={draft.transport === 'proxy' ? 'active' : ''} type="button" onClick={() => update({transport: 'proxy'})}>
                <b>本地代理 <em>推荐</em></b>
                <span>由 Web 服务转发请求，适合远端 HTTP MCP、跨域受限服务和单响应 SSE 调试。</span>
              </button>
              <button className={draft.transport === 'direct' ? 'active advanced' : 'advanced'} type="button" onClick={() => update({transport: 'direct'})}>
                <b>直连 HTTP <em>高级</em></b>
                <span>浏览器直接 POST 到 endpoint，仅适合同源地址或明确允许 CORS 的服务。</span>
              </button>
            </div>
            <div className="field">
              <LabelWithHelp label={draft.transport === 'proxy' ? '远端 MCP 地址' : 'MCP JSON-RPC 地址'} help={draft.transport === 'proxy' ? '本地 Web 服务会向这个远端 endpoint 转发 JSON-RPC POST 请求。' : '浏览器会向这个 HTTP endpoint 发送 JSON-RPC POST 请求。'} />
              <input value={draft.transport === 'proxy' ? draft.targetUrl : draft.baseUrl} onChange={(event) => update(draft.transport === 'proxy' ? {targetUrl: event.target.value} : {baseUrl: event.target.value})} type="text" placeholder={draft.transport === 'proxy' ? 'https://mcp.example.com/mcp' : `${apiUrl('/api/mcp')}`} />
            </div>
          </section>

          <section className="config-section">
            <div className="section-kicker">
              <span>客户端身份</span>
              <small>initialize 参数</small>
            </div>
            <div className="config-two-col">
              <div className="field">
                <LabelWithHelp label="Client Name" help="initialize.clientInfo.name，用来让服务识别当前客户端。" />
                <input value={draft.clientName} onChange={(event) => update({clientName: event.target.value})} type="text" placeholder="mcp-agent-console" />
              </div>
              <div className="field">
                <LabelWithHelp label="Protocol Version" help="initialize.params.protocolVersion；应与目标服务支持的版本匹配。" />
                <input value={draft.protocolVersion} onChange={(event) => update({protocolVersion: event.target.value})} type="text" placeholder={DEFAULT_PROTOCOL_VERSION} />
              </div>
            </div>
          </section>

          <section className="config-section">
            <div className="section-kicker">
              <span>请求附加项</span>
              <small>只保存在本地浏览器</small>
            </div>
            <JsonTextEditor
              label={<LabelWithHelp label="HTTP Headers JSON" help="用于 Authorization、X-Database 等请求头。MCP-Session-Id 会由页面自动维护，不建议手填。" />}
              value={draft.headersText}
              onChange={(value) => update({headersText: value})}
              validate={(value) => parseJsonObject(value, 'HTTP Headers JSON')}
              hint="只会发送给目标 MCP 服务，保存位置是当前浏览器 localStorage。"
              placeholder='{"Authorization":"Bearer ..."}'
            />
            <JsonTextEditor
              label={<LabelWithHelp label="默认工具参数 JSON" help="选择工具时会预填到 arguments，适合放项目、环境、租户等普通参数。" />}
              value={draft.defaultArgsText}
              onChange={(value) => update({defaultArgsText: value})}
              validate={(value) => parseJsonObject(value, '默认工具参数 JSON')}
              hint="选择工具时会预填到 arguments，可在调用前继续改。"
              placeholder='{"requester":"codex"}'
            />
          </section>
        </div>

        <div className="drawer-footer">
          <div className="saved-config-card" aria-label="当前将保存的配置">
            <span className="save-label">当前将保存</span>
            <strong>{draftTransportLabel}</strong>
            <code>{draftEndpoint}</code>
            <small>{draft.clientName || 'mcp-agent-console'} · {draft.protocolVersion || DEFAULT_PROTOCOL_VERSION}</small>
          </div>
          <div className="footer-actions">
            <button className="btn" type="button" onClick={onClose}>取消</button>
            <button className="btn primary" type="button" title="保存到浏览器 localStorage，并立即用新配置重新连接" onClick={onSave}>保存并连接</button>
          </div>
        </div>
      </aside>
    </div>
  );
}

function HelpPanel({open, onClose}: {open: boolean; onClose: () => void}) {
  if (!open) return null;
  return (
    <div className="drawer-backdrop" role="presentation" onClick={onClose}>
      <section className="help-panel" role="dialog" aria-modal="true" aria-label="使用说明" onClick={(event) => event.stopPropagation()}>
        <div className="drawer-head">
          <div>
            <span className="eyebrow">Operator notes</span>
            <h3>快速上手</h3>
            <p>这张控制台模拟 Agent 接入 MCP 的最短路径。</p>
          </div>
          <button className="icon-btn" type="button" title="关闭帮助" aria-label="关闭帮助" onClick={onClose}>x</button>
        </div>
        <div className="help-steps">
          <article>
            <b>配置接入</b>
            <p>填入 MCP HTTP JSON-RPC endpoint，或粘贴含 type/url/headers 的 MCP server 配置。</p>
          </article>
          <article>
            <b>选择传输</b>
            <p>远端 HTTP MCP 如果被浏览器 CORS 或 Header 限制卡住，选择本地代理；长连接流式能力需要专用 relay。</p>
          </article>
          <article>
            <b>完成握手</b>
            <p>保存并连接会执行 initialize，再根据 capabilities 标记协议能力并读取 tools/list。</p>
          </article>
          <article>
            <b>调用工具</b>
            <p>协议页适合检查生命周期；工具页适合按 schema 填参数并发起 tools/call。</p>
          </article>
          <article>
            <b>接入 stdio</b>
            <p>stdio MCP 需要先通过独立 relay 转成 HTTP endpoint，浏览器不能直接启动本地命令。</p>
          </article>
        </div>
      </section>
    </div>
  );
}

function LabelWithHelp({label, help}: {label: string; help: string}) {
  return (
    <label className="label-with-help">
      <span>{label}</span>
      <span className="help-wrap">
        <button className="help-dot" type="button" title={help} aria-label={`${label} 说明`}>?</button>
        <span className="help-popover">{help}</span>
      </span>
    </label>
  );
}

function Editor({activeTab, mode, selectedTool, args, setArgs, endpoint}: {activeTab: TabName; mode: Mode; selectedTool: ToolSchema | null; args: JsonObject; setArgs: (args: JsonObject) => void; endpoint: string}) {
  if (activeTab === 'protocol') {
    return <JsonEditor label="MCP JSON-RPC 请求" hint={`协议接口会 POST 到 ${endpoint}`} value={args} onChange={setArgs} />;
  }
  if (!selectedTool) return <div className="form"><div className="empty">请选择工具</div></div>;
  if (mode === 'json') return <JsonEditor label="arguments JSON" hint='调用时会包装为 {"method":"tools/call","params":...}' value={args} onChange={setArgs} />;
  return <FormEditor tool={selectedTool} args={args} setArgs={setArgs} />;
}

function JsonEditor({label, hint, value, onChange}: {label: string; hint: string; value: JsonObject; onChange: (value: JsonObject) => void}) {
  const [text, setText] = useState(JSON.stringify(value, null, 2));
  const internalChangeRef = useRef(false);

  useEffect(() => {
    if (internalChangeRef.current) {
      internalChangeRef.current = false;
      return;
    }
    setText(JSON.stringify(value, null, 2));
  }, [value]);

  return (
    <div className="form">
      <JsonTextEditor
        label={label}
        value={text}
        onChange={(next) => {
          setText(next);
          try {
            const parsed = parseJsonObject(next, label);
            internalChangeRef.current = true;
            onChange(parsed);
          } catch {
            return;
          }
        }}
        validate={(next) => parseJsonObject(next, label)}
        hint={hint}
        minRows={12}
      />
    </div>
  );
}

function FormEditor({tool, args, setArgs}: {tool: ToolSchema; args: JsonObject; setArgs: (args: JsonObject) => void}) {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  const names = Object.keys(props);
  if (!names.length) return <div className="form"><div className="empty">该工具没有参数</div></div>;
  return (
    <div className="form">
      <ToolSchemaSummary tool={tool} />
      {names.map((name) => {
        const schema = props[name] || {};
        return (
          <div className="field" key={name}>
            <label>
              <span>{name}</span>
              <span className="field-badges">
                <span className="type-pill">{schemaTypeLabel(schema)}</span>
                {required.has(name) ? <span className="required">必填</span> : <span className="optional">可选</span>}
              </span>
            </label>
            <SchemaInput name={name} schema={schema} value={args[name]} onChange={(value) => setArgs({...args, [name]: value})} />
            {schema.description ? <span className="hint">{schema.description}</span> : null}
          </div>
        );
      })}
    </div>
  );
}

function ToolSchemaSummary({tool}: {tool: ToolSchema}) {
  const params = toolParameters(tool);
  const required = params.filter((param) => param.required);
  const optional = params.filter((param) => !param.required);
  return (
    <div className="schema-summary">
      <div className="summary-title">参数说明</div>
      <ToolParamSummary tool={tool} />
      {required.length ? <ParamTable title="必填参数" params={required} /> : null}
      {optional.length ? <ParamTable title="可选参数" params={optional} /> : null}
    </div>
  );
}

function ParamTable({title, params}: {title: string; params: ToolParam[]}) {
  return (
    <div className="param-table">
      <div className="param-table-title">{title}</div>
      {params.map((param) => (
        <div className="param-row" key={param.name}>
          <code>{param.name}</code>
          <span>{param.type}</span>
          <p>{param.description || '无说明'}</p>
        </div>
      ))}
    </div>
  );
}

function SchemaInput({name, schema, value, onChange}: {name: string; schema: JsonSchema; value: JsonValue; onChange: (value: JsonValue) => void}) {
  if (schema.enum?.length) {
    const selectedIndex = schema.enum.findIndex((item) => JSON.stringify(item) === JSON.stringify(value));
    return (
      <select value={selectedIndex >= 0 ? String(selectedIndex) : ''} onChange={(event) => {
        const index = Number(event.target.value);
        onChange(Number.isInteger(index) && schema.enum ? schema.enum[index] : '');
      }}>
        <option value="">请选择</option>
        {schema.enum.map((item, index) => <option key={`${index}:${String(item)}`} value={String(index)}>{String(item)}</option>)}
      </select>
    );
  }
  if (schema.type === 'boolean') {
    return (
      <div className="checkbox-row">
        <input type="checkbox" checked={Boolean(value)} onChange={(event) => onChange(event.target.checked)} />
        <span>启用</span>
      </div>
    );
  }
  if (schema.type === 'array') {
    return <ArrayInput value={value} onChange={onChange} />;
  }
  if (schema.type === 'object') {
    return <ObjectInput value={value} onChange={onChange} />;
  }
  return (
    <input
      type={schema.type === 'integer' || schema.type === 'number' ? 'number' : 'text'}
      value={typeof value === 'string' || typeof value === 'number' ? value : ''}
      onChange={(event) => {
        if (schema.type === 'integer') onChange(event.target.value === '' ? '' : Number.parseInt(event.target.value, 10));
        else if (schema.type === 'number') onChange(event.target.value === '' ? '' : Number(event.target.value));
        else onChange(event.target.value);
      }}
      aria-label={name}
    />
  );
}

function ArrayInput({value, onChange}: {value: JsonValue; onChange: (value: JsonValue) => void}) {
  const [text, setText] = useState(JSON.stringify(Array.isArray(value) ? value : [], null, 2));
  useEffect(() => setText(JSON.stringify(Array.isArray(value) ? value : [], null, 2)), [value]);
  return (
    <JsonTextEditor
      value={text}
      placeholder='["value"]'
      validate={(next) => parseJsonArray(next, '数组参数')}
      hint="数组参数会按 JSON 原始类型传给工具。"
      minRows={5}
      compact
      onChange={(next) => {
        setText(next);
        try {
          onChange(parseJsonArray(next, '数组参数'));
        } catch {
          return;
        }
      }}
    />
  );
}

function ObjectInput({value, onChange}: {value: JsonValue; onChange: (value: JsonValue) => void}) {
  const [text, setText] = useState(JSON.stringify(objectValue(value), null, 2));
  useEffect(() => setText(JSON.stringify(objectValue(value), null, 2)), [value]);
  return (
    <JsonTextEditor
      value={text}
      placeholder='{"key":"value"}'
      validate={(next) => parseJsonObject(next, '对象参数')}
      hint="对象参数必须是 JSON object。"
      minRows={5}
      compact
      onChange={(next) => {
        setText(next);
        try {
          onChange(parseJsonObject(next, '对象参数'));
        } catch {
          return;
        }
      }}
    />
  );
}

function JsonTextEditor({
  label,
  value,
  onChange,
  validate = parseAnyJson,
  hint = 'JSON 格式正确。',
  placeholder,
  minRows = 7,
  footer,
  compact = false
}: {
  label?: ReactNode;
  value: string;
  onChange: (value: string) => void;
  validate?: (value: string) => JsonValue;
  hint?: string;
  placeholder?: string;
  minRows?: number;
  footer?: ReactNode;
  compact?: boolean;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [copied, setCopied] = useState(false);
  const validation = useMemo(() => validateJsonText(value, validate), [value, validate]);
  const actionLabel = copied ? '已复制' : '复制';

  const updateText = (next: string) => onChange(next);
  const format = (space: number) => {
    if (!validation.valid) return;
    updateText(JSON.stringify(validation.value, null, space));
  };
  const copy = async () => {
    await copyToClipboard(value);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className={`json-field ${compact ? 'compact' : ''} ${collapsed ? 'collapsed' : ''}`}>
      <div className="json-field-head">
        {label ? <div className="json-field-label">{typeof label === 'string' ? <label>{label}</label> : label}</div> : <span />}
        <div className="json-actions" aria-label="JSON 操作">
          <button className="json-action" type="button" disabled={!validation.valid} title="按 2 空格缩进格式化 JSON" onClick={() => format(2)}>格式化</button>
          <button className="json-action" type="button" disabled={!validation.valid} title="压缩成单行 JSON" onClick={() => format(0)}>压缩</button>
          <button className="json-action" type="button" title={collapsed ? '展开 JSON 编辑器' : '折叠 JSON 编辑器'} onClick={() => setCollapsed(!collapsed)}>{collapsed ? '展开' : '折叠'}</button>
          <button className="json-action" type="button" title="复制当前 JSON 文本" onClick={() => void copy()}>{actionLabel}</button>
        </div>
      </div>
      {!collapsed && (
        <textarea
          className="json-editor"
          spellCheck={false}
          value={value}
          rows={minRows}
          placeholder={placeholder}
          aria-invalid={!validation.valid}
          onChange={(event) => updateText(event.target.value)}
        />
      )}
      <div className="json-field-status">
        <span className={`json-status ${validation.valid ? 'ok' : 'bad'}`}>{validation.valid ? 'JSON 有效' : 'JSON 错误'}</span>
        <span className={validation.valid ? 'hint' : 'error-text'}>{validation.valid ? hint : validation.message}</span>
      </div>
      {footer ? <div className="inline-actions json-footer-actions">{footer}</div> : null}
    </div>
  );
}

function JsonResultViewer({text}: {text: string}) {
  const parsed = useMemo(() => parseJsonText(text), [text]);
  const [rawMode, setRawMode] = useState(false);
  const [copied, setCopied] = useState(false);
  const [expandSignal, setExpandSignal] = useState({id: 0, open: true});
  const displayText = parsed.valid ? JSON.stringify(parsed.value, null, 2) : text;

  const copy = async () => {
    await copyToClipboard(displayText);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };

  return (
    <div className="json-result">
      <div className="json-viewer-toolbar">
        <div className="json-viewer-tabs" aria-label="结果展示模式">
          <button className={`json-action ${!rawMode ? 'active' : ''}`} type="button" disabled={!parsed.valid} onClick={() => setRawMode(false)}>树形</button>
          <button className={`json-action ${rawMode || !parsed.valid ? 'active' : ''}`} type="button" onClick={() => setRawMode(true)}>文本</button>
        </div>
        <div className="json-actions" aria-label="结果 JSON 操作">
          <button className="json-action" type="button" disabled={!parsed.valid || rawMode} title="展开所有节点" onClick={() => setExpandSignal((state) => ({id: state.id + 1, open: true}))}>全展开</button>
          <button className="json-action" type="button" disabled={!parsed.valid || rawMode} title="折叠所有节点" onClick={() => setExpandSignal((state) => ({id: state.id + 1, open: false}))}>全折叠</button>
          <button className="json-action" type="button" title={parsed.valid ? '复制格式化后的 JSON' : '复制当前文本'} onClick={() => void copy()}>{copied ? '已复制' : '复制'}</button>
        </div>
      </div>
      <div className="json-viewer-body">
        {parsed.valid && !rawMode ? (
          <JsonTree value={parsed.value} expandSignal={expandSignal.id} expandOpen={expandSignal.open} />
        ) : (
          <pre className={`json-plain ${parsed.valid ? '' : 'is-text'}`}>{displayText}</pre>
        )}
      </div>
    </div>
  );
}

function JsonTree({value, expandSignal, expandOpen}: {value: JsonValue; expandSignal: number; expandOpen: boolean}) {
  return (
    <div className="json-tree">
      <JsonNode name="response" value={value} level={0} expandSignal={expandSignal} expandOpen={expandOpen} />
    </div>
  );
}

function JsonNode({
  name,
  value,
  level,
  expandSignal,
  expandOpen
}: {
  name: string;
  value: JsonValue;
  level: number;
  expandSignal: number;
  expandOpen: boolean;
}) {
  const expandable = isJsonContainer(value);
  const [open, setOpen] = useState(level < 1);
  useEffect(() => {
    if (expandSignal > 0) setOpen(expandOpen);
  }, [expandSignal, expandOpen]);

  if (!expandable) {
    return (
      <div className="json-node">
        <div className="json-node-line">
          <span className="json-toggle-spacer" />
          <span className="json-key">{formatJsonKey(name)}</span>
          <JsonPrimitive value={value} />
        </div>
      </div>
    );
  }

  const entries = Array.isArray(value) ? value.map((item, index) => [String(index), item] as const) : Object.entries(value);
  const opening = Array.isArray(value) ? '[' : '{';
  const closing = Array.isArray(value) ? ']' : '}';
  const countLabel = Array.isArray(value) ? `${entries.length} 项` : `${entries.length} 键`;

  return (
    <div className={`json-node ${level === 0 ? 'root' : ''}`}>
      <div className="json-node-line">
        <button className="json-toggle" type="button" title={open ? '折叠节点' : '展开节点'} aria-label={open ? '折叠节点' : '展开节点'} onClick={() => setOpen(!open)}>{open ? 'v' : '>'}</button>
        <span className="json-key">{formatJsonKey(name)}</span>
        <span className="json-bracket">{opening}</span>
        <span className="json-count">{countLabel}</span>
        {!open ? <span className="json-bracket">{closing}</span> : null}
      </div>
      {open ? (
        <div className="json-children">
          {entries.length ? entries.map(([childName, childValue]) => (
            <JsonNode key={childName} name={childName} value={childValue} level={level + 1} expandSignal={expandSignal} expandOpen={expandOpen} />
          )) : <div className="json-empty-node">空</div>}
          <div className="json-node-close">{closing}</div>
        </div>
      ) : null}
    </div>
  );
}

function JsonPrimitive({value}: {value: JsonValue}) {
  const type = value === null ? 'null' : typeof value;
  return <span className={`json-value ${type}`}>{primitiveJsonText(value)}</span>;
}

function apiUrl(path: string) {
  const fallbackBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:8765' : window.location.origin;
  return fallbackBase.replace(/\/$/, '') + path;
}

function isClientCallable(method: ProtocolMethod) {
  return method.direction === 'client_to_server' || method.direction === 'bidirectional';
}

function protocolBadgeText(method: ProtocolMethod) {
  if (method.clientCallable) return '可调用';
  if (method.supported) return '已声明';
  return '未声明';
}

function protocolStatusText(method: ProtocolMethod) {
  if (method.clientCallable) return '当前连接可调用';
  if (method.supported) return '当前连接已声明，等待服务端发送';
  return '当前连接未声明';
}

function protocolSupportSource(method: ProtocolMethod, supported: boolean, source: string) {
  if (!supported) return '当前连接未声明该能力，控制台不会直接调用';
  if (!isClientCallable(method)) return '当前连接声明了该服务端到客户端的方法；它不是页面可主动发起的调用';
  return source;
}

function loadConfig(): McpConfig {
  const fallbackBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:8765' : window.location.origin;
  const defaultConfig = {
    transport: 'direct' as const,
    baseUrl: `${fallbackBase}/api/mcp`,
    targetUrl: '',
    clientName: 'mcp-agent-console',
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    headers: {},
    defaultArgs: {}
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '{}';
    const saved = JSON.parse(raw) as Partial<McpConfig> & Record<string, unknown>;
    const transport = saved.transport === 'proxy' ? 'proxy' : 'direct';
    return {
      transport,
      baseUrl: normalizeEndpoint(typeof saved.baseUrl === 'string' && saved.baseUrl ? saved.baseUrl : defaultConfig.baseUrl) || defaultConfig.baseUrl,
      targetUrl: normalizeEndpoint(typeof saved.targetUrl === 'string' ? saved.targetUrl : ''),
      clientName: typeof saved.clientName === 'string' && saved.clientName ? saved.clientName : defaultConfig.clientName,
      protocolVersion: typeof saved.protocolVersion === 'string' && saved.protocolVersion ? saved.protocolVersion : defaultConfig.protocolVersion,
      headers: objectValue(saved.headers),
      defaultArgs: objectValue(saved.defaultArgs)
    };
  } catch {
    return defaultConfig;
  }
}

function configToDraft(config: McpConfig) {
  return {
    transport: config.transport,
    baseUrl: config.baseUrl,
    targetUrl: config.targetUrl,
    clientName: config.clientName,
    protocolVersion: config.protocolVersion,
    headersText: JSON.stringify(config.headers || {}, null, 2),
    defaultArgsText: JSON.stringify(config.defaultArgs || {}, null, 2),
    importText: '',
    importError: ''
  };
}

function draftToConfig(draft: ConfigDraft): McpConfig {
  const transport = draft.transport === 'proxy' ? 'proxy' : 'direct';
  const baseUrl = normalizeEndpoint(draft.baseUrl.trim()) || apiUrl('/api/mcp');
  const targetUrl = normalizeEndpoint(draft.targetUrl.trim());
  if (transport === 'proxy' && !targetUrl) throw new Error('本地代理模式必须填写远端 MCP 地址');
  return {
    transport,
    baseUrl,
    targetUrl,
    clientName: draft.clientName.trim() || 'mcp-agent-console',
    protocolVersion: draft.protocolVersion.trim() || DEFAULT_PROTOCOL_VERSION,
    headers: parseJsonObject(draft.headersText, 'HTTP Headers JSON'),
    defaultArgs: parseJsonObject(draft.defaultArgsText, '默认工具参数 JSON')
  };
}

function requestUrl(config: McpConfig) {
  return config.transport === 'proxy' ? apiUrl('/api/mcp-proxy') : normalizeEndpoint(config.baseUrl);
}

function effectiveEndpoint(config: McpConfig) {
  return config.transport === 'proxy' ? config.targetUrl : config.baseUrl;
}

function requestBody(payload: JsonObject, config: McpConfig): JsonObject {
  if (config.transport !== 'proxy') return payload;
  return {
    targetUrl: normalizeEndpoint(config.targetUrl),
    headers: sanitizeHeaders(config.headers),
    payload
  };
}

function parseMcpServerConfig(text: string): McpConfig {
  const trimmed = text.trim();
  if (!trimmed) throw new Error('请先粘贴 MCP server 配置 JSON');
  const parsed = parseLooseJsonObject(trimmed);
  const server = pickServerConfig(parsed);
  const url = normalizeEndpoint(String(server.url || server.endpoint || server.baseUrl || ''));
  if (!url) throw new Error('配置里没有找到 url');
  const type = String(server.type || '').toLowerCase();
  const headers = objectValue(server.headers);
  return {
    transport: type.includes('http') ? 'proxy' : 'direct',
    baseUrl: type.includes('http') ? apiUrl('/api/mcp-proxy') : url,
    targetUrl: type.includes('http') ? url : '',
    clientName: 'mcp-agent-console',
    protocolVersion: type.includes('streamable') ? '2025-06-18' : DEFAULT_PROTOCOL_VERSION,
    headers,
    defaultArgs: {}
  };
}

function parseLooseJsonObject(text: string): JsonObject {
  const candidates = [text];
  if (/^"[^"]+"\s*:/.test(text)) candidates.push(`{${text}}`);
  for (const candidate of candidates) {
    try {
      return parseJsonObject(candidate, 'MCP Server 配置 JSON');
    } catch {
      continue;
    }
  }
  throw new Error('MCP Server 配置不是合法 JSON；如果只粘贴了 server 条目，请保留外层花括号或完整键值对');
}

function pickServerConfig(parsed: JsonObject): JsonObject {
  const servers = objectValue(parsed.mcpServers);
  const firstServer = Object.values(servers).find((value) => value && typeof value === 'object' && !Array.isArray(value));
  if (firstServer) return firstServer as JsonObject;
  if (parsed.url || parsed.endpoint || parsed.baseUrl) return parsed;
  const nested = Object.values(parsed).find((value) => value && typeof value === 'object' && !Array.isArray(value) && objectValue(value).url);
  if (nested) return nested as JsonObject;
  return parsed;
}

function normalizeEndpoint(value: string) {
  const trimmed = String(value || '').trim();
  if (!trimmed) return '';
  const markdownMatch = trimmed.match(/\((https?:\/\/[^)\s]+)\)/);
  if (markdownMatch) return markdownMatch[1];
  const urlMatch = trimmed.match(/https?:\/\/[^\s)>]+/);
  return urlMatch ? urlMatch[0] : trimmed;
}

function protocolPayload(method: string, config: McpConfig, selectedTool: ToolSchema | null): JsonObject {
  const payload: JsonObject = {jsonrpc: '2.0', method};
  if (!method.startsWith('notifications/')) payload.id = Date.now();
  if (method === 'initialize') {
    payload.params = {protocolVersion: config.protocolVersion, capabilities: {}, clientInfo: {name: config.clientName, version: '0.1.0'}};
  } else if (method === 'tools/call') {
    payload.params = {name: selectedTool?.name || '', arguments: {...config.defaultArgs}};
  } else if (method === 'notifications/cancelled') {
    payload.params = {requestId: 1, reason: 'cancelled from web console'};
  } else if (method === 'logging/setLevel') {
    payload.params = {level: 'info'};
  } else if (method === 'resources/read' || method === 'resources/subscribe' || method === 'resources/unsubscribe') {
    payload.params = {uri: ''};
  } else if (method === 'prompts/get') {
    payload.params = {name: '', arguments: {}};
  } else if (method === 'completion/complete') {
    payload.params = {ref: {type: 'ref/prompt', name: ''}, argument: {name: '', value: ''}};
  } else if (method === 'sampling/createMessage') {
    payload.params = {messages: [], maxTokens: 256};
  } else if (method === 'elicitation/create') {
    payload.params = {message: '', requestedSchema: {type: 'object', properties: {}}};
  } else {
    payload.params = {};
  }
  return payload;
}

function buildDefaultArguments(tool: ToolSchema, defaults: JsonObject) {
  const required = new Set(tool.inputSchema?.required || []);
  const props = tool.inputSchema?.properties || {};
  const next: JsonObject = {};
  for (const [name, schema] of Object.entries(props)) {
    if (Object.hasOwn(defaults, name)) {
      next[name] = defaults[name];
      continue;
    }
    if (!required.has(name)) continue;
    if (schema.type === 'boolean') next[name] = false;
    else if (schema.type === 'array') next[name] = [];
    else if (schema.type === 'object') next[name] = {};
    else if (schema.type === 'integer' || schema.type === 'number') next[name] = 0;
    else next[name] = '';
  }
  return next;
}

function toolParameters(tool: ToolSchema): ToolParam[] {
  const props = tool.inputSchema?.properties || {};
  const required = new Set(tool.inputSchema?.required || []);
  return Object.entries(props).map(([name, schema]) => ({
    name,
    type: schemaTypeLabel(schema),
    required: required.has(name),
    description: schema.description || ''
  }));
}

function schemaTypeLabel(schema: JsonSchema) {
  if (schema.enum?.length) {
    const values = schema.enum.map((item) => String(item));
    return `enum(${values.slice(0, 4).join('|')}${values.length > 4 ? '|...' : ''})`;
  }
  if (schema.type === 'array') return `array${schema.items?.type ? `<${schema.items.type}>` : ''}`;
  return schema.type || 'any';
}

function currentToolCallPayload(selectedTool: ToolSchema | null, args: JsonObject): JsonObject {
  return {
    jsonrpc: '2.0',
    id: Date.now(),
    method: 'tools/call',
    params: {
      name: selectedTool?.name || '',
      arguments: compactArguments(args)
    }
  };
}

function compactArguments(args: JsonObject): JsonObject {
  const compacted: JsonObject = {};
  for (const [key, value] of Object.entries(args || {})) {
    if (value === '' || value === null || value === undefined) continue;
    if (Array.isArray(value) && value.length === 0) continue;
    compacted[key] = value;
  }
  return compacted;
}

function parseAnyJson(text: string): JsonValue {
  const trimmed = text.trim();
  if (!trimmed) return {};
  return JSON.parse(trimmed) as JsonValue;
}

function validateJsonText(text: string, validate: (value: string) => JsonValue) {
  try {
    return {valid: true as const, value: validate(text), message: ''};
  } catch (error) {
    return {valid: false as const, value: null, message: String(error instanceof Error ? error.message : error || 'JSON 格式不正确')};
  }
}

function parseJsonText(text: string) {
  try {
    return {valid: true as const, value: JSON.parse(text) as JsonValue};
  } catch {
    return {valid: false as const, value: null};
  }
}

function parseJsonObject(text: string, label: string): JsonObject {
  const trimmed = text.trim();
  if (!trimmed) return {};
  const value = JSON.parse(trimmed);
  if (!value || Array.isArray(value) || typeof value !== 'object') throw new Error(`${label} 必须是 JSON object`);
  return value as JsonObject;
}

function parseJsonArray(text: string, label: string): JsonValue[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const value = JSON.parse(trimmed);
  if (!Array.isArray(value)) throw new Error(`${label} 必须是 JSON array`);
  return value;
}

function sanitizeHeaders(headers: JsonObject): Record<string, string> {
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    if (!key || value === null || value === undefined) continue;
    next[key] = String(value);
  }
  return next;
}

function objectValue(value: unknown): JsonObject {
  return value && !Array.isArray(value) && typeof value === 'object' ? value as JsonObject : {};
}

function firstLine(text: string) {
  return String(text || '').split('\n')[0];
}

function isJsonContainer(value: JsonValue): value is JsonValue[] | {[key: string]: JsonValue} {
  return Boolean(value && typeof value === 'object');
}

function formatJsonKey(key: string) {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}

function primitiveJsonText(value: JsonValue) {
  if (typeof value === 'string') return JSON.stringify(value);
  if (value === null) return 'null';
  return String(value);
}

async function copyToClipboard(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement('textarea');
    textarea.value = text;
    textarea.setAttribute('readonly', 'true');
    textarea.style.position = 'fixed';
    textarea.style.left = '-9999px';
    document.body.appendChild(textarea);
    textarea.select();
    document.execCommand('copy');
    document.body.removeChild(textarea);
  }
}

function errorMessage(error: McpResponse['error']) {
  if (!error) return '';
  return typeof error === 'string' ? error : error.message || '';
}

function parseSseJsonRpc(text: string): McpResponse {
  const events = text.split(/\n\n+/);
  for (const event of events) {
    const data = event
      .split(/\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trimStart())
      .join('\n')
      .trim();
    if (!data) continue;
    try {
      const parsed = JSON.parse(data) as McpResponse;
      if (Object.hasOwn(parsed, 'result') || Object.hasOwn(parsed, 'error')) return parsed;
    } catch {
      continue;
    }
  }
  throw new Error('SSE response did not contain a JSON-RPC response event.');
}

function formatConnectionError(error: unknown) {
  const text = String(error instanceof Error ? error.message : error || '未知错误');
  return [
    text,
    '',
    '排查建议：',
    '1. 确认 MCP JSON-RPC 地址可以从浏览器访问。',
    '2. 如果是远端服务，确认它允许 CORS，并允许 Content-Type / Authorization 等请求头。',
    '3. 如果目标是 stdio 或 SSE MCP，请先用本地代理转换为 HTTP JSON-RPC endpoint。',
    '4. 如果 initialize 返回协议错误，检查 Protocol Version 和鉴权 Header。'
  ].join('\n');
}
