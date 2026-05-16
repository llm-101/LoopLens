import { useCallback, useEffect, useMemo, useState } from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import appLogo from "./assets/looplens-logo.svg";
import launchGraphic from "./assets/looplens-launch.svg";
import { isNativeRuntime, nativeInvoke } from "./native.js";
import {
  bodyText,
  buildLoopModel,
  buildUnifiedTimeline,
  clientLabel,
  clientKey,
  computeAnalytics,
  computeClientStats,
  diagnosticsForEnvironment,
  flowSearchText,
  formatTokenShort,
  formatBytes,
  formatTime,
  generateCurl,
  isNoiseFlow,
  isToolReady,
  methodClass,
  primaryLoopTitle,
  promptText,
  statusClass,
  sourceMatches,
  toolStatusLabel,
  usageTotal,
} from "./flowModel.js";
import {
  buildAgentLoopModel,
  formatCompactNumber,
  formatLoopTokens,
  stepStatusClass,
  stepTypeClass,
  usageTotal as loopUsageTotal,
} from "./loopModel.js";

const DEFAULT_LISTEN = "127.0.0.1:8899";
const TABS = ["Summary", "Parsed", "Prompt", "Response", "Raw", "Chunks"];
const VIEWS = ["AI Loop", "Network", "Timeline", "Tokens", "Raw"];
const LOOP_DETAIL_TABS = ["Summary", "Input", "Output", "Network", "Tokens", "Raw"];
const QUICK_FILTERS = [
  { label: "All", category: "All", status: "All" },
  { label: "Model", category: "Model", status: "All" },
  { label: "Tools", category: "Tool call", status: "All" },
  { label: "MCP", category: "MCP", status: "All" },
  { label: "Skills", category: "Skill", status: "All" },
  { label: "Errors", category: "All", status: "Errors" },
];

export default function App() {
  const native = isNativeRuntime();
  const [appInfo, setAppInfo] = useState(null);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [files, setFiles] = useState([]);
  const [captureIndex, setCaptureIndex] = useState({ file: null, flows: [], last_flow_id: null });
  const [claudeSessionIndex, setClaudeSessionIndex] = useState({
    project_dir: "",
    storage_dir: "",
    sessions: [],
    latest_session_id: null,
  });
  const [claudeSessionDetail, setClaudeSessionDetail] = useState({ session: null, messages: [] });
  const [activeFile, setActiveFile] = useState(null);
  const [activeFlowId, setActiveFlowId] = useState(null);
  const [flowDetail, setFlowDetail] = useState(null);
  const [activeTab, setActiveTab] = useState("Summary");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [hideNoise, setHideNoise] = useState(true);
  const [activeView, setActiveView] = useState("AI Loop");
  const [compareA, setCompareA] = useState(null);
  const [compareB, setCompareB] = useState(null);
  const [listen, setListen] = useState(DEFAULT_LISTEN);
  const [bodyLimit, setBodyLimit] = useState("0");
  const [captureAll, setCaptureAll] = useState(true);
  const [live, setLive] = useState(true);
  const [followLatest, setFollowLatest] = useState(true);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);

  const refreshStatus = useCallback(async () => {
    const status = await nativeInvoke("proxy_status");
    setProxyStatus(status);
    return status;
  }, []);

  const refreshEnvironment = useCallback(async () => {
    const status = await nativeInvoke("environment_status");
    setEnvironment(status);
    return status;
  }, []);

  const refreshFiles = useCallback(async () => {
    const nextFiles = await nativeInvoke("list_capture_files");
    setFiles(nextFiles);
    return nextFiles;
  }, []);

  const refreshIndex = useCallback(async (fileName = activeFile) => {
    const index = await nativeInvoke("read_capture_index", { name: fileName || null });
    setCaptureIndex(index);
    if (!fileName && index.file?.name) {
      setActiveFile(index.file.name);
    }
    setActiveFlowId((current) => {
      const ids = new Set((index.flows || []).map((flow) => flow.id));
      if (followLatest && index.last_flow_id) return index.last_flow_id;
      if (current && ids.has(current)) return current;
      return index.last_flow_id || null;
    });
    return index;
  }, [activeFile, followLatest]);

  const refreshClaudeSessions = useCallback(async () => {
    const index = await nativeInvoke("read_claude_session_index");
    setClaudeSessionIndex(index);
    const detail = await nativeInvoke("read_claude_session_detail", {
      sessionId: index.latest_session_id || null,
    });
    setClaudeSessionDetail(detail);
    return { index, detail };
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      setError(null);
      const [info] = await Promise.all([
        nativeInvoke("app_info"),
        refreshStatus(),
        refreshEnvironment(),
        refreshFiles(),
        refreshClaudeSessions(),
      ]);
      setAppInfo(info);
      await refreshIndex(activeFile);
    } catch (err) {
      setError(String(err));
    } finally {
      setBooting(false);
    }
  }, [activeFile, refreshClaudeSessions, refreshEnvironment, refreshFiles, refreshIndex, refreshStatus]);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      refreshStatus().catch(() => {});
      refreshFiles().catch(() => {});
      refreshIndex(activeFile).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [activeFile, live, refreshFiles, refreshIndex, refreshStatus]);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      refreshClaudeSessions().catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [live, refreshClaudeSessions]);

  const selectedFlow = useMemo(
    () => captureIndex.flows.find((flow) => flow.id === activeFlowId) || null,
    [activeFlowId, captureIndex.flows],
  );

  useEffect(() => {
    if (!activeFile || !activeFlowId) {
      setFlowDetail(null);
      return;
    }
    nativeInvoke("read_flow_detail", { name: activeFile, flowId: activeFlowId })
      .then(setFlowDetail)
      .catch((err) => setError(String(err)));
  }, [activeFile, activeFlowId, selectedFlow?.updated_at]);

  const sourceScopedFlows = useMemo(
    () => captureIndex.flows.filter((flow) => sourceMatches(flow, sourceFilter)),
    [captureIndex.flows, sourceFilter],
  );

  useEffect(() => {
    if (!activeFlowId) return;
    if (sourceScopedFlows.some((flow) => flow.id === activeFlowId)) return;
    setFlowDetail(null);
    setActiveFlowId(followLatest ? sourceScopedFlows.at(-1)?.id || null : null);
  }, [activeFlowId, followLatest, sourceScopedFlows]);

  const filteredFlows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return sourceScopedFlows.filter((flow) => {
      if (hideNoise && isNoiseFlow(flow)) return false;
      if (categoryFilter !== "All" && flow.semantic?.category !== categoryFilter) return false;
      if (statusFilter === "Errors" && Number(flow.status) < 400) return false;
      if (statusFilter === "2xx" && (Number(flow.status) < 200 || Number(flow.status) >= 300)) return false;
      if (statusFilter === "Pending" && flow.status) return false;
      return !needle || flowSearchText(flow).includes(needle);
    });
  }, [categoryFilter, hideNoise, query, sourceScopedFlows, statusFilter]);

  const analytics = useMemo(() => computeAnalytics(sourceScopedFlows), [sourceScopedFlows]);
  const clientStats = useMemo(() => computeClientStats(captureIndex.flows), [captureIndex.flows]);
  const categories = useMemo(() => ["All", ...analytics.categories.map((item) => item.name)], [analytics]);
  const compareFlowA = sourceScopedFlows.find((flow) => flow.id === compareA) || null;
  const compareFlowB = sourceScopedFlows.find((flow) => flow.id === compareB) || null;

  async function startProxy() {
    setBusy("proxy");
    try {
      setError(null);
      await nativeInvoke("start_proxy", { listen, bodyLimit, captureAll });
      await Promise.all([refreshStatus(), refreshEnvironment(), refreshFiles(), refreshIndex(activeFile)]);
      setLive(true);
      setFollowLatest(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function stopProxy() {
    setBusy("proxy");
    try {
      setError(null);
      await nativeInvoke("stop_proxy");
      await refreshStatus();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function runHelper(helper) {
    setBusy(helper);
    try {
      setError(null);
      await nativeInvoke("run_helper", { helper });
      await refreshEnvironment();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function openTool(tool) {
    setBusy(tool);
    try {
      setError(null);
      await nativeInvoke("start_proxy", { listen, bodyLimit, captureAll, forceNewCapture: true });
      await nativeInvoke("open_tool", { tool, listen });
      const [status, nextFiles, index] = await Promise.all([
        refreshStatus(),
        refreshFiles(),
        nativeInvoke("read_capture_index", { name: null }),
      ]);
      setProxyStatus(status);
      setFiles(nextFiles);
      setCaptureIndex(index);
      setActiveFile(index.file?.name || null);
      setActiveFlowId(index.last_flow_id || null);
      setFlowDetail(null);
      setLive(true);
      setFollowLatest(true);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  function selectFile(name) {
    setActiveFile(name);
    setActiveFlowId(null);
    setFlowDetail(null);
    setFollowLatest(true);
    refreshIndex(name).catch((err) => setError(String(err)));
  }

  function selectFlow(id) {
    setActiveFlowId(id);
    setFollowLatest(false);
  }

  return (
    <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
      <div className={`app ${native ? "native" : "preview"}`}>
      <LaunchScreen visible={booting} />
      <Sidebar
        appInfo={appInfo}
        proxyStatus={proxyStatus}
        environment={environment}
        files={files}
        activeFile={activeFile}
        sourceFilter={sourceFilter}
        clientStats={clientStats}
        native={native}
        listen={listen}
        bodyLimit={bodyLimit}
        captureAll={captureAll}
        busy={busy}
        onListenChange={setListen}
        onBodyLimitChange={setBodyLimit}
        onCaptureAllChange={setCaptureAll}
        onStartProxy={startProxy}
        onStopProxy={stopProxy}
        onRunHelper={runHelper}
        onOpenTool={openTool}
        onRefreshFiles={() => refreshFiles().then(() => refreshIndex(activeFile))}
        onRefreshEnvironment={refreshEnvironment}
        onSelectFile={selectFile}
        onSourceFilterChange={setSourceFilter}
      />

      <main className="workspace">
        <Toolbar
          query={query}
          onQueryChange={setQuery}
          live={live}
          onLiveChange={setLive}
          followLatest={followLatest}
          onFollowLatestChange={setFollowLatest}
          file={captureIndex.file}
          shownCount={filteredFlows.length}
          totalCount={sourceScopedFlows.length}
          proxyStatus={proxyStatus}
          sourceFilter={sourceFilter}
          activeView={activeView}
          onActiveViewChange={setActiveView}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          hideNoise={hideNoise}
          onHideNoiseChange={setHideNoise}
        />

        {error && <div className="error-banner" role="alert">{error}</div>}

        <SessionStrip analytics={analytics} />

        {activeView === "Network" ? (
          <div className="content">
            <FlowList
              flows={filteredFlows}
              activeFlowId={activeFlowId}
              compareA={compareA}
              compareB={compareB}
              onSelectFlow={selectFlow}
              onSetCompareA={setCompareA}
              onSetCompareB={setCompareB}
            />
            <FlowDetail
              detail={flowDetail}
              selectedFlow={selectedFlow}
              activeTab={activeTab}
              onTabChange={setActiveTab}
              native={native}
              proxyStatus={proxyStatus}
              hasFile={Boolean(captureIndex.file)}
              hasFlows={sourceScopedFlows.length > 0}
              onStartProxy={startProxy}
              onOpenTool={openTool}
              onSetCompareA={() => selectedFlow && setCompareA(selectedFlow.id)}
              onSetCompareB={() => selectedFlow && setCompareB(selectedFlow.id)}
            />
          </div>
        ) : (
          <AnalysisView
            view={activeView}
            flows={sourceScopedFlows}
            filteredFlows={filteredFlows}
            sourceFilter={sourceFilter}
            analytics={analytics}
            compareA={compareFlowA}
            compareB={compareFlowB}
            file={captureIndex.file}
            claudeSessionIndex={claudeSessionIndex}
            claudeSessionDetail={claudeSessionDetail}
          />
        )}
      </main>
      </div>
    </Tooltip.Provider>
  );
}

function LaunchScreen({ visible }) {
  if (!visible) return null;
  return (
    <div className="launch-screen">
      <img src={launchGraphic} alt="" />
      <div>
        <strong>LoopLens</strong>
        <span>Visual debugger for AI agent loops</span>
      </div>
    </div>
  );
}

function Sidebar(props) {
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={appLogo} alt="" />
        </div>
        <div className="brand-copy">
          <h1>LoopLens</h1>
          <p title={props.appInfo?.root}>{props.appInfo?.root || "Loading..."}</p>
        </div>
      </div>
      <ProxyPanel {...props} />
      <ToolLaunchers {...props} />
      <CaptureList {...props} />
    </aside>
  );
}

function ProxyPanel({
  proxyStatus,
  environment,
  native,
  listen,
  bodyLimit,
  captureAll,
  busy,
  onListenChange,
  onBodyLimitChange,
  onCaptureAllChange,
  onStartProxy,
  onStopProxy,
  onRunHelper,
}) {
  const diagnostics = diagnosticsForEnvironment(environment, native);
  const running = Boolean(proxyStatus?.running);
  const nativeDisabledTitle = native ? "" : "Open the Tauri app to use native proxy controls.";
  return (
    <section className="control">
      <div className="section-title">
        <span>Proxy</span>
        <div className="status-line" title={proxyStatus?.message || ""}>
          <span className={`dot ${running ? "running" : ""}`} />
          <span>{running ? proxyStatus?.external ? "External" : "Running" : "Stopped"}</span>
        </div>
      </div>

      <div className="field-grid">
        <label>
          Listen
          <input value={listen} onChange={(event) => onListenChange(event.target.value)} />
        </label>
        <label>
          Body limit
          <input value={bodyLimit} onChange={(event) => onBodyLimitChange(event.target.value)} />
        </label>
      </div>

      <div className="toolbar">
        <label className="check">
          <input
            type="checkbox"
            checked={captureAll}
            onChange={(event) => onCaptureAllChange(event.target.checked)}
          />
          <span>Capture all traffic</span>
        </label>
      </div>

      <div className="button-grid">
        <button className="primary" disabled={!native || busy === "proxy"} onClick={onStartProxy} title={nativeDisabledTitle}>
          Start
        </button>
        <button className="secondary" disabled={!native || busy === "proxy"} onClick={onStopProxy} title={nativeDisabledTitle}>
          Stop
        </button>
        <button className="secondary" disabled={!native || busy === "trust-ca"} onClick={() => onRunHelper("trust-ca")} title={nativeDisabledTitle}>
          Trust CA
        </button>
        <button className="secondary" disabled={!native || busy === "untrust-ca"} onClick={() => onRunHelper("untrust-ca")} title={nativeDisabledTitle}>
          Untrust
        </button>
      </div>

      <details className="diagnostics-details">
        <summary>
          Diagnostics
          <span>{diagnostics.length}</span>
        </summary>
        <div className="diagnostics">
          {diagnostics.map((item) => (
            <div className={item === "Environment ready." ? "diagnostic ok" : "diagnostic"} key={item}>
              {item}
            </div>
          ))}
        </div>
      </details>
    </section>
  );
}

function ToolLaunchers({ environment, native, busy, onOpenTool, onRefreshEnvironment }) {
  const tools = environment?.tools || [];
  return (
    <section className="launchers">
      <div className="section-head">
        <h2>Open In Native</h2>
        <button className="mini" onClick={onRefreshEnvironment}>Check</button>
      </div>
      <div className="launcher-list">
        {tools.map((tool) => (
          <button
            className={`launcher ${isToolReady(tool, native) ? "" : "warning"}`}
            disabled={!native || busy === tool.id}
            key={tool.id}
            onClick={() => onOpenTool(tool.id)}
            title={toolStatusLabel(tool, native)}
          >
            <span className={`launcher-mark ${tool.id}`}>{tool.id === "claude" ? "C" : "X"}</span>
            <span>
              <strong>{tool.label}</strong>
              <small>{toolStatusLabel(tool, native)}</small>
            </span>
            <span className="launcher-action">Open</span>
          </button>
        ))}
      </div>
    </section>
  );
}

function CaptureList({
  files,
  activeFile,
  sourceFilter,
  clientStats,
  onSelectFile,
  onRefreshFiles,
  onSourceFilterChange,
}) {
  return (
    <section className="files">
      <div className="section-head">
        <h2>Captures</h2>
        <button className="mini" onClick={onRefreshFiles}>Refresh</button>
      </div>
      <div className="source-switch" aria-label="Capture source">
        {clientStats.map((source) => (
          <button
            className={source.key === sourceFilter ? "active" : ""}
            key={source.key}
            onClick={() => onSourceFilterChange(source.key)}
            aria-pressed={source.key === sourceFilter}
          >
            <span>{source.label}</span>
            <strong>{source.count}</strong>
          </button>
        ))}
      </div>
      <ScrollArea.Root className="file-list scroll-root">
        <ScrollArea.Viewport className="scroll-viewport">
          {files.length === 0 ? (
            <div className="empty small">暂无 capture 文件。</div>
          ) : files.map((file) => (
            <button
              className={`file-item ${file.name === activeFile ? "active" : ""}`}
              key={file.name}
              onClick={() => onSelectFile(file.name)}
              aria-current={file.name === activeFile ? "true" : undefined}
              title={file.name}
            >
              <div className="file-head">
                <div className="file-name">{file.name}</div>
                <span className="file-pill">jsonl</span>
              </div>
              <div className="file-meta">
                <span>{formatBytes(file.size)}</span>
                <span>{formatTime(file.modified)}</span>
              </div>
            </button>
          ))}
        </ScrollArea.Viewport>
        <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
          <ScrollArea.Thumb className="scroll-thumb" />
        </ScrollArea.Scrollbar>
      </ScrollArea.Root>
    </section>
  );
}

function Toolbar({
  query,
  onQueryChange,
  live,
  onLiveChange,
  followLatest,
  onFollowLatestChange,
  file,
  shownCount,
  totalCount,
  proxyStatus,
  sourceFilter,
  activeView,
  onActiveViewChange,
  categories,
  categoryFilter,
  onCategoryFilterChange,
  statusFilter,
  onStatusFilterChange,
  hideNoise,
  onHideNoiseChange,
}) {
  function applyQuickFilter(filter) {
    onCategoryFilterChange(filter.category);
    onStatusFilterChange(filter.status);
  }

  return (
    <header className="topbar">
      <div className="workspace-title">
        <strong>AI Loop Workbench</strong>
        <span>{clientLabel(sourceFilter)} · {proxyStatus?.running ? "Live capture review" : "Capture paused"}</span>
      </div>
      <div className="search-wrap">
        <input
          className="search"
          value={query}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder="Search URL, host, provider, method, status"
          aria-label="Search flows"
        />
      </div>
      <div className="toolbar-actions">
        <Tabs.Root value={activeView} onValueChange={onActiveViewChange}>
          <Tabs.List className="view-nav" aria-label="Main views">
            {VIEWS.map((view) => (
              <TooltipLabel label={view} description={viewDescription(view)} key={view}>
                <Tabs.Trigger value={view} className="view-trigger">
                  {view}
                </Tabs.Trigger>
              </TooltipLabel>
            ))}
          </Tabs.List>
        </Tabs.Root>
        <div className="quick-filters" aria-label="Quick filters">
          {QUICK_FILTERS.map((filter) => {
            const unavailable = filter.category !== "All" && !categories.includes(filter.category);
            const active = categoryFilter === filter.category && statusFilter === filter.status;
            return (
              <button
                className={active ? "active" : ""}
                disabled={unavailable}
                key={filter.label}
                onClick={() => applyQuickFilter(filter)}
                aria-pressed={active}
              >
                {filter.label}
              </button>
            );
          })}
        </div>
        <SelectControl
          label="Category filter"
          value={categoryFilter}
          onValueChange={onCategoryFilterChange}
          items={categories}
        />
        <SelectControl
          label="Status filter"
          value={statusFilter}
          onValueChange={onStatusFilterChange}
          items={["All", "2xx", "Errors", "Pending"]}
        />
        <label className="toggle">
          <input type="checkbox" checked={live} onChange={(event) => onLiveChange(event.target.checked)} />
          <span>Live</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={followLatest} onChange={(event) => onFollowLatestChange(event.target.checked)} />
          <span>Follow latest</span>
        </label>
        <label className="toggle">
          <input type="checkbox" checked={hideNoise} onChange={(event) => onHideNoiseChange(event.target.checked)} />
          <span>Hide noise</span>
        </label>
        <span className="count">{shownCount}/{totalCount} flows</span>
        <span className="active-file" title={file?.name || ""}>{file?.name || "No file selected"}</span>
      </div>
    </header>
  );
}

function TooltipLabel({ label, description, children }) {
  return (
    <Tooltip.Root>
      <Tooltip.Trigger asChild>{children}</Tooltip.Trigger>
      <Tooltip.Portal>
        <Tooltip.Content className="tooltip-content" sideOffset={8}>
          <strong>{label}</strong>
          {description && <span>{description}</span>}
          <Tooltip.Arrow className="tooltip-arrow" />
        </Tooltip.Content>
      </Tooltip.Portal>
    </Tooltip.Root>
  );
}

function SelectControl({ label, value, onValueChange, items }) {
  return (
    <Select.Root value={value} onValueChange={onValueChange}>
      <Select.Trigger className="select-trigger" aria-label={label}>
        <Select.Value />
        <Select.Icon className="select-icon">⌄</Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            {items.map((item) => (
              <Select.Item className="select-item" value={item} key={item}>
                <Select.ItemText>{item}</Select.ItemText>
                <Select.ItemIndicator className="select-indicator">✓</Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function viewDescription(view) {
  const descriptions = {
    "AI Loop": "Agent loop rail with tool, MCP, skill, and token attribution.",
    Network: "Dense HTTP capture table and request inspector.",
    Timeline: "Chronological session and proxy events.",
    Tokens: "Token and cost attribution dashboard.",
    Raw: "Raw parser and correlation payloads.",
  };
  return descriptions[view] || "";
}

function FlowList({ flows, activeFlowId, compareA, compareB, onSelectFlow, onSetCompareA, onSetCompareB }) {
  const maxTransfer = Math.max(...flows.map(flowTransferSize), 1);
  const columns = useMemo(() => [
    {
      id: "method",
      header: "Method",
      cell: ({ row }) => <span className={methodClass(row.original.method)}>{row.original.method || "-"}</span>,
    },
    {
      id: "status",
      header: "Status",
      cell: ({ row }) => <span className={statusClass(row.original.status)}>{row.original.status || "-"}</span>,
    },
    {
      id: "source",
      header: "Source",
      cell: ({ row }) => <span className={`client-chip ${clientKey(row.original)}`}>{clientLabel(row.original)}</span>,
    },
    {
      id: "type",
      header: "Type",
      cell: ({ row }) => <span className="flow-provider">{row.original.semantic?.category || row.original.provider}</span>,
    },
    {
      id: "target",
      header: "Target",
      cell: ({ row }) => {
        const flow = row.original;
        return (
          <div className="flow-target">
            <strong title={flow.host}>{flow.host}</strong>
            <span title={flow.path || flow.url}>{flow.path || flow.url}</span>
            <div className="flow-meta dense">
              <span>#{flow.id}</span>
              <span>{flow.chunk_count} chunks</span>
              {flow.semantic?.rpc_method && <span>{flow.semantic.rpc_method}</span>}
              {flow.semantic?.mcp_server && <span>{flow.semantic.mcp_server}</span>}
              {flow.semantic?.tool_names?.length > 0 && <span>{flow.semantic.tool_names.length} tools</span>}
              {flow.semantic?.model && <span>{flow.semantic.model}</span>}
              {usageTotal(flow.semantic?.token_usage) > 0 && <span>{formatTokenShort(flow.semantic.token_usage)}</span>}
            </div>
          </div>
        );
      },
    },
    {
      id: "time",
      header: "Time",
      cell: ({ row }) => <span className="flow-time">{formatTime(row.original.updated_at)}</span>,
    },
    {
      id: "transfer",
      header: "Transfer",
      cell: ({ row }) => {
        const transfer = flowTransferSize(row.original);
        return (
          <div className="flow-transfer-cell">
            <span>{formatBytes(transfer)}</span>
            <div className="flow-waterfall" title={formatBytes(transfer)}>
              <span style={{ "--flow-width": `${Math.max(4, (transfer / maxTransfer) * 100)}%` }} />
            </div>
          </div>
        );
      },
    },
    {
      id: "compare",
      header: "Compare",
      cell: ({ row }) => {
        const flow = row.original;
        return (
          <div className="compare-actions dense">
            <button
              className={compareA === flow.id ? "active" : ""}
              onClick={(event) => {
                event.stopPropagation();
                onSetCompareA(flow.id);
              }}
              aria-pressed={compareA === flow.id}
              aria-label={`Set flow ${flow.id} as compare A`}
            >
              A
            </button>
            <button
              className={compareB === flow.id ? "active" : ""}
              onClick={(event) => {
                event.stopPropagation();
                onSetCompareB(flow.id);
              }}
              aria-pressed={compareB === flow.id}
              aria-label={`Set flow ${flow.id} as compare B`}
            >
              B
            </button>
          </div>
        );
      },
    },
  ], [compareA, compareB, maxTransfer, onSetCompareA, onSetCompareB]);
  const table = useReactTable({
    data: flows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  return (
    <section className="flow-list flow-table-shell">
      {flows.length === 0 ? (
        <div className="empty small">No matching flows.</div>
      ) : (
        <ScrollArea.Root className="flow-table-scroll scroll-root">
          <ScrollArea.Viewport className="scroll-viewport">
            <table className="flow-table">
              <thead>
                {table.getHeaderGroups().map((headerGroup) => (
                  <tr key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <th key={header.id}>
                        {header.isPlaceholder ? null : flexRender(header.column.columnDef.header, header.getContext())}
                      </th>
                    ))}
                  </tr>
                ))}
              </thead>
              <tbody>
                {table.getRowModel().rows.map((row) => {
                  const flow = row.original;
                  return (
                    <tr
                      className={flow.id === activeFlowId ? "active" : ""}
                      key={row.id}
                      onClick={() => onSelectFlow(flow.id)}
                      aria-current={flow.id === activeFlowId ? "true" : undefined}
                      tabIndex={0}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") onSelectFlow(flow.id);
                      }}
                    >
                      {row.getVisibleCells().map((cell) => (
                        <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </ScrollArea.Viewport>
          <ScrollArea.Scrollbar className="scrollbar" orientation="vertical">
            <ScrollArea.Thumb className="scroll-thumb" />
          </ScrollArea.Scrollbar>
          <ScrollArea.Scrollbar className="scrollbar horizontal" orientation="horizontal">
            <ScrollArea.Thumb className="scroll-thumb" />
          </ScrollArea.Scrollbar>
        </ScrollArea.Root>
      )}
    </section>
  );
}

function FlowDetail({
  detail,
  selectedFlow,
  activeTab,
  onTabChange,
  native,
  proxyStatus,
  hasFile,
  hasFlows,
  onStartProxy,
  onOpenTool,
  onSetCompareA,
  onSetCompareB,
}) {
  if (!detail) {
    return (
      <section className="detail">
        <EmptyState
          native={native}
          proxyStatus={proxyStatus}
          hasFile={hasFile}
          hasFlows={hasFlows}
          onStartProxy={onStartProxy}
          onOpenTool={onOpenTool}
        />
      </section>
    );
  }

  const summary = detail.summary || selectedFlow;
  return (
    <section className="detail">
      <div className="detail-sticky">
        <div className="detail-head">
          <div className="detail-title">
            <span className={methodClass(summary.method)}>{summary.method}</span>
            <strong>{summary.host}</strong>
            <span className={statusClass(summary.status)}>{summary.status || "pending"}</span>
            <span className="semantic-badge">{summary.semantic?.category || "HTTP"}</span>
          </div>
          <div className="detail-path" title={summary.url}>{summary.path || summary.url}</div>
          <div className="detail-stats">
            <span>{summary.provider}</span>
            <span>{clientLabel(summary)}</span>
            {summary.semantic?.client && <span>{summary.semantic.client}</span>}
            {summary.semantic?.mcp_server && <span>{summary.semantic.mcp_server}</span>}
            <span>{summary.chunk_count} chunks</span>
            <span>{formatBytes(summary.total_chunk_bytes || summary.request_size)}</span>
            <span>flow {summary.id}</span>
            {usageTotal(summary.semantic?.token_usage) > 0 && <span>{formatTokenUsage(summary.semantic.token_usage)}</span>}
          </div>
          <DetailActions detail={detail} onSetCompareA={onSetCompareA} onSetCompareB={onSetCompareB} />
        </div>

        <Tabs.Root value={activeTab} onValueChange={onTabChange}>
          <Tabs.List className="tabs" aria-label="Flow detail sections">
            {TABS.map((tab) => (
              <Tabs.Trigger value={tab} key={tab}>
                {tab}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
        </Tabs.Root>
      </div>

      <div className="tab-panel" id="flow-detail-panel" role="tabpanel">
        {activeTab === "Summary" && <SummaryTab detail={detail} />}
        {activeTab === "Parsed" && <ParsedTab semantic={summary.semantic} />}
        {activeTab === "Prompt" && <CodeBlock value={promptText(detail.request) || "No request body."} />}
        {activeTab === "Response" && <CodeBlock value={detail.reconstructed_response || "No response chunks."} />}
        {activeTab === "Raw" && <RawTab detail={detail} />}
        {activeTab === "Chunks" && <ChunksTab chunks={detail.chunks} />}
      </div>
    </section>
  );
}

function EmptyState({ native, proxyStatus, hasFile, hasFlows, onStartProxy, onOpenTool }) {
  let title = "No traffic captured yet";
  let message = "Start capture, then open Claude Code or Codex from the left sidebar.";
  if (!native) {
    title = "Preview mode";
    message = "Open the Tauri app to start the proxy and launch native tools.";
  } else if (proxyStatus?.running && !hasFlows) {
    title = "Waiting for traffic";
    message = "Capture is running. Send Claude Code or Codex through the proxy to see flows here.";
  } else if (hasFile && !hasFlows) {
    title = "No flows in this capture";
    message = "Choose another capture file or start a fresh session.";
  }

  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="empty-actions">
        <button className="primary" disabled={!native} onClick={onStartProxy}>Start Capture</button>
        <button disabled={!native} onClick={() => onOpenTool("codex")}>Open Codex</button>
        <button disabled={!native} onClick={() => onOpenTool("claude")}>Open Claude Code</button>
      </div>
      {!native && <p className="disabled-reason">Native actions are available after opening the Tauri app.</p>}
    </div>
  );
}

function SummaryTab({ detail }) {
  const { summary, request, response_start: responseStart } = detail;
  return (
    <div className="summary-grid">
      <Info label="URL" value={summary.url} />
      <Info label="Status" value={`${summary.status || "pending"} ${summary.reason || ""}`} />
      <Info label="Started" value={formatTime(summary.started_at)} />
      <Info label="Updated" value={formatTime(summary.updated_at)} />
      <Info label="Request size" value={formatBytes(summary.request_size)} />
      <Info label="Response chunks" value={`${summary.chunk_count} · ${formatBytes(summary.total_chunk_bytes)}`} />
      <Info label="Tokens" value={formatTokenUsage(summary.semantic?.token_usage)} />
      <Info label="Semantic category" value={summary.semantic?.category} />
      <Info label="Client" value={summary.semantic?.client} />
      <Info label="MCP server" value={summary.semantic?.mcp_server} />
      <Info label="RPC method" value={summary.semantic?.rpc_method} />
      <Info label="Request headers" value={Object.keys(request?.headers || {}).join(", ") || "None"} />
      <Info label="Response headers" value={Object.keys(responseStart?.headers || {}).join(", ") || "None"} />
      <Info label="Redactions" value={summary.semantic?.redaction_hits} />
    </div>
  );
}

function ParsedTab({ semantic }) {
  if (!semantic) return <CodeBlock value="No parsed semantic metadata." />;
  return (
    <div className="parsed-grid">
      <Info label="Category" value={semantic.category} />
      <Info label="Client" value={semantic.client} />
      <Info label="MCP server" value={semantic.mcp_server} />
      <Info label="RPC method" value={semantic.rpc_method} />
      <Info label="Model" value={semantic.model} />
      <Info label="Tokens" value={formatTokenUsage(semantic.token_usage)} />
      <Info label="Event type" value={semantic.event_type} />
      <Info label="Redaction hits" value={semantic.redaction_hits} />
      <ListInfo label="Tools" items={semantic.tool_names} />
      <ListInfo label="Skills" items={semantic.skill_names} />
    </div>
  );
}

function SessionStrip({ analytics }) {
  return (
    <section className="session-strip">
      <Metric label="Flows" value={analytics.totalFlows} />
      <Metric label="Errors" value={analytics.errors} tone={analytics.errors ? "bad" : ""} />
      <Metric label="MCP servers" value={analytics.mcpServers.length} />
      <Metric label="Tools" value={analytics.tools.length} />
      <Metric label="Models" value={analytics.models.length} />
      <Metric label="Tokens" value={formatTokenMetric(analytics.tokens.total)} />
      <Metric label="Redactions" value={analytics.redactions} />
    </section>
  );
}

function Metric({ label, value, tone = "" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailActions({ detail, onSetCompareA, onSetCompareB }) {
  async function copyCurl() {
    await navigator.clipboard.writeText(generateCurl(detail.request));
  }

  function exportJson() {
    downloadText(`flow-${detail.summary.id}.json`, JSON.stringify(detail, null, 2), "application/json");
  }

  return (
    <div className="detail-actions">
      <button onClick={copyCurl}>Copy cURL</button>
      <button onClick={exportJson}>Export JSON</button>
      <button onClick={onSetCompareA}>Set A</button>
      <button onClick={onSetCompareB}>Set B</button>
      <button disabled title="Replay can send data to external services; not enabled in this build.">Replay</button>
    </div>
  );
}

function AnalysisView({
  view,
  flows,
  filteredFlows,
  analytics,
  compareA,
  compareB,
  file,
  claudeSessionIndex,
  claudeSessionDetail,
  sourceFilter,
}) {
  if (view === "AI Loop") {
    return (
      <LoopWorkbench
        flows={flows}
        filteredFlows={filteredFlows}
        analytics={analytics}
        claudeSessionIndex={claudeSessionIndex}
        claudeSessionDetail={claudeSessionDetail}
        sourceFilter={sourceFilter}
      />
    );
  }
  if (view === "Timeline") return <TimelineWorkbench flows={flows} claudeSessionDetail={claudeSessionDetail} sourceFilter={sourceFilter} />;
  if (view === "Tokens") return <TokensWorkbench analytics={analytics} claudeSessionDetail={claudeSessionDetail} />;
  if (view === "Raw") return <RawWorkbench file={file} flows={flows} claudeSessionDetail={claudeSessionDetail} />;
  if (view === "Overview") return <OverviewPanel analytics={analytics} file={file} />;
  if (view === "MCP") return <McpPanel analytics={analytics} />;
  if (view === "Compare") return <ComparePanel a={compareA} b={compareB} />;
  if (view === "Audit") return <AuditPanel flows={flows} analytics={analytics} />;
  return null;
}

function LoopWorkbench({ flows, analytics, claudeSessionIndex, claudeSessionDetail, sourceFilter }) {
  const loopModel = useMemo(
    () => buildAgentLoopModel({ flows, claudeSessionDetail, sourceFilter }),
    [flows, claudeSessionDetail, sourceFilter],
  );
  const [activeStepId, setActiveStepId] = useState(null);
  const [activeLoopTab, setActiveLoopTab] = useState("Summary");

  useEffect(() => {
    if (!loopModel.steps.length) {
      setActiveStepId(null);
      return;
    }
    setActiveStepId((current) => loopModel.steps.some((step) => step.id === current)
      ? current
      : preferredLoopStep(loopModel)?.id || loopModel.steps[0].id);
  }, [loopModel.id]);

  const activeStep = loopModel.steps.find((step) => step.id === activeStepId) || preferredLoopStep(loopModel) || null;
  const exportPayload = {
    loop: loopModel,
    claude_session: claudeSessionDetail,
    proxy_flows: flows,
  };

  return (
    <section className="loop-workbench">
      <div className="loop-workbench-head">
        <div>
          <h2>AI Loop</h2>
          <p>Agent turns, model steps, tools, MCP, skills, token pressure, and correlated network evidence.</p>
        </div>
        <div className="loop-actions">
          <span title={claudeSessionIndex?.storage_dir || ""}>{claudeSessionDetail?.session?.file_name || "No session"}</span>
          <button onClick={() => downloadText("looplens-ai-loop.json", JSON.stringify(exportPayload, null, 2), "application/json")}>
            Export Loop
          </button>
        </div>
      </div>

      <div className="loop-kpis">
        <Metric label="Turns" value={loopModel.totals.turns} />
        <Metric label="Steps" value={loopModel.totals.steps} />
        <Metric label="Tools" value={loopModel.totals.tools} />
        <Metric label="MCP" value={loopModel.totals.mcp} />
        <Metric label="Skills" value={loopModel.totals.skills} />
        <Metric label="Tokens" value={formatTokenMetric(loopUsageTotal(loopModel.totals.tokens) || usageTotal(claudeSessionDetail?.session?.token_usage) || analytics.tokens.total)} />
        <Metric label="Unmatched" value={loopModel.totals.unmatched} tone={loopModel.totals.unmatched ? "bad" : ""} />
      </div>

      <div className="loop-diagnostics" role="status">
        {loopModel.diagnostics.map((diagnostic) => <span key={diagnostic}>{diagnostic}</span>)}
      </div>

      <div className="loop-workspace">
        <LoopRail model={loopModel} activeStepId={activeStep?.id} onSelectStep={setActiveStepId} />
        <LoopInspector
          step={activeStep}
          activeTab={activeLoopTab}
          onTabChange={setActiveLoopTab}
        />
      </div>
    </section>
  );
}

function preferredLoopStep(model) {
  return model.steps.find((step) => step.type === "Model Step")
    || model.steps.find((step) => ["Tool Batch", "Tool", "MCP", "Skill"].includes(step.type))
    || model.steps[0]
    || null;
}

function LoopRail({ model, activeStepId, onSelectStep }) {
  if (!model.turns.length || model.steps.length === 0) {
    return (
      <section className="loop-rail-panel">
        <div className="empty-state compact">
          <h2>No loop activity yet</h2>
          <p>Open Claude Code or Codex from the sidebar, then send a prompt to create loop steps.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="loop-rail-panel" aria-label="AI loop rail">
      {model.turns.map((turn) => (
        <article className={`loop-turn ${stepStatusClass(turn.status)}`} key={turn.id}>
          <div className="loop-turn-head">
            <span>Turn {turn.index}</span>
            <strong title={turn.title}>{turn.title}</strong>
            <em>{formatLoopTokens(turn.tokens)}</em>
          </div>
          <div className="loop-step-list">
            {turn.steps.map((step) => (
              <button
                className={`loop-step ${stepTypeClass(step.type)} ${stepStatusClass(step.status)} ${step.id === activeStepId ? "active" : ""}`}
                key={step.id}
                onClick={() => onSelectStep(step.id)}
                aria-current={step.id === activeStepId ? "true" : undefined}
              >
                <span className="loop-step-node" />
                <span className="loop-step-kind">{step.type}</span>
                <strong title={step.title}>{step.title}</strong>
                <em>{step.status}</em>
                <small title={step.subtitle}>{step.subtitle || step.whyNext}</small>
              </button>
            ))}
          </div>
        </article>
      ))}
    </section>
  );
}

function LoopInspector({ step, activeTab, onTabChange }) {
  if (!step) {
    return (
      <section className="loop-inspector">
        <div className="empty-state compact">
          <h2>Select a loop step</h2>
          <p>The inspector will show inputs, outputs, network evidence, token usage, and raw records.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="loop-inspector">
      <div className="loop-inspector-head">
        <div>
          <span className={`loop-type-pill ${stepTypeClass(step.type)}`}>{step.type}</span>
          <h2 title={step.title}>{step.title}</h2>
          <p title={step.subtitle}>{step.subtitle || "No summary text."}</p>
        </div>
        <span className={`loop-state-pill ${stepStatusClass(step.status)}`}>{step.status}</span>
      </div>

      <div className="why-next">
        <span>Why Next?</span>
        <strong>{step.whyNext || "No transition explanation available."}</strong>
      </div>

      <Tabs.Root value={activeTab} onValueChange={onTabChange}>
        <Tabs.List className="tabs loop-tabs" aria-label="Loop step detail sections">
          {LOOP_DETAIL_TABS.map((tab) => (
            <Tabs.Trigger value={tab} key={tab}>
              {tab}
            </Tabs.Trigger>
          ))}
        </Tabs.List>
      </Tabs.Root>

      <div className="loop-tab-panel" role="tabpanel">
        {activeTab === "Summary" && <LoopSummaryTab step={step} />}
        {activeTab === "Input" && <CodeBlock value={step.input || "No input payload."} />}
        {activeTab === "Output" && <CodeBlock value={step.output || "No output payload."} />}
        {activeTab === "Network" && <LoopNetworkTab step={step} />}
        {activeTab === "Tokens" && <LoopTokensTab step={step} />}
        {activeTab === "Raw" && <CodeBlock value={JSON.stringify(step.raw || step, null, 2)} />}
      </div>
    </section>
  );
}

function LoopSummaryTab({ step }) {
  return (
    <div className="summary-grid">
      <Info label="Step ID" value={step.id} />
      <Info label="Type" value={step.type} />
      <Info label="Status" value={step.status} />
      <Info label="Timestamp" value={formatTime(step.timestamp)} />
      <Info label="Turn" value={step.turnIndex ? `Turn ${step.turnIndex}` : "-"} />
      <Info label="Parent" value={step.parentId} />
      <Info label="Correlation" value={step.confidence} />
      <Info label="Tokens" value={formatLoopTokens(step.tokens)} />
      <ListInfo label="Related steps" items={step.relatedIds || []} />
      <ListInfo label="Network flows" items={(step.networkFlows || []).map((flow) => `#${flow.id} ${flow.host || ""}`)} />
      <Info label="Model" value={step.meta?.model} />
      <Info label="Stop reason" value={step.meta?.stopReason} />
      <Info label="Tool name" value={step.meta?.toolName} />
      <Info label="MCP category" value={step.meta?.mcpCategory} />
    </div>
  );
}

function LoopNetworkTab({ step }) {
  const flows = step.networkFlows || [];
  if (!flows.length) return <CodeBlock value="No correlated network flows for this step." />;
  return (
    <div className="loop-network-list">
      {flows.map((flow) => (
        <article className="loop-network-card" key={flow.id}>
          <div>
            <strong>{flow.method || "-"} {flow.status || "pending"} · {flow.host}</strong>
            <span title={flow.url}>{flow.path || flow.url}</span>
          </div>
          <div>
            <span>{flow.semantic?.category || flow.provider}</span>
            <span>{flow.chunk_count || 0} chunks</span>
            <span>{formatBytes(flow.total_chunk_bytes || flow.request_size)}</span>
            {usageTotal(flow.semantic?.token_usage) > 0 && <span>{formatTokenUsage(flow.semantic.token_usage)}</span>}
          </div>
        </article>
      ))}
    </div>
  );
}

function LoopTokensTab({ step }) {
  const tokens = step.tokens || {};
  const rows = [
    ["Input", tokens.inputTokens],
    ["Output", tokens.outputTokens],
    ["Cache read", tokens.cacheReadInputTokens],
    ["Cache write", tokens.cacheCreationInputTokens],
    ["Reasoning", tokens.reasoningOutputTokens],
    ["Web search", tokens.webSearchRequests],
    ["Cost USD", tokens.costUSD ? `$${tokens.costUSD.toFixed(4)}` : null],
    ["Total", loopUsageTotal(tokens)],
  ];
  return (
    <div className="list-card">
      <h3>Token Attribution</h3>
      {rows.map(([name, value]) => (
        <div className="list-row" key={name}>
          <span>{name}</span>
          <strong>{value ? (typeof value === "number" ? formatCompactNumber(value) : value) : "unknown"}</strong>
        </div>
      ))}
    </div>
  );
}

function TimelineWorkbench({ flows, claudeSessionDetail, sourceFilter }) {
  const timeline = buildUnifiedTimeline(flows, claudeSessionDetail, { sourceFilter });
  return (
    <section className="analysis-panel">
      <div className="analysis-head">
        <div>
          <h2>Unified Timeline</h2>
          <p>Session messages and proxy flows merged by timestamp.</p>
        </div>
      </div>
      <UnifiedTimeline timeline={timeline} sourceFilter={sourceFilter} />
    </section>
  );
}

function TokensWorkbench({ analytics, claudeSessionDetail }) {
  const loopModel = buildAgentLoopModel({ flows: [], claudeSessionDetail, sourceFilter: "all" });
  const sessionTokens = claudeSessionDetail?.session?.token_usage;
  return (
    <section className="analysis-panel">
      <div className="analysis-head">
        <div>
          <h2>Tokens</h2>
          <p>Token usage from proxy flows plus Claude session totals when available.</p>
        </div>
      </div>
      <TokenDashboard analytics={analytics} />
      <div className="analysis-grid">
        <TokenCard tokens={analytics.tokens} />
        <div className="list-card">
          <h3>Claude Session Usage</h3>
          <Info label="Total" value={formatTokenUsage(sessionTokens)} />
          <Info label="Loop model total" value={formatLoopTokens(loopModel.totals.tokens)} />
        </div>
        <TokenBucketCard title="Token Usage by Model" items={analytics.tokenByModel} />
        <TokenBucketCard title="Token Usage by Category" items={analytics.tokenByCategory} />
        <TopTokenFlows flows={analytics.topTokenFlows} />
      </div>
    </section>
  );
}

function RawWorkbench({ file, flows, claudeSessionDetail }) {
  const raw = {
    capture_file: file,
    flow_summaries: flows,
    claude_session: claudeSessionDetail,
  };
  return (
    <section className="analysis-panel">
      <div className="analysis-head">
        <div>
          <h2>Raw</h2>
          <p>Raw loop inputs for debugging parser and correlation behavior.</p>
        </div>
        <button onClick={() => downloadText("looplens-raw.json", JSON.stringify(raw, null, 2), "application/json")}>Export Raw</button>
      </div>
      <CodeBlock value={JSON.stringify(raw, null, 2)} />
    </section>
  );
}

function LoopPanel({ flows, analytics, claudeSessionIndex, claudeSessionDetail, sourceFilter }) {
  const loopModel = buildLoopModel(flows);
  const unifiedTimeline = buildUnifiedTimeline(flows, claudeSessionDetail, { sourceFilter });
  const exportPayload = {
    inferred_loop: loopModel,
    claude_session: claudeSessionDetail,
    unified_timeline: unifiedTimeline,
  };
  return (
    <section className="analysis-panel loop-panel">
      <div className="analysis-head">
        <div>
          <h2>Claude Code Loop</h2>
          <p>Context build, model stream, tool dispatch, result feedback, and follow-up turns.</p>
        </div>
        <button onClick={() => downloadText("loop-model.json", JSON.stringify(exportPayload, null, 2), "application/json")}>
          Export Loop
        </button>
      </div>

      <div className="loop-stage-map">
        {loopModel.stages.map((stage, index) => (
          <div className="loop-stage" key={stage.key}>
            <span>{index + 1}</span>
            <strong>{stage.label}</strong>
            <p>{stage.description}</p>
          </div>
        ))}
      </div>

      <div className="loop-summary-grid">
        <Metric label="Iterations" value={loopModel.loops.length} />
        <Metric label="Model calls" value={loopModel.totals.model} />
        <Metric label="Tool flows" value={loopModel.totals.tools} />
        <Metric label="Skill flows" value={loopModel.totals.skills} />
        <Metric label="MCP flows" value={loopModel.totals.mcp} />
        <Metric
          label="Tokens"
          value={formatTokenMetric(usageTotal(claudeSessionDetail?.session?.token_usage) || loopModel.totals.tokens || analytics.tokens.total)}
        />
      </div>

      <LoopTokenHeatmap loops={loopModel.loops} session={claudeSessionDetail?.session} />

      <UnifiedTimeline timeline={unifiedTimeline} sourceFilter={sourceFilter} />

      <ClaudeSessionTrace index={claudeSessionIndex} detail={claudeSessionDetail} />

      <div className="loop-board">
        <div className="loop-column">
          <h3>Iterations</h3>
          {loopModel.loops.length ? loopModel.loops.map((loop) => (
            <LoopCard loop={loop} key={loop.index} />
          )) : <div className="empty small">No Claude Code loop activity detected.</div>}
        </div>
        <div className="loop-column">
          <h3>Tool Lanes</h3>
          <LaneCard title="Skills" items={analytics.categories.find((item) => item.name === "Skill") ? loopModel.loops.flatMap((loop) => loop.skillNames) : []} empty="No skill invocations." />
          <LaneCard title="Tools" items={analytics.tools.map((tool) => tool.name)} empty="No tool calls." />
          <LaneCard title="MCP Servers" items={analytics.mcpServers.map((server) => server.name)} empty="No MCP servers." />
          <div className="loop-note">
            <strong>Execution model</strong>
            <p>Claude Code batches concurrency-safe tools, runs unsafe tools exclusively, and feeds every tool_result back into the next model iteration.</p>
          </div>
        </div>
      </div>
    </section>
  );
}

function UnifiedTimeline({ timeline, sourceFilter }) {
  const events = timeline.events.slice(-180);
  return (
    <section className="unified-timeline">
      <div className="unified-head">
        <div>
          <h3>Unified Timeline</h3>
          <p>
            {sourceFilter === "codex"
              ? "Proxy flows only for Codex source."
              : "Claude session messages and proxy flows merged by timestamp."}
          </p>
        </div>
        <div className="unified-lanes">
          {timeline.lanes.map((lane) => (
            <span key={lane.name}>{lane.name} {lane.count}</span>
          ))}
        </div>
      </div>
      {events.length ? (
        <div className="unified-scroll">
          {events.map((event) => (
            <TimelineEvent event={event} key={event.id} />
          ))}
        </div>
      ) : (
        <div className="empty small">No timestamped session or proxy events yet.</div>
      )}
    </section>
  );
}

function TimelineEvent({ event }) {
  return (
    <article className={`timeline-event ${event.tone}`}>
      <div className="timeline-time">{formatTime(event.time)}</div>
      <div className={`timeline-lane lane-${event.lane.toLowerCase()}`}>{event.lane}</div>
      <div className="timeline-body">
        <div className="timeline-title">
          <strong>{event.title}</strong>
          <span>{event.source}</span>
        </div>
        {event.subtitle && <p>{event.subtitle}</p>}
        {event.meta?.length > 0 && (
          <div className="timeline-tags">
            {event.meta.slice(0, 6).map((item, index) => <span key={`${item}-${index}`}>{item}</span>)}
          </div>
        )}
      </div>
    </article>
  );
}

function LoopTokenHeatmap({ loops, session }) {
  const tokenLoops = loops.filter((loop) => loop.tokens.total > 0);
  const max = Math.max(...tokenLoops.map((loop) => loop.tokens.total), 1);
  return (
    <section className="loop-token-panel">
      <div className="loop-token-head">
        <div>
          <h3>Token Consumption by Loop</h3>
          <p>Model usage from proxy flows, with Claude session total shown when available.</p>
        </div>
        <strong>{formatTokenUsage(session?.token_usage)}</strong>
      </div>
      {tokenLoops.length ? (
        <div className="loop-token-rows">
          {tokenLoops.map((loop) => (
            <div className="loop-token-row" key={loop.index}>
              <span>#{loop.index}</span>
              <div className="token-mini-track">
                <div style={{ "--token-width": `${Math.max(3, (loop.tokens.total / max) * 100)}%` }} />
              </div>
              <strong>{formatLargeNumber(loop.tokens.total)}</strong>
              <em>{formatTokenParts(loop.tokens)}</em>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty small">No per-loop token usage found yet.</div>
      )}
    </section>
  );
}

function ClaudeSessionTrace({ index, detail }) {
  const session = detail?.session;
  const messages = detail?.messages || [];
  const importantMessages = messages
    .filter((message) => message.tool_uses?.length || message.tool_results?.length || message.thinking_count || message.text_preview)
    .slice(-80);

  return (
    <section className="session-trace">
      <div className="session-trace-head">
        <div>
          <h3>Claude Session Sidecar</h3>
          <p title={index?.storage_dir || ""}>{index?.storage_dir || "No Claude session directory detected."}</p>
        </div>
        <div className="session-trace-stats">
          <span>{index?.sessions?.length || 0} sessions</span>
          <span>{session?.message_count || 0} messages</span>
          <span>{session?.tool_uses || 0} tool uses</span>
          <span>{session?.thinking_blocks || 0} thinking</span>
          <span>{formatTokenUsage(session?.token_usage)}</span>
        </div>
      </div>
      {session ? (
        <>
          <div className="session-meta-row">
            <span title={session.file_name}>{session.file_name}</span>
            {session.slug && <span>{session.slug}</span>}
            {session.models?.map((model) => <span key={model}>{model}</span>)}
            <span>{formatBytes(session.size)}</span>
            <span>{formatTime(session.modified)}</span>
          </div>
          <div className="message-timeline">
            {importantMessages.length ? importantMessages.map((message, index) => (
              <SessionMessageCard message={message} index={index} key={message.uuid || `${message.timestamp}-${index}`} />
            )) : <div className="empty small">No rich session messages found in the latest Claude session.</div>}
          </div>
        </>
      ) : (
        <div className="empty small">Open Claude Code from this app, then send a prompt to create a local session sidecar.</div>
      )}
    </section>
  );
}

function SessionMessageCard({ message, index }) {
  const hasTools = message.tool_uses?.length > 0 || message.tool_results?.length > 0;
  return (
    <article className={`session-message ${message.role} ${hasTools ? "has-tools" : ""}`}>
      <div className="session-message-dot">{index + 1}</div>
      <div className="session-message-body">
        <div className="session-message-head">
          <strong>{message.role}</strong>
          {message.model && <span>{message.model}</span>}
          {message.thinking_count > 0 && <span>{message.thinking_count} thinking</span>}
          {message.token_usage?.total_tokens && <span>{message.token_usage.total_tokens} tokens</span>}
          <em>{formatTime(message.timestamp)}</em>
        </div>
        {message.text_preview && <p>{message.text_preview}</p>}
        {message.tool_uses?.length > 0 && (
          <div className="session-block-list">
            {message.tool_uses.map((tool) => (
              <div className="session-block tool-use" key={tool.id || tool.name}>
                <span>tool_use</span>
                <strong>{tool.name}</strong>
                <code>{tool.input_preview || "{}"}</code>
              </div>
            ))}
          </div>
        )}
        {message.tool_results?.length > 0 && (
          <div className="session-block-list">
            {message.tool_results.map((result) => (
              <div className={`session-block tool-result ${result.is_error ? "error" : ""}`} key={result.tool_use_id || result.content_preview}>
                <span>{result.is_error ? "tool_error" : "tool_result"}</span>
                <strong>{result.tool_use_id || "-"}</strong>
                <code>{result.content_preview || "-"}</code>
              </div>
            ))}
          </div>
        )}
      </div>
    </article>
  );
}

function LoopCard({ loop }) {
  const segments = [
    ["Model", loop.modelFlows.length, "model"],
    ["MCP", loop.mcpFlows.length, "mcp"],
    ["Tool", loop.toolFlows.length, "tool"],
    ["Skill", loop.skillFlows.length, "skill"],
    ["Other", loop.otherFlows.length, "other"],
  ].filter(([, count]) => count > 0);
  const max = Math.max(...segments.map(([, count]) => count), 1);

  return (
    <article className={`loop-card ${loop.hasFollowUp ? "continued" : ""}`}>
      <div className="loop-card-head">
        <span>#{loop.index}</span>
        <strong>{primaryLoopTitle(loop)}</strong>
        <em>{formatTime(loop.startedAt)} - {formatTime(loop.updatedAt)}</em>
      </div>
      <div className="loop-rail" aria-label="Loop composition">
        {segments.map(([label, count, tone]) => (
          <div className={`loop-segment ${tone}`} style={{ "--weight": `${Math.max(12, (count / max) * 100)}%` }} key={label}>
            <span>{label}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <div className="loop-card-meta">
        {loop.models.slice(0, 2).map((model) => <span key={model}>{model}</span>)}
        {loop.mcpServers.slice(0, 3).map((server) => <span key={server}>{server}</span>)}
        {loop.toolNames.slice(0, 3).map((tool) => <span key={tool}>{tool}</span>)}
        {loop.skillNames.slice(0, 2).map((skill) => <span key={skill}>skill:{skill}</span>)}
        {loop.tokens.total > 0 && <span>{loop.tokens.total} tokens</span>}
        {loop.isParallelLike && <span>parallel-like</span>}
      </div>
    </article>
  );
}

function LaneCard({ title, items, empty }) {
  const counts = new Map();
  for (const item of items) counts.set(item, (counts.get(item) || 0) + 1);
  const rows = [...counts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count)
    .slice(0, 10);

  return (
    <div className="lane-card">
      <h4>{title}</h4>
      {rows.length ? rows.map((row) => (
        <div className="lane-row" key={row.name}>
          <span>{row.name}</span>
          <strong>{row.count}</strong>
        </div>
      )) : <p>{empty}</p>}
    </div>
  );
}

function OverviewPanel({ analytics, file }) {
  return (
    <section className="analysis-panel">
      <div className="analysis-head">
        <h2>Session Overview</h2>
        <button onClick={() => downloadText("session-summary.json", JSON.stringify({ file, analytics }, null, 2), "application/json")}>Export Session</button>
      </div>
      <SessionStrip analytics={analytics} />
      <TokenDashboard analytics={analytics} />
      <div className="analysis-grid">
        <ListCard title="Categories" items={analytics.categories} />
        <ListCard title="Models" items={analytics.models} />
        <TokenCard tokens={analytics.tokens} />
        <TokenBucketCard title="Token Usage by Model" items={analytics.tokenByModel} />
        <TokenBucketCard title="Token Usage by Category" items={analytics.tokenByCategory} />
        <TopTokenFlows flows={analytics.topTokenFlows} />
      </div>
    </section>
  );
}

function McpPanel({ analytics }) {
  return (
    <section className="analysis-panel">
      <div className="analysis-head"><h2>MCP Servers</h2></div>
      <div className="server-grid">
        {analytics.mcpServers.length ? analytics.mcpServers.map((server) => (
          <div className="server-card" key={server.name}>
            <h3>{server.name}</h3>
            <p>{server.count} flows · {server.tools.length} tools</p>
            <div className="chip-list">
              {server.tools.map((tool) => <strong key={tool}>{tool}</strong>)}
            </div>
          </div>
        )) : <div className="empty small">No MCP servers detected.</div>}
      </div>
    </section>
  );
}

function TimelinePanel({ flows }) {
  const events = flows
    .filter((flow) => ["Tool call", "Tool list", "MCP", "Model"].includes(flow.semantic?.category))
    .map((flow) => ({
      id: flow.id,
      time: flow.updated_at || flow.started_at,
      title: flow.semantic?.tool_names?.[0] || flow.semantic?.rpc_method || flow.semantic?.category,
      meta: [flow.semantic?.mcp_server, flow.semantic?.model, flow.host].filter(Boolean).join(" · "),
      category: flow.semantic?.category,
    }));
  return (
    <section className="analysis-panel">
      <div className="analysis-head"><h2>Tool Call Timeline</h2></div>
      <div className="timeline">
        {events.length ? events.map((event) => (
          <div className="timeline-row" key={event.id}>
            <span>{formatTime(event.time)}</span>
            <strong>{event.title}</strong>
            <em>{event.category}</em>
            <p>{event.meta}</p>
          </div>
        )) : <div className="empty small">No tool or MCP events detected.</div>}
      </div>
    </section>
  );
}

function ComparePanel({ a, b }) {
  return (
    <section className="analysis-panel">
      <div className="analysis-head"><h2>Compare Flows</h2></div>
      {!a || !b ? (
        <div className="empty small">Use A/B buttons in the flow list or detail panel to select two flows.</div>
      ) : (
        <div className="compare-grid">
          <CompareColumn title="A" flow={a} />
          <CompareColumn title="B" flow={b} />
          <DiffCard a={a} b={b} />
        </div>
      )}
    </section>
  );
}

function AuditPanel({ flows, analytics }) {
  const redacted = flows.filter((flow) => flow.semantic?.redaction_hits > 0);
  const risky = flows.filter((flow) => flow.semantic?.redaction_hits === 0 && JSON.stringify(flow).match(/token|authorization|cookie|secret|password/i));
  return (
    <section className="analysis-panel">
      <div className="analysis-head"><h2>Sensitive Data Audit</h2></div>
      <div className="analysis-grid">
        <Metric label="Redaction hits" value={analytics.redactions} />
        <Metric label="Flows with redactions" value={redacted.length} />
        <Metric label="Possible misses" value={risky.length} tone={risky.length ? "bad" : ""} />
      </div>
      <ListCard title="Redacted flows" items={redacted.map((flow) => ({ name: `#${flow.id} ${flow.host}`, count: flow.semantic.redaction_hits }))} />
    </section>
  );
}

function ListCard({ title, items }) {
  return (
    <div className="list-card">
      <h3>{title}</h3>
      {items.length ? items.map((item) => (
        <div className="list-row" key={item.name}>
          <span>{item.name}</span>
          <strong>{item.count}</strong>
        </div>
      )) : <p>No data.</p>}
    </div>
  );
}

function TokenDashboard({ analytics }) {
  const tokens = analytics.tokens || {};
  const total = Number(tokens.total || 0);
  const segments = [
    ["Input", tokens.input, "input"],
    ["Output", tokens.output, "output"],
    ["Cached", tokens.cached, "cached"],
    ["Reasoning", tokens.reasoning, "reasoning"],
  ].filter(([, value]) => Number(value || 0) > 0);

  return (
    <section className="token-dashboard">
      <div className="token-total">
        <span>Token Consumption</span>
        <strong>{formatTokenMetric(total)}</strong>
        <p>{analytics.tokenFlows || 0} flows reported usage</p>
      </div>
      <div className="token-bars">
        {segments.length ? segments.map(([label, value, tone]) => (
          <div className="token-bar-row" key={label}>
            <span>{label}</span>
            <div className="token-bar-track">
              <div
                className={`token-bar-fill ${tone}`}
                style={{ "--token-width": `${Math.max(2, (Number(value) / total) * 100)}%` }}
              />
            </div>
            <strong>{formatLargeNumber(value)}</strong>
          </div>
        )) : <div className="empty small">No token usage found in this capture.</div>}
      </div>
    </section>
  );
}

function TokenCard({ tokens }) {
  const rows = [
    ["Input", tokens.input],
    ["Output", tokens.output],
    ["Cached input", tokens.cached],
    ["Reasoning", tokens.reasoning],
    ["Total", tokens.total],
  ];
  return (
    <div className="list-card">
      <h3>Token Usage</h3>
      {rows.map(([name, value]) => (
        <div className="list-row" key={name}>
          <span>{name}</span>
          <strong>{value ? formatLargeNumber(value) : "-"}</strong>
        </div>
      ))}
    </div>
  );
}

function TokenBucketCard({ title, items = [] }) {
  const max = Math.max(...items.map((item) => item.total), 1);
  return (
    <div className="list-card token-bucket-card">
      <h3>{title}</h3>
      {items.length ? items.slice(0, 8).map((item) => (
        <div className="token-bucket-row" key={item.name}>
          <div>
            <span>{item.name}</span>
            <em>{item.count} flows</em>
          </div>
          <div className="token-mini-track">
            <div style={{ "--token-width": `${Math.max(3, (item.total / max) * 100)}%` }} />
          </div>
          <strong>{formatLargeNumber(item.total)}</strong>
        </div>
      )) : <p>No token usage.</p>}
    </div>
  );
}

function TopTokenFlows({ flows = [] }) {
  return (
    <div className="list-card token-flow-card">
      <h3>Top Token Flows</h3>
      {flows.length ? flows.map((flow) => (
        <div className="token-flow-row" key={flow.id}>
          <div>
            <span>{flow.name}</span>
            <em title={flow.path}>{flow.category} · {flow.model}</em>
          </div>
          <strong>{formatLargeNumber(flow.total)}</strong>
        </div>
      )) : <p>No token usage.</p>}
    </div>
  );
}

function CompareColumn({ title, flow }) {
  return (
    <div className="list-card">
      <h3>{title}: flow {flow.id}</h3>
      <Info label="Category" value={flow.semantic?.category} />
      <Info label="URL" value={flow.url} />
      <Info label="MCP" value={flow.semantic?.mcp_server} />
      <Info label="Model" value={flow.semantic?.model} />
      <Info label="Tokens" value={formatTokenUsage(flow.semantic?.token_usage)} />
      <Info label="Tools" value={(flow.semantic?.tool_names || []).join(", ")} />
    </div>
  );
}

function DiffCard({ a, b }) {
  const rows = [
    ["Category", a.semantic?.category, b.semantic?.category],
    ["Host", a.host, b.host],
    ["Path", a.path, b.path],
    ["Status", a.status, b.status],
    ["Model", a.semantic?.model, b.semantic?.model],
    ["RPC", a.semantic?.rpc_method, b.semantic?.rpc_method],
    ["Tokens", a.semantic?.token_usage?.total_tokens, b.semantic?.token_usage?.total_tokens],
  ];
  return (
    <div className="list-card diff-card">
      <h3>Diff</h3>
      {rows.map(([name, left, right]) => (
        <div className={`diff-row ${left === right ? "" : "changed"}`} key={name}>
          <span>{name}</span>
          <strong>{String(left || "-")}</strong>
          <strong>{String(right || "-")}</strong>
        </div>
      ))}
    </div>
  );
}

function formatTokenUsage(usage = {}) {
  const total = usageTotal(usage);
  if (!total && !usage.input_tokens && !usage.output_tokens) return "-";
  return [
    total ? `${formatLargeNumber(total)} total` : null,
    usage.input_tokens ? `${formatLargeNumber(usage.input_tokens)} in` : null,
    usage.output_tokens ? `${formatLargeNumber(usage.output_tokens)} out` : null,
    usage.cached_input_tokens ? `${formatLargeNumber(usage.cached_input_tokens)} cached` : null,
    usage.reasoning_output_tokens ? `${formatLargeNumber(usage.reasoning_output_tokens)} reasoning` : null,
  ].filter(Boolean).join(" · ");
}

function formatTokenParts(usage = {}) {
  return [
    usage.input ? `${formatLargeNumber(usage.input)} in` : null,
    usage.output ? `${formatLargeNumber(usage.output)} out` : null,
    usage.cached ? `${formatLargeNumber(usage.cached)} cached` : null,
    usage.reasoning ? `${formatLargeNumber(usage.reasoning)} reasoning` : null,
  ].filter(Boolean).join(" · ") || "-";
}

function formatLargeNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1000)}K`;
  return number.toLocaleString();
}

function formatTokenMetric(value) {
  return Number(value || 0) > 0 ? formatLargeNumber(value) : "-";
}

function flowTransferSize(flow) {
  return Number(flow?.total_chunk_bytes || flow?.request_size || 0);
}

function downloadText(filename, text, type) {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

function ListInfo({ label, items = [] }) {
  return (
    <div className="info list-info">
      <span>{label}</span>
      {items.length ? (
        <div className="chip-list">
          {items.map((item) => <strong key={item}>{item}</strong>)}
        </div>
      ) : (
        <strong>-</strong>
      )}
    </div>
  );
}

function Info({ label, value }) {
  return (
    <div className="info">
      <span>{label}</span>
      <strong title={String(value || "")}>{value || "-"}</strong>
    </div>
  );
}

function RawTab({ detail }) {
  return (
    <div className="raw-grid">
      <div className="panel"><h2>Request</h2><CodeBlock value={JSON.stringify(detail.request || null, null, 2)} /></div>
      <div className="panel"><h2>Response Start</h2><CodeBlock value={JSON.stringify(detail.response_start || null, null, 2)} /></div>
    </div>
  );
}

function ChunksTab({ chunks }) {
  if (!chunks?.length) return <CodeBlock value="No chunks." />;
  return (
    <div className="chunks">
      {chunks.map((chunk, index) => (
        <div className="chunk" key={`${chunk.body?.chunk_index ?? index}`}>
          <div className="chunk-head">
            <span>chunk {chunk.body?.chunk_index ?? index}</span>
            <span>{formatBytes(chunk.body?.size_bytes)}</span>
          </div>
          <CodeBlock value={bodyText(chunk.body)} />
        </div>
      ))}
    </div>
  );
}

function CodeBlock({ value }) {
  return <pre>{value}</pre>;
}
