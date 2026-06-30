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
  transport: 'proxy' | 'stdio';
  baseUrl: string;
  targetUrl: string;
  stdioCommand: string;
  stdioArgs: string[];
  stdioCwd: string;
  keepAlive: boolean;
  clientName: string;
  protocolVersion: string;
  headers: JsonObject;
  defaultArgs: JsonObject;
};

type ConfigLifecycleStatus = 'created' | 'initialized' | 'enabled' | 'disabled' | 'error';

type SavedConfigProfile = McpConfig & {
  id: string;
  name: string;
  savedAt: string;
  status: ConfigLifecycleStatus;
  lastError?: string;
};

type ConnectionSessionState = {
  sessionId: string;
  protocolVersion: string;
  capabilities?: JsonObject;
};

type McpResponse = {
  result?: JsonValue;
  error?: {message?: string; code?: number | string} | string;
};

type TabName = 'protocol' | 'tools' | 'resources' | 'prompts' | 'completion' | 'logging';
type CapabilityTab = {
  key: TabName;
  label: string;
  title: string;
  count?: number;
};
type Mode = 'form' | 'json';
type ToolParam = {
  name: string;
  type: string;
  required: boolean;
  description: string;
};

type LifecycleStep = 'initialize' | 'initialized' | 'toolsList' | 'ready' | 'terminated';
type LifecycleStatus = 'idle' | 'running' | 'done' | 'skipped' | 'error';
type LifecycleState = Record<LifecycleStep, LifecycleStatus>;

const STORAGE_KEY = 'mcpAgentConsoleConfig';
const SAVED_CONFIGS_KEY = 'mcpAgentConsoleSavedConfigs';
const ACTIVE_PROFILE_KEY = 'mcpAgentConsoleActiveProfileId';
const DEFAULT_PROTOCOL_VERSION = '2025-11-25';
const MCP_SERVER_CONFIG_PLACEHOLDER = `{
  "type": "streamable-http",
  "url": "https://mcp.example.com/mcp",
  "headers": {
    "Authorization": "Bearer ..."
  }
}

或

{
  "command": "node",
  "args": [
    "server.js",
    "--stdio"
  ]
}`;
const STDIO_ARGS_PLACEHOLDER = `[
  "server.js",
  "--stdio"
]`;
const HEADERS_JSON_PLACEHOLDER = `{
  "Authorization": "Bearer ..."
}`;
const DEFAULT_ARGS_JSON_PLACEHOLDER = `{
  "requester": "codex"
}`;
const ARRAY_VALUE_PLACEHOLDER = `[
  "value"
]`;
const OBJECT_VALUE_PLACEHOLDER = `{
  "key": "value"
}`;
const DEMO_LOCAL_PRESET = {
  transport: 'proxy' as const,
  baseUrl: apiUrl('/api/mcp-proxy'),
  targetUrl: apiUrl('/api/mcp'),
  stdioCommand: '',
  stdioArgs: [],
  stdioCwd: '',
  keepAlive: false,
  clientName: 'mcp-agent-console',
  protocolVersion: DEFAULT_PROTOCOL_VERSION,
  headers: {},
  defaultArgs: {}
};
const NEW_CONFIG_PRESET = {
  transport: 'proxy' as const,
  baseUrl: apiUrl('/api/mcp-proxy'),
  targetUrl: '',
  stdioCommand: '',
  stdioArgs: [],
  stdioCwd: '',
  keepAlive: false,
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
const LIFECYCLE_STEPS: {key: LifecycleStep; label: string; description: string}[] = [
  {key: 'initialize', label: 'initialize', description: '协商协议版本与能力'},
  {key: 'initialized', label: 'initialized', description: '发送初始化完成通知'},
  {key: 'toolsList', label: 'tools/list', description: '按 server capabilities 发现 Tools'},
  {key: 'ready', label: 'operation', description: '进入 operation phase，可发起调试调用'},
  {key: 'terminated', label: 'shutdown', description: '底层 transport 已关闭或 session 已清理'}
];

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
  const [savedConfigs, setSavedConfigs] = useState<SavedConfigProfile[]>(() => loadSavedConfigProfiles());
  const [configSaved, setConfigSaved] = useState(() => hasSavedConfig());
  const [activeProfileId, setActiveProfileId] = useState(() => loadActiveProfileId() || configProfileId(config));
  const [health, setHealth] = useState({text: '未连接', kind: ''});
  const [resultMeta, setResultMeta] = useState('等待调用');
  const [resultText, setResultText] = useState('{}');
  const [calling, setCalling] = useState(false);
  const [toolsCapability, setToolsCapability] = useState<boolean | null>(null);
  const [serverCapabilities, setServerCapabilities] = useState<JsonObject>({});
  const [sessionId, setSessionId] = useState('');
  const [negotiatedProtocolVersion, setNegotiatedProtocolVersion] = useState('');
  const [lifecycle, setLifecycle] = useState<LifecycleState>(() => createLifecycleState());
  const sessionIdRef = useRef('');
  const protocolVersionRef = useRef('');
  const activeConfigRef = useRef(config);
  const activeConnectionKeyRef = useRef(configProfileId(config));
  const sessionByConnectionRef = useRef<Record<string, ConnectionSessionState>>({});

  const visibleTabs = useMemo(
    () => capabilityTabs(serverCapabilities, protocolMethods, tools.length, toolsCapability),
    [protocolMethods, serverCapabilities, tools.length, toolsCapability]
  );
  const activeProtocolMethods = useMemo(
    () => protocolMethodsForTab(protocolMethods, activeTab),
    [activeTab, protocolMethods]
  );
  const filteredProtocols = useMemo(() => {
    const q = search.trim().toLowerCase();
    return activeProtocolMethods.filter((item) => {
      if (!q || activeTab === 'tools') return true;
      return [item.method, item.category, item.direction, item.description].join(' ').toLowerCase().includes(q);
    });
  }, [activeProtocolMethods, activeTab, search]);

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
  const selectedName = activeTab === 'tools' ? selectedTool?.name : currentProtocol?.method;
  const selectedDesc = activeTab !== 'tools'
    ? currentProtocol
      ? `${protocolStatusText(currentProtocol)} · ${CATEGORY_NAMES[currentProtocol.category] || currentProtocol.category} · ${currentProtocol.description}`
      : '选择一个协议方法'
    : firstLine(selectedTool?.description || selectedTool?.title || '');
  const canCall = !calling && (activeTab === 'tools' ? Boolean(selectedTool) : Boolean(currentProtocol?.clientCallable));
  const activeProfile = savedConfigs.find((profile) => profile.id === activeProfileId);
  const activeConfigEnabled = activeProfile?.status === 'enabled';
  const canCallSelected = canCall && activeConfigEnabled;
  const currentConnectionBusy = health.text === '连接中' || health.text === '断开中' || lifecycle.initialize === 'running' || lifecycle.terminated === 'running';

  useEffect(() => {
    void initializePage();
  }, []);

  useEffect(() => {
    if (!visibleTabs.some((tab) => tab.key === activeTab)) {
      setActiveTab('protocol');
    }
  }, [activeTab, visibleTabs]);

  useEffect(() => {
    if (activeTab === 'protocol') {
      const next = selectedProtocol ?? protocolMethods[0] ?? null;
      if (next) selectProtocol(next);
    } else if (activeTab === 'tools') {
      const next = selectedTool ?? tools[0] ?? null;
      if (next) selectTool(next);
    } else {
      const next = activeProtocolMethods.find((item) => item.method === selectedProtocol?.method) ?? activeProtocolMethods[0] ?? null;
      if (next) selectProtocol(next);
    }
  }, [activeTab, activeProtocolMethods]);

  async function initializePage() {
    const methods = await loadProtocolMethods();
    const first = methods[0] ?? null;
    setSelectedProtocol(first);
    if (first) setArgs(protocolPayload(first.method, config, selectedTool));
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

  async function connectMcp(methods = baseProtocolMethods, requestConfig = config, {markReady = true, profileId = ''}: {markReady?: boolean; profileId?: string} = {}) {
    setHealth({text: '连接中', kind: ''});
    const connectionKey = profileId || configProfileId(requestConfig);
    await prepareActiveConnection(requestConfig, connectionKey);
    sessionIdRef.current = '';
    protocolVersionRef.current = '';
    setSessionId('');
    setNegotiatedProtocolVersion('');
    setLifecycle({...createLifecycleState(), initialize: 'running'});
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
        requestConfig,
        connectionKey
      );
      if (initResult.error) throw new Error(errorMessage(initResult.error) || 'initialize failed');
      setLifecycleStep('initialize', 'done');
      const result = objectValue(initResult.result);
      const capabilities = objectValue(result.capabilities);
      setServerCapabilities(capabilities);
      setToolsCapability(Boolean(capabilities.tools));
      const negotiatedVersion = typeof result.protocolVersion === 'string' ? result.protocolVersion : requestConfig.protocolVersion;
      const activeConfig = {...requestConfig, protocolVersion: negotiatedVersion};
      setNegotiatedProtocolVersion(negotiatedVersion);
      protocolVersionRef.current = negotiatedVersion;
      rememberConnectionSession(connectionKey, {sessionId: sessionIdRef.current, protocolVersion: negotiatedVersion, capabilities});
      const nextMethods = applyServerCapabilities(methods, capabilities, true);
      setLifecycleStep('initialized', 'running');
      await mcpRequest({jsonrpc: '2.0', method: 'notifications/initialized'}, activeConfig, connectionKey);
      setLifecycleStep('initialized', 'done');
      let nextTools: ToolSchema[] = [];
      if (capabilities.tools) {
        setLifecycleStep('toolsList', 'running');
        nextTools = await loadTools(activeConfig, connectionKey, {activate: markReady});
        setLifecycleStep('toolsList', 'done');
      } else {
        setLifecycleStep('toolsList', 'skipped');
      }
      const autoActivatedTools = markReady && nextTools.length > 0;
      if (!capabilities.tools) {
        setTools([]);
        setSelectedTool(null);
      }
      const nextProtocol = selectedProtocol ? nextMethods.find((item) => item.method === selectedProtocol.method) ?? nextMethods[0] : nextMethods[0];
      if (nextProtocol) {
        setSelectedProtocol(nextProtocol);
        if (activeTab === 'protocol' && !autoActivatedTools) setArgs(protocolPayload(nextProtocol.method, activeConfig, selectedTool));
      }
      const serverInfo = objectValue(result.serverInfo);
      const serverName = typeof serverInfo.name === 'string' ? ` · ${serverInfo.name}` : '';
      setHealth({text: '已连接', kind: 'ok'});
      setResultMeta(`已完成 initialize${serverName} · ${nextTools.length} 个工具`);
      setResultText(JSON.stringify({endpoint: effectiveEndpoint(requestConfig), transport: requestConfig.transport, capabilities, tools: nextTools.map((tool) => tool.name)}, null, 2));
      setLifecycle((current) => ({
        ...current,
        ready: markReady ? 'done' : 'idle',
        terminated: markReady ? 'idle' : 'done'
      }));
      return true;
    } catch (error) {
      setLifecycle((current) => markLifecycleError(current));
      applyServerCapabilities(methods, {}, false);
      setServerCapabilities({});
      setTools([]);
      setSelectedTool(null);
      setToolsCapability(null);
      setHealth({text: '连接失败', kind: 'warn'});
      setResultMeta('MCP 连接失败');
      setResultText(formatConnectionError(error));
      return false;
    }
  }

  function setLifecycleStep(step: LifecycleStep, status: LifecycleStatus) {
    setLifecycle((current) => ({...current, [step]: status}));
  }

  async function loadTools(requestConfig = config, connectionKey = activeConnectionKeyRef.current || configProfileId(requestConfig), {activate = false}: {activate?: boolean} = {}) {
    const data = await mcpRequest({jsonrpc: '2.0', id: Date.now(), method: 'tools/list', params: {}}, requestConfig, connectionKey);
    const result = objectValue(data.result);
    const nextTools = Array.isArray(result.tools) ? result.tools as ToolSchema[] : [];
    setTools(nextTools);
    const nextSelected = selectedTool ? nextTools.find((tool) => tool.name === selectedTool.name) ?? nextTools[0] : nextTools[0];
    setSelectedTool(nextSelected ?? null);
    if (nextSelected && (activeTab === 'tools' || activate)) {
      setArgs(buildDefaultArguments(nextSelected, requestConfig.defaultArgs));
    }
    if (activate && nextSelected) {
      setSearch('');
      setActiveTab('tools');
    }
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

  async function mcpRequest(payload: JsonObject, requestConfig = config, connectionKey = activeConnectionKeyRef.current || configProfileId(requestConfig)): Promise<McpResponse> {
    const method = typeof payload.method === 'string' ? payload.method : '';
    const cachedSession = sessionByConnectionRef.current[connectionKey];
    const headers: Record<string, string> = {
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json'
    };
    if (method !== 'initialize') {
      headers['MCP-Protocol-Version'] = cachedSession?.protocolVersion || protocolVersionRef.current || negotiatedProtocolVersion || requestConfig.protocolVersion;
      const activeSessionId = cachedSession?.sessionId || sessionIdRef.current || sessionId;
      if (activeSessionId) headers['MCP-Session-Id'] = activeSessionId;
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
      rememberConnectionSession(connectionKey, {
        sessionId: nextSessionId,
        protocolVersion: protocolVersionRef.current || negotiatedProtocolVersion || requestConfig.protocolVersion
      });
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

  async function prepareActiveConnection(nextConfig: McpConfig, nextKey = configProfileId(nextConfig)) {
    const previousConfig = activeConfigRef.current;
    const previousKey = activeConnectionKeyRef.current;
    if (previousKey && previousKey !== nextKey && !previousConfig.keepAlive) {
      await disconnectConfig(previousConfig, sessionByConnectionRef.current[previousKey]);
      delete sessionByConnectionRef.current[previousKey];
    }
    activeConfigRef.current = nextConfig;
    activeConnectionKeyRef.current = nextKey;
  }

  async function disconnectConfig(targetConfig: McpConfig, state?: ConnectionSessionState) {
    const protocolVersion = state?.protocolVersion || protocolVersionRef.current || negotiatedProtocolVersion || targetConfig.protocolVersion;
    try {
      if (targetConfig.transport === 'stdio') {
        await fetch(apiUrl('/api/mcp-stdio'), {
          method: 'POST',
          headers: {'Content-Type': 'application/json'},
          body: JSON.stringify({
            command: targetConfig.stdioCommand,
            args: targetConfig.stdioArgs,
            cwd: targetConfig.stdioCwd,
            close: true
          })
        });
        return;
      }
      if (!state?.sessionId) return;
      await fetch(apiUrl('/api/mcp-proxy'), {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'MCP-Protocol-Version': protocolVersion,
          'MCP-Session-Id': state.sessionId
        },
        body: JSON.stringify({
          targetUrl: normalizeEndpoint(targetConfig.targetUrl),
          headers: sanitizeHeaders(targetConfig.headers)
        })
      });
    } catch {
      // Best-effort cleanup; a stale close should not block connecting to another MCP.
    }
  }

  async function disconnectActiveConnection() {
    const targetConfig = activeConfigRef.current;
    const key = activeConnectionKeyRef.current || configProfileId(targetConfig);
    const state = sessionByConnectionRef.current[key] || {
      sessionId: sessionIdRef.current || sessionId,
      protocolVersion: protocolVersionRef.current || negotiatedProtocolVersion || targetConfig.protocolVersion
    };
    setHealth({text: '断开中', kind: ''});
    setLifecycleStep('terminated', 'running');
    await disconnectConfig(targetConfig, state);
    delete sessionByConnectionRef.current[key];
    sessionIdRef.current = '';
    protocolVersionRef.current = '';
    setSessionId('');
    setNegotiatedProtocolVersion('');
    applyServerCapabilities(baseProtocolMethods, {}, false);
    setServerCapabilities({});
    setTools([]);
    setSelectedTool(null);
    setToolsCapability(null);
    setHealth({text: '已断开', kind: ''});
    setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
        markSavedConfigStatus(activeProfileId || key, 'disabled', '', targetConfig);
    setResultMeta('MCP 会话已断开');
    setResultText(JSON.stringify({endpoint: effectiveEndpoint(targetConfig), transport: targetConfig.transport, sessionId: state.sessionId || null}, null, 2));
  }

  function rememberConnectionSession(connectionKey: string, state: ConnectionSessionState) {
    sessionByConnectionRef.current[connectionKey] = {...sessionByConnectionRef.current[connectionKey], ...state};
  }

  function selectTool(tool: ToolSchema) {
    setSelectedTool(tool);
    setArgs(buildDefaultArguments(tool, config.defaultArgs));
  }

  function selectProtocol(protocol: ProtocolMethod) {
    setSelectedProtocol(protocol);
    setArgs(protocolPayload(protocol.method, config, selectedTool));
  }

  function applyConfig(nextConfig: McpConfig, {persist = true, profileId = ''}: {persist?: boolean; profileId?: string} = {}) {
    const nextId = profileId || configProfileId(nextConfig);
    setConfig(nextConfig);
    setDraftConfig({...configToDraft(nextConfig), profileId: nextId});
    setActiveProfileId(nextId);
    localStorage.setItem(ACTIVE_PROFILE_KEY, nextId);
    if (persist) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(nextConfig));
      setConfigSaved(true);
    } else {
      setConfigSaved(savedConfigs.some((profile) => profile.id === nextId));
    }
    if (activeTab !== 'tools' && currentProtocol) setArgs(protocolPayload(currentProtocol.method, nextConfig, selectedTool));
    if (activeTab === 'tools' && selectedTool) setArgs(buildDefaultArguments(selectedTool, nextConfig.defaultArgs));
  }

  function selectSavedProfile(profile: SavedConfigProfile) {
    applyConfig(profile, {persist: true, profileId: profile.id});
    const state = sessionByConnectionRef.current[profile.id];
    if (profile.status === 'enabled' && state) {
      sessionIdRef.current = state.sessionId;
      protocolVersionRef.current = state.protocolVersion;
      setSessionId(state.sessionId);
      setNegotiatedProtocolVersion(state.protocolVersion);
      setHealth({text: '恢复中', kind: ''});
      setLifecycle((current) => ({...current, ready: 'done', terminated: 'idle'}));
      void restoreEnabledProfile(profile, state);
      return;
    }
    sessionIdRef.current = '';
    protocolVersionRef.current = '';
    setSessionId('');
    setNegotiatedProtocolVersion('');
    setTools([]);
    setSelectedTool(null);
    setToolsCapability(null);
    setServerCapabilities({});
    applyServerCapabilities(baseProtocolMethods, {}, false);
    setLifecycle(createLifecycleStateForProfile(profile.status));
    setHealth({text: configLifecycleLabel(profile.status), kind: profile.status === 'error' ? 'warn' : ''});
  }

  async function restoreEnabledProfile(profile: SavedConfigProfile, state: ConnectionSessionState) {
    try {
      const capabilities = state.capabilities || {};
      setServerCapabilities(capabilities);
      applyServerCapabilities(baseProtocolMethods, capabilities, true);
      setToolsCapability(Boolean(capabilities.tools));
      if (capabilities.tools) {
        setLifecycleStep('toolsList', 'running');
        await loadTools(profile, profile.id);
        setLifecycleStep('toolsList', 'done');
      } else {
        setTools([]);
        setSelectedTool(null);
        setLifecycleStep('toolsList', 'skipped');
      }
      setHealth({text: '已开启', kind: 'ok'});
    } catch (error) {
      setHealth({text: '恢复失败', kind: 'warn'});
      setLifecycle((current) => markLifecycleError(current));
      setResultMeta('恢复当前 MCP 失败');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function saveConfig({connect = false}: {connect?: boolean} = {}) {
    try {
      const nextConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || createSavedConfigId(nextConfig);
      const nextSavedConfigs = upsertSavedConfigProfile(savedConfigs, nextConfig, 'created', targetId, draftConfig.name);
      persistSavedConfigs(nextSavedConfigs);
      applyConfig(nextConfig, {persist: !connect, profileId: targetId});
      setResultMeta(connect ? '配置已保存，正在连接' : '配置已保存到快速接入');
      if (connect) {
        const methods = await loadProtocolMethods();
        const ok = await connectMcp(methods, nextConfig, {profileId: targetId});
        markSavedConfigStatus(targetId, ok ? 'enabled' : 'error', '', nextConfig);
        setConfigOpen(false);
      } else {
        setConfigSaved(true);
      }
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function connectDraftConfig() {
    try {
      const nextConfig = draftToConfig(draftConfig);
      applyConfig(nextConfig, {persist: false});
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
    if (!activeConfigEnabled) {
      setResultMeta('当前 MCP 未开启');
      setResultText('请先在配置管理中选择配置并执行“开启”，进入 operation phase 后再调用协议方法或 Tool。');
      return;
    }
    const latestProtocol = selectedProtocol
      ? protocolMethods.find((item) => item.method === selectedProtocol.method) ?? selectedProtocol
      : null;
    if (activeTab !== 'tools' && !latestProtocol?.clientCallable) {
      setResultMeta('当前协议方法不可由 Client 直接调用');
      setResultText(latestProtocol?.supportSource || '当前连接未声明或该方法不是客户端可发起的方向');
      return;
    }
    const payload = activeTab !== 'tools' ? args : currentToolCallPayload(selectedTool, args);
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
    const payload = activeTab !== 'tools' ? args : currentToolCallPayload(selectedTool, args);
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    setResultMeta('请求已复制');
  }

  function persistSavedConfigs(nextProfiles: SavedConfigProfile[]) {
    setSavedConfigs(nextProfiles);
    localStorage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(nextProfiles));
  }

  function markSavedConfigStatus(id: string, status: ConfigLifecycleStatus, lastError = '', targetConfig?: McpConfig) {
    setSavedConfigs((current) => {
      const persisted = loadSavedConfigProfiles();
      const base = current.some((profile) => profile.id === id) ? current : persisted;
      const hasId = base.some((profile) => profile.id === id);
      const next = base.map((profile) => {
        const matches = profile.id === id || (!hasId && targetConfig && sameConnectionTarget(profile, targetConfig));
        return matches ? {...profile, status, lastError, savedAt: new Date().toISOString()} : profile;
      });
      localStorage.setItem(SAVED_CONFIGS_KEY, JSON.stringify(next));
      return next;
    });
  }

  async function saveDraftProfile() {
    try {
      const nextConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || createSavedConfigId(nextConfig);
      const existingProfile = savedConfigs.find((profile) => profile.id === targetId);
      const targetChanged = Boolean(existingProfile && !sameConnectionTarget(existingProfile, nextConfig));
      if (targetChanged && existingProfile) {
        await disconnectConfig(existingProfile, sessionByConnectionRef.current[targetId]);
        delete sessionByConnectionRef.current[targetId];
        if (targetId === activeConnectionKeyRef.current) {
          sessionIdRef.current = '';
          protocolVersionRef.current = '';
          setSessionId('');
          setNegotiatedProtocolVersion('');
          setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
        }
      }
      const nextStatus = existingProfile && !targetChanged ? undefined : 'created';
      const nextSavedConfigs = upsertSavedConfigProfile(savedConfigs, nextConfig, nextStatus, targetId, draftConfig.name);
      persistSavedConfigs(nextSavedConfigs);
      setDraftConfig({...configToDraft(nextSavedConfigs.find((profile) => profile.id === targetId) || nextConfig), profileId: targetId});
      if (targetId === activeProfileId) {
        applyConfig(nextSavedConfigs.find((profile) => profile.id === targetId) || nextConfig, {profileId: targetId});
      }
      setResultMeta('配置已保存到浏览器');
      setResultText(JSON.stringify({id: targetId, name: normalizeProfileName(draftConfig.name) || configProfileName(nextConfig), endpoint: effectiveEndpoint(nextConfig), status: nextStatus || existingProfile?.status || 'created'}, null, 2));
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function initializeDraftProfile() {
    try {
      const nextConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || createSavedConfigId(nextConfig);
      const nextSavedConfigs = upsertSavedConfigProfile(savedConfigs, nextConfig, 'created', targetId, draftConfig.name);
      persistSavedConfigs(nextSavedConfigs);
      applyConfig(nextSavedConfigs.find((profile) => profile.id === targetId) || nextConfig, {profileId: targetId});
      const methods = await loadProtocolMethods();
      const ok = await connectMcp(methods, nextConfig, {markReady: false, profileId: targetId});
      if (ok) {
        await disconnectConfig(nextConfig, sessionByConnectionRef.current[targetId]);
        delete sessionByConnectionRef.current[targetId];
        sessionIdRef.current = '';
        protocolVersionRef.current = '';
        setSessionId('');
        setNegotiatedProtocolVersion('');
        setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
      }
      markSavedConfigStatus(targetId, ok ? 'initialized' : 'error', '', nextConfig);
      if (ok) setHealth({text: '已初始化', kind: 'ok'});
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function initializeCurrentConnection() {
    const targetConfig = activeProfile || config;
    const targetId = activeProfile?.id || activeProfileId || createSavedConfigId(targetConfig);
    try {
      const nextSavedConfigs = upsertSavedConfigProfile(savedConfigs, targetConfig, 'created', targetId, activeProfile?.name || configProfileName(targetConfig));
      persistSavedConfigs(nextSavedConfigs);
      applyConfig(nextSavedConfigs.find((profile) => profile.id === targetId) || targetConfig, {profileId: targetId});
      const methods = await loadProtocolMethods();
      const ok = await connectMcp(methods, targetConfig, {markReady: false, profileId: targetId});
      if (ok) {
        await disconnectConfig(targetConfig, sessionByConnectionRef.current[targetId]);
        delete sessionByConnectionRef.current[targetId];
        sessionIdRef.current = '';
        protocolVersionRef.current = '';
        setSessionId('');
        setNegotiatedProtocolVersion('');
        setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
      }
      markSavedConfigStatus(targetId, ok ? 'initialized' : 'error', '', targetConfig);
      if (ok) setHealth({text: '已初始化', kind: 'ok'});
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function enableDraftProfile() {
    try {
      const nextConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || createSavedConfigId(nextConfig);
      const nextSavedConfigs = upsertSavedConfigProfile(savedConfigs, nextConfig, 'created', targetId, draftConfig.name);
      persistSavedConfigs(nextSavedConfigs);
      applyConfig(nextSavedConfigs.find((profile) => profile.id === targetId) || nextConfig, {profileId: targetId});
      const methods = await loadProtocolMethods();
      const ok = await connectMcp(methods, nextConfig, {profileId: targetId});
      markSavedConfigStatus(targetId, ok ? 'enabled' : 'error', '', nextConfig);
      if (ok) {
        setHealth({text: '已开启', kind: 'ok'});
        setConfigOpen(false);
      }
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function enableSavedProfile(profile: SavedConfigProfile) {
    try {
      persistSavedConfigs(upsertSavedConfigProfile(savedConfigs, profile, 'created', profile.id, profile.name));
      applyConfig(profile, {profileId: profile.id});
      const methods = await loadProtocolMethods();
      const ok = await connectMcp(methods, profile, {profileId: profile.id});
      markSavedConfigStatus(profile.id, ok ? 'enabled' : 'error', '', profile);
      if (ok) setHealth({text: '已开启', kind: 'ok'});
    } catch (error) {
      setHealth({text: '配置错误', kind: 'warn'});
      setResultMeta('配置格式错误');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function closeDraftProfile() {
    try {
      const draftTargetConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || configProfileId(draftTargetConfig);
      const savedProfile = savedConfigs.find((profile) => profile.id === targetId);
      const targetConfig = savedProfile || draftTargetConfig;
      await disconnectConfig(targetConfig, sessionByConnectionRef.current[targetId]);
      delete sessionByConnectionRef.current[targetId];
      if (targetId === activeProfileId) {
        sessionIdRef.current = '';
        protocolVersionRef.current = '';
        setSessionId('');
        setNegotiatedProtocolVersion('');
        applyServerCapabilities(baseProtocolMethods, {}, false);
        setServerCapabilities({});
        setTools([]);
        setSelectedTool(null);
        setToolsCapability(null);
        setHealth({text: '已关闭', kind: ''});
        setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
      }
      markSavedConfigStatus(targetId, 'disabled', '', targetConfig);
      setResultMeta('MCP 配置已关闭');
      setResultText(JSON.stringify({id: targetId, endpoint: effectiveEndpoint(targetConfig), status: 'disabled'}, null, 2));
    } catch (error) {
      setResultMeta('关闭失败');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function closeSavedProfile(profile: SavedConfigProfile) {
    try {
      await disconnectConfig(profile, sessionByConnectionRef.current[profile.id]);
      delete sessionByConnectionRef.current[profile.id];
      if (profile.id === activeProfileId) {
        sessionIdRef.current = '';
        protocolVersionRef.current = '';
        setSessionId('');
        setNegotiatedProtocolVersion('');
        applyServerCapabilities(baseProtocolMethods, {}, false);
        setServerCapabilities({});
        setTools([]);
        setSelectedTool(null);
        setToolsCapability(null);
        setHealth({text: '已关闭', kind: ''});
        setLifecycle((current) => ({...current, ready: 'idle', terminated: 'done'}));
      }
      markSavedConfigStatus(profile.id, 'disabled', '', profile);
      setResultMeta('MCP 配置已关闭');
      setResultText(JSON.stringify({id: profile.id, endpoint: effectiveEndpoint(profile), status: 'disabled'}, null, 2));
    } catch (error) {
      setResultMeta('关闭失败');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function toggleSavedProfile(profile: SavedConfigProfile) {
    if (profile.status === 'enabled') await closeSavedProfile(profile);
    else await enableSavedProfile(profile);
  }

  async function toggleCurrentConnection() {
    if (activeProfile?.status === 'enabled') {
      await closeSavedProfile(activeProfile);
      return;
    }
    const targetProfile = activeProfile || upsertSavedConfigProfile(savedConfigs, config, 'created', activeProfileId || createSavedConfigId(config))[0];
    if (!activeProfile) persistSavedConfigs(upsertSavedConfigProfile(savedConfigs, config, 'created', targetProfile.id, targetProfile.name));
    await enableSavedProfile(targetProfile);
  }

  function openConfigPanel() {
    const enabledProfile = activeProfile?.status === 'enabled'
      ? activeProfile
      : savedConfigs.find((profile) => profile.status === 'enabled');
    const preferredProfile = enabledProfile || activeProfile;
    if (preferredProfile) setDraftConfig(configToDraft(preferredProfile));
    setConfigOpen(true);
  }

  async function deleteDraftProfile() {
    try {
      const draftTargetConfig = draftToConfig(draftConfig);
      const targetId = draftConfig.profileId || configProfileId(draftTargetConfig);
      const savedProfile = savedConfigs.find((profile) => profile.id === targetId);
      const targetConfig = savedProfile || draftTargetConfig;
      await disconnectConfig(targetConfig, sessionByConnectionRef.current[targetId]);
      delete sessionByConnectionRef.current[targetId];
      const nextProfiles = savedConfigs.filter((profile) => profile.id !== targetId);
      persistSavedConfigs(nextProfiles);
      if (targetId === activeProfileId) {
        const fallback = nextProfiles[0];
        if (fallback) selectSavedProfile(fallback);
        else {
          applyConfig(NEW_CONFIG_PRESET, {persist: true});
          applyServerCapabilities(baseProtocolMethods, {}, false);
          setServerCapabilities({});
          setTools([]);
          setSelectedTool(null);
          setToolsCapability(null);
          setHealth({text: '未连接', kind: ''});
        }
      }
      setResultMeta('配置已删除');
      setResultText(JSON.stringify({id: targetId, deleted: true}, null, 2));
    } catch (error) {
      setResultMeta('删除失败');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  async function deleteSavedProfile(profile: SavedConfigProfile) {
    try {
      await disconnectConfig(profile, sessionByConnectionRef.current[profile.id]);
      delete sessionByConnectionRef.current[profile.id];
      const nextProfiles = savedConfigs.filter((item) => item.id !== profile.id);
      persistSavedConfigs(nextProfiles);
      if (profile.id === activeProfileId) {
        const fallback = nextProfiles[0];
        if (fallback) selectSavedProfile(fallback);
        else {
          applyConfig(NEW_CONFIG_PRESET, {persist: true});
          applyServerCapabilities(baseProtocolMethods, {}, false);
          setServerCapabilities({});
          setTools([]);
          setSelectedTool(null);
          setToolsCapability(null);
          setHealth({text: '未连接', kind: ''});
          setLifecycle(createLifecycleState());
        }
      }
      setResultMeta('配置已删除');
      setResultText(JSON.stringify({id: profile.id, deleted: true}, null, 2));
    } catch (error) {
      setResultMeta('删除失败');
      setResultText(String(error instanceof Error ? error.message : error));
    }
  }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-lockup">
            <div className="brand-mark" aria-hidden="true"><span /></div>
            <div>
              <h1>MCP 调试控制台</h1>
              <p>模拟 MCP Client 连接 Server、协商能力、调用 Tools</p>
            </div>
          </div>
          <button className="icon-btn" type="button" title="查看使用说明" aria-label="查看使用说明" onClick={() => setHelpOpen(true)}>?</button>
        </div>
        <div className="nav-tabs">
          {visibleTabs.map((tab) => (
            <button className={`nav-tab ${activeTab === tab.key ? 'active' : ''}`} title={tab.title} key={tab.key} onClick={() => setActiveTab(tab.key)}>
              <span>{tab.label}</span>
              {typeof tab.count === 'number' ? <b>{tab.count}</b> : null}
            </button>
          ))}
        </div>
        <div className="search">
          <input value={search} onChange={(event) => setSearch(event.target.value)} type="search" placeholder={activeTab === 'tools' ? '搜索 Tools' : `搜索 ${tabLabel(activeTab)} 协议方法`} />
          <div className="meta-row">
            <span>{activeTab === 'tools' ? `${filteredTools.length} / ${tools.length} 个 Tools` : `${filteredProtocols.length} / ${activeProtocolMethods.length} 个 ${tabLabel(activeTab)} 方法`}</span>
            <span className={`badge ${health.kind}`}>{health.text}</span>
          </div>
          <div className="scope-meter" aria-label="连接摘要">
            <span><b>{tools.length}</b> tools</span>
            <span title="客户端可主动发起的 MCP 协议方法数量"><b>{protocolMethods.filter((item) => item.clientCallable).length}</b> protocol calls</span>
          </div>
        </div>
        {activeTab === 'protocol' ? (
          <>
            <div className="section-title">按 Server Capabilities 标记</div>
            <ProtocolList methods={filteredProtocols} selected={currentProtocol} onSelect={selectProtocol} />
          </>
        ) : activeTab !== 'tools' ? (
          <>
            <div className="section-title">{tabLabel(activeTab)} 能力入口</div>
            <ProtocolList methods={filteredProtocols} selected={currentProtocol} onSelect={selectProtocol} />
          </>
        ) : (
          <>
            <div className="section-title">当前 Server 暴露的 Tools</div>
            <ToolList tools={filteredTools} totalCount={tools.length} toolsCapability={toolsCapability} selected={selectedTool} onSelect={selectTool} />
          </>
        )}
      </aside>

      <main className="main">
        <header className="topbar">
          <div className="topbar-title">
            <h2>{selectedName || '选择一个协议方法或 Tool'}</h2>
            <p>{selectedDesc || '先配置 MCP endpoint，再连接 Server 并调用协议方法或 Tool。'}</p>
          </div>
          <div className="actions">
            <button className="btn config-management-btn" title="管理保存在当前浏览器 localStorage 的 MCP 配置" onClick={openConfigPanel}>配置管理</button>
          </div>
        </header>

        <section className="connection-strip" aria-label="当前 MCP Client-Server 连接">
          <div className="wire-node">
            <span className={`wire-light ${health.kind}`} />
            <div>
              <strong>{health.text}</strong>
              <small>{config.transport === 'stdio' ? 'stdio transport relay' : 'Streamable HTTP proxy'}</small>
            </div>
          </div>
          <div className="route-line">
            <span>Client</span>
            <code>{effectiveEndpoint(config)}</code>
            <span>Server</span>
          </div>
          <div className="wire-meta">
            <span>protocol <b>{negotiatedProtocolVersion || config.protocolVersion}</b></span>
            <span>session <b>{sessionId ? 'active' : 'none'}</b></span>
            <span>config <b>{activeProfile ? configLifecycleLabel(activeProfile.status) : configSaved ? 'local' : 'default'}</b></span>
          </div>
          <div className="connection-controls" aria-label="当前 MCP 操作">
            <button className="btn" type="button" title="对当前 MCP Server 执行 initialize，并刷新 capabilities/tools" disabled={currentConnectionBusy} onClick={() => void initializeCurrentConnection()}>初始化</button>
            <button
              className={`connection-power-switch ${activeConfigEnabled ? 'on' : ''}`}
              type="button"
              role="switch"
              aria-checked={activeConfigEnabled}
              disabled={currentConnectionBusy}
              title={activeConfigEnabled ? '进入 shutdown，关闭当前 session 或 stdio 进程' : '完成初始化并进入 operation phase，允许调用'}
              onClick={() => void toggleCurrentConnection()}
            >
              <span />
              <b>{activeConfigEnabled ? '已开启' : '开启'}</b>
            </button>
          </div>
        </section>

        <ConnectionLifecycle lifecycle={lifecycle} sessionId={sessionId} />

        <ConfigPanel
          open={configOpen}
          draft={draftConfig}
          savedConfigs={savedConfigs}
          setDraft={setDraftConfig}
          onSaveProfile={saveDraftProfile}
          onToggleProfile={(profile) => void toggleSavedProfile(profile)}
          onDeleteProfile={(profile) => void deleteSavedProfile(profile)}
          activeProfileId={activeProfileId}
          onUseProfile={selectSavedProfile}
          onClose={() => setConfigOpen(false)}
          endpoint={effectiveEndpoint(config)}
        />
        <HelpPanel open={helpOpen} onClose={() => setHelpOpen(false)} />

        <section className="workspace">
          <section className="panel">
            <div className="panel-head">
              <h3>请求参数</h3>
              <div className="panel-head-actions">
                {activeTab === 'tools' && (
                  <div className="mode-tabs" aria-label="编辑模式">
                    <button className={`tab ${mode === 'form' ? 'active' : ''}`} title="按工具 schema 生成表单" onClick={() => setMode('form')}>表单</button>
                    <button className={`tab ${mode === 'json' ? 'active' : ''}`} title="直接编辑 arguments JSON" onClick={() => setMode('json')}>JSON</button>
                  </div>
                )}
                <div className="request-actions">
                  <button className="btn" title="复制当前会发送的 JSON-RPC 请求" onClick={() => void copyPayload()}>复制请求</button>
                  <button className="btn primary" title={!activeConfigEnabled ? '当前配置未进入 operation phase' : activeTab !== 'tools' && !currentProtocol?.clientCallable ? '当前 Server 未声明该能力，或该方法不是 Client 可主动发起的方向' : '发送当前 JSON-RPC 请求'} disabled={!canCallSelected} onClick={() => void callSelected()}>{calling ? '调用中' : '调用'}</button>
                </div>
              </div>
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

function ConnectionLifecycle({lifecycle, sessionId}: {lifecycle: LifecycleState; sessionId: string}) {
  return (
    <section className="lifecycle-strip" aria-label="MCP 生命周期与会话">
      <div className="session-card">
        <span className="session-label">MCP-Session-Id</span>
        <code title={sessionId || '当前服务未返回 MCP-Session-Id'}>{sessionId || 'not returned'}</code>
        <button className="mini-btn" type="button" disabled={!sessionId} title="复制完整 session id" onClick={() => void copyToClipboard(sessionId)}>复制</button>
      </div>
      <div className="lifecycle-steps">
        {LIFECYCLE_STEPS.map((step) => (
          <div className={`lifecycle-step ${lifecycle[step.key]}`} key={step.key} title={step.description}>
            <span className="lifecycle-dot" />
            <div>
              <b>{step.label}</b>
              <small>{lifecycleStepStatusText(step.key, lifecycle[step.key])}</small>
            </div>
          </div>
        ))}
      </div>
    </section>
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

  if (!methods.length) return <div className="empty">没有匹配的协议方法</div>;
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
  if (toolsCapability === null) return <div className="empty">连接成功后，如果 Server 声明 tools capability，这里会显示 Tools 列表。</div>;
  if (!toolsCapability) return <div className="empty">当前 Server 未声明 tools capability，因此没有可调用 Tool。</div>;
  if (totalCount === 0) return <div className="empty">当前 Server 声明了 tools capability，但 tools/list 没有返回 Tool。</div>;
  if (!tools.length) return <div className="empty">没有匹配的 Tool，请调整搜索关键词。</div>;
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
  savedConfigs,
  setDraft,
  onSaveProfile,
  onToggleProfile,
  onDeleteProfile,
  activeProfileId,
  onUseProfile,
  onClose,
  endpoint
}: {
  open: boolean;
  draft: ConfigDraft;
  savedConfigs: SavedConfigProfile[];
  setDraft: (draft: ConfigDraft) => void;
  onSaveProfile: () => void;
  onToggleProfile: (profile: SavedConfigProfile) => void;
  onDeleteProfile: (profile: SavedConfigProfile) => void;
  activeProfileId: string;
  onUseProfile: (profile: SavedConfigProfile) => void;
  onClose: () => void;
  endpoint: string;
}) {
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const listPaneRef = useRef<HTMLDivElement | null>(null);
  const detailPaneRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    if (open) scrollConfigPanes();
  }, [open]);
  if (!open) return null;
  const update = (patch: Partial<ConfigDraft>) => setDraft({...draft, ...patch});
  const localStdioAvailable = canUseLocalStdio();
  const canSubmitDraft = draft.transport !== 'stdio' || localStdioAvailable;
  const scrollConfigPanes = () => window.requestAnimationFrame(() => {
    bodyRef.current?.scrollTo({top: 0, left: 0});
    listPaneRef.current?.scrollTo({top: 0, left: 0});
    detailPaneRef.current?.scrollTo({top: 0, left: 0});
  });
  const newConfig = () => {
    setDraft(configToDraft(NEW_CONFIG_PRESET));
    scrollConfigPanes();
  };
  const applyPreset = () => {
    setDraft(configToDraft(DEMO_LOCAL_PRESET));
    scrollConfigPanes();
  };
  const applySavedConfig = (profile: SavedConfigProfile) => {
    setDraft(configToDraft(profile));
    scrollConfigPanes();
  };
  const draftEndpoint = draft.transport === 'stdio' ? draft.stdioCommand || '未填写本地命令' : draft.targetUrl || endpoint;
  const draftTransportLabel = draft.transport === 'stdio' ? 'stdio transport' : 'Streamable HTTP';
  const draftProfile = findDraftSavedProfile(savedConfigs, draft);
  const draftStatus = draftProfile?.status || 'created';
  const importConfig = () => {
    try {
      const parsed = parseMcpServerConfig(draft.importText);
      if (parsed.transport === 'stdio' && !localStdioAvailable) {
        throw new Error('stdio transport 只能在本机同源 Web Console 中配置；服务器模式后续开发。');
      }
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
            <p>选择 transport、填写 MCP Server endpoint 或本地命令，并声明 Client 身份。</p>
          </div>
          <button className="icon-btn" type="button" title="关闭配置" aria-label="关闭配置" onClick={onClose}>x</button>
        </div>

        <div className="drawer-body config-manager-body" ref={bodyRef}>
          <section className="config-manager">
            <div className="config-list-pane" ref={listPaneRef}>
              <div className="section-kicker">
                <span>快速接入</span>
                <small>保存在当前浏览器</small>
              </div>
              <button className="preset-card new-config-card" type="button" onClick={newConfig}>
                <b>新建配置</b>
                <span>创建一条 Streamable HTTP MCP Server 配置，保存后出现在快速接入。</span>
              </button>
              <button className="preset-card" type="button" onClick={applyPreset}>
                <b>本地 Demo MCP</b>
                <span>使用 /api/mcp 验证初始化、Tools 列表和 JSON-RPC 调用流程。</span>
              </button>
              <div className="saved-profile-list">
                {savedConfigs.length ? savedConfigs.map((profile) => {
                  const isCurrentPage = activeProfileId === profile.id;
                  const isEnabled = profile.status === 'enabled';
                  return (
                    <div
                      className={`profile-row ${draftProfile?.id === profile.id ? 'active' : ''} ${isCurrentPage ? 'current-page' : ''}`}
                      role="button"
                      tabIndex={0}
                      key={profile.id}
                      title={effectiveEndpoint(profile)}
                      onClick={() => applySavedConfig(profile)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === 'Enter' || event.key === ' ') {
                          event.preventDefault();
                          applySavedConfig(profile);
                        }
                      }}
                    >
                      <span className={`profile-status ${profile.status}`}>{configLifecycleLabel(profile.status)}</span>
                      <b>{profile.name}</b>
                      <button
                        className={`profile-use-switch ${isEnabled ? 'on' : ''}`}
                        type="button"
                        role="switch"
                        aria-checked={isEnabled}
                        title={isEnabled ? '关闭这条 MCP 配置' : '开启这条 MCP 配置并设为当前页面'}
                        onClick={(event) => {
                          event.stopPropagation();
                          onToggleProfile(profile);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        <span />
                      </button>
                      <button
                        className="profile-delete-btn"
                        type="button"
                        title="删除这条浏览器本地配置"
                        aria-label={`删除 ${profile.name}`}
                        onClick={(event) => {
                          event.stopPropagation();
                          onDeleteProfile(profile);
                        }}
                        onKeyDown={(event) => {
                          event.stopPropagation();
                        }}
                      >
                        删除
                      </button>
                      <small>{transportLabel(profile)} · {effectiveEndpoint(profile)}</small>
                      <em>{isCurrentPage ? '当前页面' : formatSavedAt(profile.savedAt)}</em>
                    </div>
                  );
                }) : <div className="empty compact">还没有保存的 MCP 配置</div>}
              </div>
            </div>

            <div className="config-detail-pane" ref={detailPaneRef}>
              <section className="config-section lifecycle-config-section">
                <div className="section-kicker">
                  <span>配置详情</span>
                  <small>保存后出现在快速接入列表</small>
                </div>
                <div className="config-lifecycle-card">
                  <div>
                    <span className={`profile-status ${draftStatus}`}>{configLifecycleLabel(draftStatus)}</span>
                    <strong>{draftProfile?.name || configProfileName(draftToPartialConfig(draft))}</strong>
                    <code>{draftEndpoint}</code>
                  </div>
                  {draftProfile?.lastError ? <p>{draftProfile.lastError}</p> : <p>配置、状态和最近操作时间都保存在当前浏览器 localStorage。</p>}
                </div>
                <div className="field config-name-field">
                  <LabelWithHelp label="配置名称" help="只用于当前浏览器里的快速接入列表，方便区分相同 endpoint 或不同环境。" />
                  <input value={draft.name} onChange={(event) => update({name: event.target.value})} type="text" placeholder={configProfileName(draftToPartialConfig(draft))} />
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
              placeholder={MCP_SERVER_CONFIG_PLACEHOLDER}
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
              <span>Transport</span>
              <small>{draft.transport === 'stdio' ? 'stdio transport' : 'Streamable HTTP transport'}</small>
            </div>
            <div className="config-page-tabs" role="tablist" aria-label="Transport">
              <button className={draft.transport === 'proxy' ? 'active' : ''} role="tab" aria-selected={draft.transport === 'proxy'} type="button" onClick={() => update({transport: 'proxy'})}>
                Streamable HTTP
              </button>
              <button className={draft.transport === 'stdio' ? 'active' : ''} role="tab" aria-selected={draft.transport === 'stdio'} type="button" onClick={() => update({transport: 'stdio'})}>
                stdio
              </button>
            </div>
            {draft.transport === 'stdio' ? (
              <div className="connection-page">
                {localStdioAvailable ? (
                  <div className="stdio-config-grid">
                    <div className="field">
                      <LabelWithHelp label="Command" help="本机 Web Console 后端要启动的 stdio MCP 命令，例如 node、python，或某个 MCP 可执行文件的绝对路径。" />
                      <input value={draft.stdioCommand} onChange={(event) => update({stdioCommand: event.target.value})} type="text" placeholder="/path/to/mcp-server" />
                    </div>
                    <div className="field">
                      <LabelWithHelp label="Arguments JSON" help={'命令参数数组，例如 ["server.js", "--stdio"]。必须是 JSON array。'} />
                      <JsonTextEditor
                        value={draft.stdioArgsText}
                        onChange={(value) => update({stdioArgsText: value})}
                        validate={(value) => parseJsonArray(value, 'Arguments JSON')}
                        hint="只保存在当前浏览器；命令会由本机 Web Console 后端启动。"
                        placeholder={STDIO_ARGS_PLACEHOLDER}
                        minRows={4}
                        compact
                      />
                    </div>
                    <div className="field">
                      <LabelWithHelp label="Working Directory" help="启动 stdio MCP 命令时使用的工作目录。留空则使用 Web Console 后端所在目录。" />
                      <input value={draft.stdioCwd} onChange={(event) => update({stdioCwd: event.target.value})} type="text" placeholder="/path/to/project" />
                    </div>
                  </div>
                ) : (
                  <div className="local-only-notice">
                    <b>stdio transport 只能本机调试</b>
                    <p>当前页面不是从本机同源 Web Console 打开，因此不能按 stdio transport 启动浏览器所在电脑上的 MCP Server。服务器部署场景的 stdio 管理功能后续开发。</p>
                    <code>请使用 http://127.0.0.1:8765 或 http://localhost:8765 打开本机服务</code>
                  </div>
                )}
              </div>
            ) : (
              <div className="connection-page">
                <div className="field">
                  <LabelWithHelp label="MCP Endpoint" help="Streamable HTTP transport 的 MCP endpoint；Web Console 后端会向这里转发 JSON-RPC POST 请求。" />
                  <input value={draft.targetUrl} onChange={(event) => update({targetUrl: event.target.value})} type="text" placeholder="https://mcp.example.com/mcp" />
                </div>
              </div>
            )}
            <label className="checkbox-row keepalive-row">
              <input type="checkbox" checked={draft.keepAlive} onChange={(event) => update({keepAlive: event.target.checked})} />
              <span>保持连接</span>
              <small>{draft.transport === 'stdio' ? '开启后切换到其他 Server 时保留这个本地进程；关闭则切换时主动断开。' : '开启后切换到其他 Server 时保留当前 MCP session；关闭则切换时清掉本地会话记录。'}</small>
            </label>
          </section>

          <section className="config-section">
            <div className="section-kicker">
              <span>客户端身份</span>
              <small>initialize 参数</small>
            </div>
            <div className="config-two-col">
              <div className="field">
                <LabelWithHelp label="Client Name" help="initialize.clientInfo.name，用来让 MCP Server 识别当前 Client。" />
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
              <small>{draft.transport === 'stdio' ? '默认 Tool 参数会参与表单预填' : 'Headers 只发送给目标 MCP Server'}</small>
            </div>
            {draft.transport === 'proxy' ? (
              <JsonTextEditor
                label={<LabelWithHelp label="HTTP Headers JSON" help="用于 Authorization、X-Database 等请求头。MCP-Session-Id 会由页面自动维护，不建议手填。" />}
                value={draft.headersText}
                onChange={(value) => update({headersText: value})}
                validate={(value) => parseJsonObject(value, 'HTTP Headers JSON')}
                hint="只会发送给目标 MCP 服务，保存位置是当前浏览器 localStorage。"
                placeholder={HEADERS_JSON_PLACEHOLDER}
              />
            ) : null}
            <JsonTextEditor
              label={<LabelWithHelp label="默认 Tool 参数 JSON" help="选择 Tool 时会预填到 arguments，适合放项目、环境、租户等普通参数。" />}
              value={draft.defaultArgsText}
              onChange={(value) => update({defaultArgsText: value})}
              validate={(value) => parseJsonObject(value, '默认 Tool 参数 JSON')}
              hint="选择 Tool 时会预填到 arguments，可在调用前继续改。"
              placeholder={DEFAULT_ARGS_JSON_PLACEHOLDER}
            />
          </section>
            </div>
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
            <button className="btn primary persistent-save-btn" type="button" disabled={!canSubmitDraft} title="保存为浏览器本地配置" onClick={onSaveProfile}>保存配置</button>
            <button className="btn" type="button" onClick={onClose}>关闭面板</button>
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
            <p>这张控制台模拟 MCP Client 接入 Server 的最短路径。</p>
          </div>
          <button className="icon-btn" type="button" title="关闭帮助" aria-label="关闭帮助" onClick={onClose}>x</button>
        </div>
        <div className="help-steps">
          <article>
            <b>新建配置</b>
            <p>打开配置管理，选择 Streamable HTTP 或 stdio，填写 endpoint、Header、命令参数和 Client 身份。</p>
          </article>
          <article>
            <b>保存到浏览器</b>
            <p>在配置管理中填写名称、endpoint 和 Client 身份，点击保存后会写入当前浏览器 localStorage。</p>
          </article>
          <article>
            <b>选择当前配置</b>
            <p>快速接入列表中点击卡片编辑配置；打开卡片开关会设为当前页面并建立连接，关闭开关会断开。</p>
          </article>
          <article>
            <b>初始化 MCP</b>
            <p>首页当前 MCP 连接条中的初始化按钮会执行 initialize、initialized notification 和 tools/list；完成后会清理连接。</p>
          </article>
          <article>
            <b>开启调试</b>
            <p>首页当前 MCP 连接条中的开关控制当前配置进入 operation phase 或 shutdown；进入 operation phase 后才允许调用协议方法或 Tool。</p>
          </article>
          <article>
            <b>专用 Tools 调试</b>
            <p>Tools 页支持 tools/list、schema 表单、arguments JSON 和 tools/call，适合测试 Server 暴露的 Tool 能力。</p>
          </article>
          <article>
            <b>协议方法调试</b>
            <p>Resources、Prompts、Completion、Logging 等能力会按 Server capabilities 显示独立入口；当前可手工编辑 JSON-RPC 调试，暂无专用浏览器。</p>
          </article>
          <article>
            <b>暂不支持的 Client features</b>
            <p>Roots、Sampling、Elicitation 属于 Server 向 Client 发起的请求；当前控制台不声明这些 Client capabilities，也不实现对应 handler。</p>
          </article>
          <article>
            <b>删除配置</b>
            <p>快速接入列表项上的删除按钮会移除当前浏览器里的配置，并尝试断开对应连接。</p>
          </article>
          <article>
            <b>刷新页面</b>
            <p>刷新会丢失页面内存里的 session，已进入 operation phase 的配置会回到已关闭；需要重新开启后再调用。</p>
          </article>
          <article>
            <b>stdio transport 边界</b>
            <p>stdio transport 只在 Web Console 本机同源访问时可用；远端部署页面不能启动用户电脑上的本地命令。</p>
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
  if (activeTab !== 'tools') {
    return <JsonEditor label="MCP JSON-RPC 请求" hint={`协议方法会通过当前 transport 发送到 ${endpoint}`} value={args} onChange={setArgs} />;
  }
  if (!selectedTool) return <div className="form"><div className="empty">请选择 Tool</div></div>;
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
  if (!names.length) return <div className="form"><div className="empty">该 Tool 没有参数</div></div>;
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
      placeholder={ARRAY_VALUE_PLACEHOLDER}
      validate={(next) => parseJsonArray(next, '数组参数')}
      hint="数组参数会按 JSON 原始类型传给 Tool。"
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
      placeholder={OBJECT_VALUE_PLACEHOLDER}
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
  const embeddedJson = typeof value === 'string' ? parseEmbeddedJsonString(value) : null;
  const embeddedRawText = typeof value === 'string' ? value : '';
  const [open, setOpen] = useState(true);
  useEffect(() => {
    if (expandSignal > 0) setOpen(expandOpen);
  }, [expandSignal, expandOpen]);

  if (embeddedJson && isJsonContainer(embeddedJson)) {
    return (
      <div className="json-node embedded-json-node">
        <div className="json-node-line">
          <button className="json-toggle" type="button" title={open ? '折叠节点' : '展开节点'} aria-label={open ? '折叠节点' : '展开节点'} onClick={() => setOpen(!open)}>{open ? 'v' : '>'}</button>
          <span className="json-key">{formatJsonKey(name)}</span>
          <span className="json-embedded-label">JSON 字符串</span>
          <span className="json-raw-preview" title={embeddedRawText}>{embeddedJsonPreview(embeddedRawText)}</span>
        </div>
        {open ? (
          <div className="json-children embedded-json-children">
            <JsonNode name="parsed" value={embeddedJson} level={level + 1} expandSignal={expandSignal} expandOpen={expandOpen} />
          </div>
        ) : null}
      </div>
    );
  }

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

function capabilityTabs(capabilities: JsonObject, methods: ProtocolMethod[], toolsCount: number, toolsCapability: boolean | null): CapabilityTab[] {
  const tabs: CapabilityTab[] = [
    {key: 'protocol', label: 'Protocol', title: '查看全部 MCP 协议方法'}
  ];
  if (toolsCapability || capabilities.tools) {
    tabs.push({key: 'tools', label: 'Tools', title: '调试 Server 暴露的 Tools', count: toolsCount});
  }
  const entries: {key: TabName; label: string; capability: string | string[]; category: string; title: string}[] = [
    {key: 'resources', label: 'Resources', capability: 'resources', category: 'resources', title: '调试 Server 暴露的 Resources 协议方法'},
    {key: 'prompts', label: 'Prompts', capability: 'prompts', category: 'prompts', title: '调试 Server 暴露的 Prompts 协议方法'},
    {key: 'completion', label: 'Completion', capability: ['completion', 'completions'], category: 'completion', title: '调试 Completion 协议方法'},
    {key: 'logging', label: 'Logging', capability: 'logging', category: 'logging', title: '调试 Logging 协议方法'}
  ];
  for (const entry of entries) {
    const capabilityNames = Array.isArray(entry.capability) ? entry.capability : [entry.capability];
    if (!capabilityNames.some((name) => Boolean(capabilities[name]))) continue;
    tabs.push({
      key: entry.key,
      label: entry.label,
      title: entry.title,
      count: methods.filter((method) => method.category === entry.category && method.supported).length
    });
  }
  return tabs;
}

function protocolMethodsForTab(methods: ProtocolMethod[], tab: TabName) {
  if (tab === 'tools') return [];
  if (tab === 'protocol') return methods;
  return methods.filter((method) => method.category === tab);
}

function tabLabel(tab: TabName) {
  if (tab === 'protocol') return 'Protocol';
  if (tab === 'tools') return 'Tools';
  return CATEGORY_NAMES[tab] || tab;
}

function canUseLocalStdio() {
  try {
    if (window.location.protocol === 'file:') return false;
    const apiOrigin = new URL(apiUrl('/api/health')).origin;
    return apiOrigin === window.location.origin && isLoopbackBrowserHost(window.location.hostname);
  } catch {
    return false;
  }
}

function isLoopbackBrowserHost(value: string) {
  const normalized = String(value || '').replace(/^\[|\]$/g, '').toLowerCase();
  return normalized === 'localhost' || normalized === '::1' || normalized === '127.0.0.1' || normalized.startsWith('127.');
}

function createLifecycleState(): LifecycleState {
  return {
    initialize: 'idle',
    initialized: 'idle',
    toolsList: 'idle',
    ready: 'idle',
    terminated: 'idle'
  };
}

function createLifecycleStateForProfile(status: ConfigLifecycleStatus): LifecycleState {
  if (status === 'initialized') {
    return {
      initialize: 'done',
      initialized: 'done',
      toolsList: 'done',
      ready: 'idle',
      terminated: 'done'
    };
  }
  if (status === 'enabled') {
    return {
      initialize: 'done',
      initialized: 'done',
      toolsList: 'done',
      ready: 'done',
      terminated: 'idle'
    };
  }
  if (status === 'disabled') {
    return {
      initialize: 'idle',
      initialized: 'idle',
      toolsList: 'idle',
      ready: 'idle',
      terminated: 'done'
    };
  }
  if (status === 'error') {
    return {
      initialize: 'error',
      initialized: 'idle',
      toolsList: 'idle',
      ready: 'error',
      terminated: 'idle'
    };
  }
  return createLifecycleState();
}

function markLifecycleError(lifecycle: LifecycleState): LifecycleState {
  const next = {...lifecycle};
  const running = LIFECYCLE_STEPS.find((step) => next[step.key] === 'running');
  if (running) {
    next[running.key] = 'error';
  } else if (next.ready !== 'done') {
    next.ready = 'error';
  }
  return next;
}

function lifecycleStatusText(status: LifecycleStatus) {
  if (status === 'running') return '进行中';
  if (status === 'done') return '完成';
  if (status === 'skipped') return '跳过';
  if (status === 'error') return '失败';
  return '等待';
}

function lifecycleStepStatusText(step: LifecycleStep, status: LifecycleStatus) {
  if (step === 'ready') {
    if (status === 'done') return '已开启';
    if (status === 'running') return '开启中';
    if (status === 'error') return '开启失败';
    return '未开启';
  }
  if (step === 'terminated') {
    if (status === 'done') return '已关闭';
    if (status === 'running') return '关闭中';
    if (status === 'error') return '关闭失败';
    return '未关闭';
  }
  return lifecycleStatusText(status);
}

function hasSavedConfig() {
  try {
    return Boolean(localStorage.getItem(STORAGE_KEY) || localStorage.getItem(SAVED_CONFIGS_KEY));
  } catch {
    return false;
  }
}

function loadActiveProfileId() {
  try {
    return localStorage.getItem(ACTIVE_PROFILE_KEY) || '';
  } catch {
    return '';
  }
}

function isClientCallable(method: ProtocolMethod) {
  return method.direction === 'client_to_server' || method.direction === 'bidirectional';
}

function protocolBadgeText(method: ProtocolMethod) {
  if (method.clientCallable) return 'Client 可调用';
  if (method.supported) return '已声明';
  return '未声明';
}

function protocolStatusText(method: ProtocolMethod) {
  if (method.clientCallable) return '当前 Client 可主动发起';
  if (method.supported) return '当前 Server 已声明，等待 Server 发起';
  return '当前 Server 未声明';
}

function protocolSupportSource(method: ProtocolMethod, supported: boolean, source: string) {
  if (!supported) return '当前 Server 未声明该 capability，控制台不会直接调用';
  if (!isClientCallable(method)) return '当前 Server 声明了该 server-to-client 方法；它不是 Client 可主动发起的调用';
  return source;
}

function loadConfig(): McpConfig {
  const fallbackBase = window.location.protocol === 'file:' ? 'http://127.0.0.1:8765' : window.location.origin;
  const defaultConfig = {
    transport: 'proxy' as const,
    baseUrl: `${fallbackBase}/api/mcp-proxy`,
    targetUrl: `${fallbackBase}/api/mcp`,
    stdioCommand: '',
    stdioArgs: [],
    stdioCwd: '',
    keepAlive: false,
    clientName: 'mcp-agent-console',
    protocolVersion: DEFAULT_PROTOCOL_VERSION,
    headers: {},
    defaultArgs: {}
  };
  try {
    const raw = localStorage.getItem(STORAGE_KEY) || '{}';
    const saved = JSON.parse(raw) as Partial<McpConfig> & Record<string, unknown>;
    const transport = saved.transport === 'stdio' ? 'stdio' : 'proxy';
    const savedTargetUrl = typeof saved.targetUrl === 'string' ? saved.targetUrl : '';
    const legacyBaseUrl = typeof saved.baseUrl === 'string' && !isInternalProxyUrl(saved.baseUrl) ? saved.baseUrl : '';
    return {
      transport,
      baseUrl: defaultConfig.baseUrl,
      targetUrl: normalizeEndpoint(savedTargetUrl || legacyBaseUrl || defaultConfig.targetUrl),
      stdioCommand: typeof saved.stdioCommand === 'string' ? saved.stdioCommand : '',
      stdioArgs: Array.isArray(saved.stdioArgs) ? saved.stdioArgs.map((item) => String(item)) : [],
      stdioCwd: typeof saved.stdioCwd === 'string' ? saved.stdioCwd : '',
      keepAlive: saved.keepAlive === true,
      clientName: typeof saved.clientName === 'string' && saved.clientName ? saved.clientName : defaultConfig.clientName,
      protocolVersion: typeof saved.protocolVersion === 'string' && saved.protocolVersion ? saved.protocolVersion : defaultConfig.protocolVersion,
      headers: objectValue(saved.headers),
      defaultArgs: objectValue(saved.defaultArgs)
    };
  } catch {
    return defaultConfig;
  }
}

function loadSavedConfigProfiles(): SavedConfigProfile[] {
  try {
    const raw = localStorage.getItem(SAVED_CONFIGS_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    const profiles = Array.isArray(parsed)
      ? parsed.map(normalizeSavedConfigProfile).filter((profile): profile is SavedConfigProfile => Boolean(profile))
      : [];
    if (profiles.length) return profiles.map(resetVolatileSavedConfigStatus);
    const legacyRaw = localStorage.getItem(STORAGE_KEY);
    if (!legacyRaw) return [];
    const legacy = normalizeSavedConfigProfile({...JSON.parse(legacyRaw), savedAt: new Date().toISOString()});
    return legacy ? [resetVolatileSavedConfigStatus(legacy)] : [];
  } catch {
    return [];
  }
}

function normalizeSavedConfigProfile(value: unknown): SavedConfigProfile | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const item = value as Partial<SavedConfigProfile> & Record<string, unknown>;
  const transport = item.transport === 'stdio' ? 'stdio' : 'proxy';
  const fallbackBase = apiUrl('/api/mcp');
  const itemTargetUrl = typeof item.targetUrl === 'string' ? item.targetUrl : '';
  const legacyBaseUrl = typeof item.baseUrl === 'string' && !isInternalProxyUrl(item.baseUrl) ? item.baseUrl : '';
  const profile: SavedConfigProfile = {
    id: typeof item.id === 'string' && item.id ? item.id : configProfileId(item),
    name: typeof item.name === 'string' && item.name ? item.name : configProfileName(item),
    transport,
    baseUrl: apiUrl('/api/mcp-proxy'),
    targetUrl: normalizeEndpoint(itemTargetUrl || legacyBaseUrl || fallbackBase),
    stdioCommand: typeof item.stdioCommand === 'string' ? item.stdioCommand : '',
    stdioArgs: Array.isArray(item.stdioArgs) ? item.stdioArgs.map((entry) => String(entry)) : [],
    stdioCwd: typeof item.stdioCwd === 'string' ? item.stdioCwd : '',
    keepAlive: item.keepAlive === true,
    clientName: typeof item.clientName === 'string' && item.clientName ? item.clientName : 'mcp-agent-console',
    protocolVersion: typeof item.protocolVersion === 'string' && item.protocolVersion ? item.protocolVersion : DEFAULT_PROTOCOL_VERSION,
    headers: objectValue(item.headers),
    defaultArgs: objectValue(item.defaultArgs),
    savedAt: typeof item.savedAt === 'string' && item.savedAt ? item.savedAt : new Date().toISOString(),
    status: normalizeConfigLifecycleStatus(item.status, true),
    lastError: typeof item.lastError === 'string' ? item.lastError : ''
  };
  if (profile.transport === 'proxy' && !profile.targetUrl) return null;
  if (profile.transport === 'stdio' && !profile.stdioCommand) return null;
  return profile;
}

function resetVolatileSavedConfigStatus(profile: SavedConfigProfile): SavedConfigProfile {
  return profile.status === 'enabled' ? {...profile, status: 'disabled'} : profile;
}

function upsertSavedConfigProfile(profiles: SavedConfigProfile[], config: McpConfig, status?: ConfigLifecycleStatus, profileId = '', name = '') {
  const id = profileId || createSavedConfigId(config);
  const existing = profiles.find((profile) => profile.id === id);
  const profileName = normalizeProfileName(name) || existing?.name || configProfileName(config);
  const nextProfile: SavedConfigProfile = {
    ...config,
    id,
    name: profileName,
    savedAt: new Date().toISOString(),
    status: status || existing?.status || 'created',
    lastError: status === 'error' ? existing?.lastError || '' : ''
  };
  return [nextProfile, ...profiles.filter((profile) => profile.id !== id)].slice(0, 12);
}

function normalizeProfileName(value: string) {
  return value.trim().replace(/\s+/g, ' ').slice(0, 80);
}

function createSavedConfigId(config: Partial<McpConfig>) {
  const prefix = config.transport === 'stdio' ? 'stdio' : 'proxy';
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return `${prefix}:${crypto.randomUUID()}`;
  }
  return `${prefix}:${Date.now().toString(36)}:${Math.random().toString(36).slice(2, 10)}`;
}

function normalizeConfigLifecycleStatus(value: unknown, fromStorage = false): ConfigLifecycleStatus {
  if (fromStorage && value === 'enabled') return 'disabled';
  if (value === 'initialized' || value === 'enabled' || value === 'disabled' || value === 'error') return value;
  return 'created';
}

function configLifecycleLabel(status: ConfigLifecycleStatus) {
  if (status === 'initialized') return '已初始化';
  if (status === 'enabled') return '已开启';
  if (status === 'disabled') return '已关闭';
  if (status === 'error') return '异常';
  return '已创建';
}

function draftToPartialConfig(draft: ConfigDraft): Partial<McpConfig> {
  return {
    transport: draft.transport,
    targetUrl: normalizeEndpoint(draft.targetUrl),
    stdioCommand: draft.stdioCommand,
    stdioArgs: safeParseJsonArray(draft.stdioArgsText),
    stdioCwd: draft.stdioCwd
  };
}

function findDraftSavedProfile(profiles: SavedConfigProfile[], draft: ConfigDraft) {
  if (draft.profileId) return profiles.find((profile) => profile.id === draft.profileId);
  return profiles.find((profile) => profile.id === configProfileId(draftToPartialConfig(draft)));
}

function sameConnectionTarget(a: Partial<McpConfig>, b: Partial<McpConfig>) {
  if (a.transport !== b.transport) return false;
  if (a.transport === 'stdio') {
    return String(a.stdioCommand || '').trim() === String(b.stdioCommand || '').trim()
      && JSON.stringify((a.stdioArgs || []).map((item) => String(item))) === JSON.stringify((b.stdioArgs || []).map((item) => String(item)))
      && String(a.stdioCwd || '').trim() === String(b.stdioCwd || '').trim();
  }
  return normalizeEndpoint(String(a.targetUrl || '')) === normalizeEndpoint(String(b.targetUrl || ''));
}

function configProfileId(config: Partial<McpConfig>) {
  const endpoint = config.transport === 'stdio' ? [config.stdioCommand, ...(config.stdioArgs || []), config.stdioCwd || ''].join(' ') : config.targetUrl;
  return `${config.transport === 'stdio' ? 'stdio' : 'proxy'}:${normalizeEndpoint(String(endpoint || ''))}`;
}

function configProfileName(config: Partial<McpConfig>) {
  if (config.transport === 'stdio') {
    const command = String(config.stdioCommand || '').trim();
  return command ? `stdio: ${command.split('/').pop()}` : 'stdio transport';
  }
  const endpoint = normalizeEndpoint(String(config.targetUrl || ''));
  if (!endpoint) return '未命名配置';
  try {
    const url = new URL(endpoint);
    const path = url.pathname.replace(/\/$/, '').split('/').filter(Boolean).pop();
    return path ? `${url.hostname}/${path}` : url.hostname;
  } catch {
    return endpoint.replace(/^https?:\/\//, '').replace(/\/$/, '');
  }
}

function formatSavedAt(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '已保存';
  return date.toLocaleString('zh-CN', {month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit'});
}

function transportLabel(config: Pick<McpConfig, 'transport'>) {
  return config.transport === 'stdio' ? 'stdio transport' : 'Streamable HTTP';
}

function configToDraft(config: McpConfig | SavedConfigProfile) {
  return {
    profileId: 'id' in config && typeof config.id === 'string' ? config.id : '',
    name: 'name' in config && typeof config.name === 'string' ? config.name : configProfileName(config),
    transport: config.transport,
    baseUrl: config.baseUrl,
    targetUrl: config.targetUrl,
    stdioCommand: config.stdioCommand,
    stdioArgsText: JSON.stringify(config.stdioArgs || [], null, 2),
    stdioCwd: config.stdioCwd,
    keepAlive: config.keepAlive,
    clientName: config.clientName,
    protocolVersion: config.protocolVersion,
    headersText: JSON.stringify(config.headers || {}, null, 2),
    defaultArgsText: JSON.stringify(config.defaultArgs || {}, null, 2),
    importText: '',
    importError: ''
  };
}

function draftToConfig(draft: ConfigDraft): McpConfig {
  const transport = draft.transport === 'stdio' ? 'stdio' : 'proxy';
  const baseUrl = apiUrl('/api/mcp-proxy');
  const targetUrl = normalizeEndpoint(draft.targetUrl.trim());
  const stdioCommand = draft.stdioCommand.trim();
  const stdioArgs = parseJsonArray(draft.stdioArgsText, 'Arguments JSON').map((item) => String(item));
  const stdioCwd = draft.stdioCwd.trim();
  if (transport === 'proxy' && !targetUrl) throw new Error('Streamable HTTP 模式必须填写 MCP endpoint');
  if (transport === 'stdio' && !stdioCommand) throw new Error('stdio transport 必须填写 Command');
  return {
    transport,
    baseUrl,
    targetUrl,
    stdioCommand,
    stdioArgs,
    stdioCwd,
    keepAlive: draft.keepAlive,
    clientName: draft.clientName.trim() || 'mcp-agent-console',
    protocolVersion: draft.protocolVersion.trim() || DEFAULT_PROTOCOL_VERSION,
    headers: parseJsonObject(draft.headersText, 'HTTP Headers JSON'),
    defaultArgs: parseJsonObject(draft.defaultArgsText, '默认 Tool 参数 JSON')
  };
}

function requestUrl(config: McpConfig) {
  return config.transport === 'stdio' ? apiUrl('/api/mcp-stdio') : apiUrl('/api/mcp-proxy');
}

function effectiveEndpoint(config: McpConfig) {
  return config.transport === 'stdio' ? `${config.stdioCommand} ${(config.stdioArgs || []).join(' ')}`.trim() : config.targetUrl;
}

function requestBody(payload: JsonObject, config: McpConfig): JsonObject {
  if (config.transport === 'stdio') {
    return {
      command: config.stdioCommand,
      args: config.stdioArgs,
      cwd: config.stdioCwd,
      restart: payload.method === 'initialize' && !config.keepAlive,
      reuse: payload.method === 'initialize' && config.keepAlive,
      payload
    };
  }
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
  const command = String(server.command || '').trim();
  if (command) {
    return {
      transport: 'stdio',
      baseUrl: apiUrl('/api/mcp-proxy'),
      targetUrl: '',
      stdioCommand: command,
      stdioArgs: Array.isArray(server.args) ? server.args.map((item) => String(item)) : [],
      stdioCwd: typeof server.cwd === 'string' ? server.cwd : '',
      keepAlive: server.keepAlive === true,
      clientName: 'mcp-agent-console',
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      headers: {},
      defaultArgs: {}
    };
  }
  const url = normalizeEndpoint(String(server.url || server.endpoint || server.baseUrl || ''));
  if (!url) throw new Error('配置里没有找到 url 或 command');
  const type = String(server.type || '').toLowerCase();
  const headers = objectValue(server.headers);
  return {
    transport: 'proxy',
    baseUrl: apiUrl('/api/mcp-proxy'),
    targetUrl: url,
    stdioCommand: '',
    stdioArgs: [],
    stdioCwd: '',
    keepAlive: server.keepAlive === true,
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
  if (parsed.url || parsed.endpoint || parsed.baseUrl || parsed.command) return parsed;
  const nested = Object.values(parsed).find((value) => {
    const object = objectValue(value);
    return value && typeof value === 'object' && !Array.isArray(value) && (object.url || object.command);
  });
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

function isInternalProxyUrl(value: string) {
  try {
    return new URL(value, window.location.origin).pathname === '/api/mcp-proxy';
  } catch {
    return value.includes('/api/mcp-proxy');
  }
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

function parseEmbeddedJsonString(value: string) {
  let current = value.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    if (!current) return null;
    const first = current[0];
    if (first === '{' || first === '[') {
      try {
        return JSON.parse(current) as JsonValue;
      } catch {
        return null;
      }
    }
    if (first !== '"') return null;
    try {
      const unwrapped = JSON.parse(current) as JsonValue;
      if (typeof unwrapped !== 'string') return unwrapped;
      current = unwrapped.trim();
    } catch {
      return null;
    }
  }
  return null;
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

function safeParseJsonArray(text: string): string[] {
  try {
    return parseJsonArray(text, 'Arguments JSON').map((item) => String(item));
  } catch {
    return [];
  }
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

function embeddedJsonPreview(value: string) {
  const normalized = value.replace(/\s+/g, ' ').trim();
  if (!normalized) return '原始字符串';
  return normalized.length > 80 ? `${normalized.slice(0, 77)}...` : normalized;
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
    '1. 如果使用 Streamable HTTP transport，确认 MCP endpoint 可由 Web Console 后端访问。',
    '2. 如果使用 Streamable HTTP transport，确认鉴权 Header 和 endpoint 路径正确。',
    '3. 如果使用 stdio transport，请确认 Web Console 后端运行在同一台电脑，且 Command / Arguments 正确。',
    '4. 如果 initialize 返回协议错误，检查 Protocol Version 和鉴权 Header。'
  ].join('\n');
}
