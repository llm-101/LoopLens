type AnyRecord = Record<string, any>;

export function formatBytes(value) {
  const bytes = Number(value || 0);
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

export function formatTime(secondsOrIso) {
  if (!secondsOrIso) return "";
  const date = typeof secondsOrIso === "number"
    ? new Date(secondsOrIso * 1000)
    : new Date(secondsOrIso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toLocaleTimeString();
}

export function methodClass(method) {
  return `method method-${String(method || "unknown").toLowerCase()}`;
}

export function statusClass(status) {
  const code = Number(status);
  if (code >= 500) return "status status-error";
  if (code >= 400) return "status status-warn";
  if (code >= 300) return "status status-redirect";
  if (code >= 200) return "status status-ok";
  return "status";
}

export function bodyText(body) {
  if (!body) return "";
  if (body.json !== undefined) return JSON.stringify(body.json, null, 2);
  if (body.text !== undefined) return body.text;
  if (body.binary !== undefined) return body.binary;
  if (body.stream !== undefined) return body.stream;
  return JSON.stringify(body, null, 2);
}

export function promptText(request) {
  if (!request) return "";
  return bodyText(request.body);
}

export function flowSearchText(flow) {
  return [
    flow.id,
    flow.method,
    flow.url,
    flow.host,
    flow.path,
    flow.provider,
    flow.status,
    flow.reason,
    flow.semantic?.category,
    flow.semantic?.client,
    flow.semantic?.model,
    flow.semantic?.mcp_server,
    flow.semantic?.rpc_method,
    ...(flow.semantic?.tool_names || []),
    ...(flow.semantic?.skill_names || []),
  ].filter(Boolean).join(" ").toLowerCase();
}

const STRUCTURED_SEARCH_RE = /^(model|status|category|host|provider|method|mcp|tool|tokens):\s*(.+)$/i;
const TOKEN_COMPARE_RE = /^([><=!]+)?\s*(\d+)$/;

export function structuredFlowSearch(flow, query: string): boolean {
  const trimmed = query.trim();
  if (!trimmed) return true;

  const match = STRUCTURED_SEARCH_RE.exec(trimmed);
  if (!match) {
    return flowSearchText(flow).includes(trimmed.toLowerCase());
  }

  const field = match[1].toLowerCase();
  const value = match[2].trim().toLowerCase();
  const semantic = flow.semantic || {};

  switch (field) {
    case "model":
      return String(semantic.model || "").toLowerCase().includes(value);
    case "status": {
      if (value === "error" || value === "errors") return Number(flow.status) >= 400;
      if (value === "ok" || value === "success") return Number(flow.status) >= 200 && Number(flow.status) < 300;
      if (value === "pending") return !flow.status;
      return String(flow.status || "").includes(value);
    }
    case "category":
      return String(semantic.category || "").toLowerCase().includes(value);
    case "host":
      return String(flow.host || "").toLowerCase().includes(value);
    case "provider":
      return String(flow.provider || "").toLowerCase().includes(value);
    case "method":
      return String(flow.method || "").toLowerCase() === value;
    case "mcp":
      return String(semantic.mcp_server || "").toLowerCase().includes(value);
    case "tool":
      return (semantic.tool_names || []).some((name) => String(name).toLowerCase().includes(value));
    case "tokens": {
      const tokenMatch = TOKEN_COMPARE_RE.exec(value);
      if (!tokenMatch) return false;
      const op = tokenMatch[1] || ">";
      const threshold = Number(tokenMatch[2]);
      const total = usageTotal(semantic.token_usage);
      if (op === ">") return total > threshold;
      if (op === ">=") return total >= threshold;
      if (op === "<") return total < threshold;
      if (op === "<=") return total <= threshold;
      if (op === "=" || op === "==") return total === threshold;
      if (op === "!=") return total !== threshold;
      return total > threshold;
    }
    default:
      return flowSearchText(flow).includes(trimmed.toLowerCase());
  }
}

export function clientKey(flow) {
  const client = String(flow?.semantic?.client || "").toLowerCase();
  const provider = String(flow?.provider || "").toLowerCase();
  const host = String(flow?.host || "").toLowerCase();
  const path = String(flow?.path || "").toLowerCase();

  if (client.includes("claude") || provider.includes("claude") || host.includes("anthropic")) {
    return "claude";
  }
  if (
    client.includes("codex")
    || path.includes("/codex")
    || path.includes("/wham/apps")
    || host.includes("chatgpt.com")
  ) {
    return "codex";
  }
  return "other";
}

export function clientLabel(keyOrFlow) {
  const key = typeof keyOrFlow === "string" ? keyOrFlow : clientKey(keyOrFlow);
  if (key === "all") return "All sources";
  if (key === "claude") return "Claude Code";
  if (key === "codex") return "Codex";
  return "Other";
}

export function computeClientStats(flows) {
  const stats = {
    all: { key: "all", label: "All", count: 0 },
    codex: { key: "codex", label: "Codex", count: 0 },
    claude: { key: "claude", label: "Claude Code", count: 0 },
    other: { key: "other", label: "Other", count: 0 },
  };

  for (const flow of flows || []) {
    const key = clientKey(flow);
    stats.all.count += 1;
    stats[key].count += 1;
  }

  return [stats.all, stats.codex, stats.claude, stats.other];
}

export function sourceMatches(flow, sourceFilter) {
  return sourceFilter === "all" || clientKey(flow) === sourceFilter;
}

export function buildLoopModel(flows) {
  const sorted = [...(flows || [])].sort((a, b) => flowMs(a) - flowMs(b));
  const loops = [];
  let current = createLoop(1);

  for (const flow of sorted) {
    const category = flow.semantic?.category || "HTTP";
    const startsModelStep = category === "Model" && hasLoopContent(current);
    if (startsModelStep) {
      loops.push(finalizeLoop(current));
      current = createLoop(loops.length + 1);
    }

    current.flows.push(flow);
    current.startedAt ||= flow.started_at || flow.updated_at;
    current.updatedAt = flow.updated_at || flow.started_at || current.updatedAt;

    if (category === "Model") current.modelFlows.push(flow);
    else if (category === "Tool call" || category === "Tool list") current.toolFlows.push(flow);
    else if (category === "Skill") current.skillFlows.push(flow);
    else if (category === "MCP") current.mcpFlows.push(flow);
    else current.otherFlows.push(flow);
  }

  if (hasLoopContent(current)) loops.push(finalizeLoop(current));
  return {
    loops,
    stages: [
      { key: "context", label: "Context", description: "messages, memory, compact, skills" },
      { key: "model", label: "Model stream", description: "assistant text, thinking, tool_use" },
      { key: "tools", label: "Tool dispatch", description: "permission, hooks, serial/parallel" },
      { key: "results", label: "Tool results", description: "tool_result appended to loop" },
      { key: "followup", label: "Follow-up", description: "continue until no tool_use" },
    ],
    totals: summarizeLoopTotals(loops),
  };
}

export function buildUnifiedTimeline(flows, claudeSessionDetail, options: AnyRecord = {}) {
  const includeClaudeSession = options.sourceFilter !== "codex";
  const events = [];

  for (const flow of flows || []) {
    const category = flow.semantic?.category || "HTTP";
    const lane = flowLane(category);
    const time = flow.started_at || flow.updated_at;
    events.push({
      id: `flow:${flow.id}`,
      time,
      ms: toMs(time),
      lane,
      source: "proxy",
      title: flowTitle(flow),
      subtitle: [flow.host, flow.path].filter(Boolean).join(" "),
      meta: [
        flow.method,
        flow.status || "pending",
        category,
        flow.semantic?.mcp_server,
        flow.semantic?.rpc_method,
        flow.semantic?.model,
        formatTokenShort(flow.semantic?.token_usage),
      ].filter(Boolean),
      tone: Number(flow.status) >= 400 ? "error" : categoryTone(category),
      raw: flow,
    });
  }

  if (includeClaudeSession) {
    for (const [messageIndex, message] of (claudeSessionDetail?.messages || []).entries()) {
      const time = message.timestamp;
      const base = {
        time,
        ms: toMs(time),
        source: "claude-session",
        messageIndex,
      };

      if (message.text_preview || message.role) {
        events.push({
          ...base,
          id: `msg:${message.uuid || messageIndex}`,
          lane: message.role === "assistant" ? "Model" : "Conversation",
          title: message.role === "assistant" ? "Assistant message" : message.role === "user" ? "User message" : message.role,
          subtitle: message.text_preview,
          meta: [
            message.model,
            message.thinking_count ? `${message.thinking_count} thinking` : null,
            message.token_usage?.total_tokens ? `${message.token_usage.total_tokens} tokens` : null,
          ].filter(Boolean),
          tone: message.role === "assistant" ? "model" : "conversation",
          raw: message,
        });
      }

      if (message.thinking_count > 0) {
        events.push({
          ...base,
          id: `thinking:${message.uuid || messageIndex}`,
          lane: "Model",
          title: "Thinking block",
          subtitle: `${message.thinking_count} protected reasoning block${message.thinking_count > 1 ? "s" : ""}`,
          meta: [message.model].filter(Boolean),
          tone: "thinking",
          raw: message,
        });
      }

      for (const [toolIndex, tool] of (message.tool_uses || []).entries()) {
        const isSkill = tool.name === "Skill" || tool.name === "SkillTool" || tool.input_preview?.includes("\"skill\"");
        events.push({
          ...base,
          id: `tool-use:${tool.id || `${messageIndex}-${toolIndex}`}`,
          lane: isSkill ? "Skill" : "Tool",
          title: isSkill ? skillTitle(tool) : tool.name,
          subtitle: tool.input_preview,
          meta: ["tool_use", tool.id].filter(Boolean),
          tone: isSkill ? "skill" : "tool",
          raw: tool,
        });
      }

      for (const [resultIndex, result] of (message.tool_results || []).entries()) {
        events.push({
          ...base,
          id: `tool-result:${result.tool_use_id || `${messageIndex}-${resultIndex}`}`,
          lane: "Result",
          title: result.is_error ? "Tool error" : "Tool result",
          subtitle: result.content_preview,
          meta: [result.tool_use_id].filter(Boolean),
          tone: result.is_error ? "error" : "result",
          raw: result,
        });
      }
    }
  }

  const sorted = events
    .filter((event) => event.ms > 0 || event.time)
    .sort((a, b) => a.ms - b.ms || laneOrder(a.lane) - laneOrder(b.lane));
  return {
    events: sorted,
    lanes: summarizeTimelineLanes(sorted),
    range: {
      start: sorted[0]?.time || null,
      end: sorted.at(-1)?.time || null,
    },
  };
}

export function primaryLoopTitle(loop) {
  const skill = loop.skillNames[0];
  if (skill) return `Skill: ${skill}`;
  const tool = loop.toolNames[0];
  if (tool) return `Tool: ${tool}`;
  const model = loop.models[0];
  if (model) return `Model: ${model}`;
  const server = loop.mcpServers[0];
  if (server) return `MCP: ${server}`;
  return `Iteration ${loop.index}`;
}

function createLoop(index) {
  return {
    index,
    startedAt: null,
    updatedAt: null,
    flows: [],
    modelFlows: [],
    toolFlows: [],
    skillFlows: [],
    mcpFlows: [],
    otherFlows: [],
    toolNames: [],
    skillNames: [],
    mcpServers: [],
    models: [],
    tokens: { input: 0, output: 0, cached: 0, reasoning: 0, total: 0 },
  };
}

function hasLoopContent(loop) {
  return loop.flows.length > 0;
}

function finalizeLoop(loop) {
  for (const flow of loop.flows) {
    for (const name of flow.semantic?.tool_names || []) pushUnique(loop.toolNames, name);
    for (const name of flow.semantic?.skill_names || []) pushUnique(loop.skillNames, name);
    if (flow.semantic?.mcp_server) pushUnique(loop.mcpServers, flow.semantic.mcp_server);
    if (flow.semantic?.model) pushUnique(loop.models, flow.semantic.model);

    const usage = flow.semantic?.token_usage || {};
    loop.tokens.input += Number(usage.input_tokens || 0);
    loop.tokens.output += Number(usage.output_tokens || 0);
    loop.tokens.cached += Number(usage.cached_input_tokens || 0);
    loop.tokens.reasoning += Number(usage.reasoning_output_tokens || 0);
    loop.tokens.total += Number(usage.total_tokens || 0);
  }
  loop.hasFollowUp = loop.toolFlows.length > 0 || loop.skillFlows.length > 0 || loop.mcpFlows.length > 0;
  loop.isParallelLike = loop.toolFlows.length + loop.mcpFlows.length > 1;
  return loop;
}

function summarizeLoopTotals(loops) {
  return loops.reduce((totals, loop) => {
    totals.flows += loop.flows.length;
    totals.model += loop.modelFlows.length;
    totals.tools += loop.toolFlows.length;
    totals.skills += loop.skillFlows.length;
    totals.mcp += loop.mcpFlows.length;
    totals.tokens += loop.tokens.total;
    return totals;
  }, { flows: 0, model: 0, tools: 0, skills: 0, mcp: 0, tokens: 0 });
}

function flowMs(flow) {
  const time = new Date(flow.started_at || flow.updated_at || 0).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function flowLane(category) {
  if (category === "Model") return "Model";
  if (category === "MCP" || category === "Tool list" || category === "Tool call") return "MCP";
  if (category === "Skill") return "Skill";
  return "Network";
}

function isModelApiPath(path: string | undefined): boolean {
  if (!path) return false;
  const p = path.split("?")[0];
  return [
    "/v1/messages",
    "/v1/chat/completions",
    "/v1/responses",
    "/api/anthropic/v1/messages",
  ].some((endpoint) => p.endsWith(endpoint));
}

function flowTitle(flow) {
  const category = flow.semantic?.category || "HTTP";
  // For Model API calls, prioritize model name over tool list
  if (isModelApiPath(flow.path) && flow.semantic?.model) {
    return flow.semantic.model;
  }
  if (flow.semantic?.skill_names?.length) return `Skill: ${flow.semantic.skill_names.join(", ")}`;
  if (flow.semantic?.tool_names?.length) return flow.semantic.tool_names.join(", ");
  if (flow.semantic?.rpc_method) return flow.semantic.rpc_method;
  if (flow.semantic?.model) return flow.semantic.model;
  return `${flow.method || "-"} ${flow.status || "pending"} ${category}`;
}

function skillTitle(tool) {
  const match = String(tool.input_preview || "").match(/"skill"\s*:\s*"([^"]+)"/);
  return match ? `Skill: ${match[1]}` : "Skill";
}

function categoryTone(category) {
  if (category === "Model") return "model";
  if (category === "Skill") return "skill";
  if (category === "MCP" || category === "Tool call" || category === "Tool list") return "mcp";
  if (category === "Telemetry") return "muted";
  return "network";
}

function toMs(value) {
  if (!value) return 0;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function laneOrder(lane) {
  return ["Conversation", "Model", "Skill", "Tool", "MCP", "Network", "Result"].indexOf(lane);
}

function summarizeTimelineLanes(events) {
  const lanes = new Map();
  for (const event of events) {
    lanes.set(event.lane, (lanes.get(event.lane) || 0) + 1);
  }
  return [...lanes.entries()].map(([name, count]) => ({ name, count }));
}

function pushUnique(items, value) {
  if (value && !items.includes(value)) items.push(value);
}

export function diagnosticsForEnvironment(environment, native) {
  if (!native) return ["Preview mode: native controls are disabled."];
  if (!environment) return ["Checking environment..."];
  const issues = [];
  if (!environment.proxy_binary_exists) issues.push("Proxy binary missing.");
  if (!environment.ca_cert_exists || !environment.ca_key_exists) issues.push("CA files missing.");
  for (const tool of environment.tools || []) {
    if (!tool.wrapper_exists) issues.push(`${tool.label} wrapper missing.`);
    if (!tool.command_path) issues.push(`${tool.command} not found in PATH.`);
  }
  return issues.length ? issues : ["Environment ready."];
}

export function toolStatusLabel(tool, native) {
  if (!native) return "Available inside the Tauri app";
  if (!tool.wrapper_exists) return "Wrapper missing";
  if (!tool.command_path) return `${tool.command} not found in PATH`;
  return `Ready · ${tool.command_path}`;
}

export function isToolReady(tool, native) {
  return native && Boolean(tool?.wrapper_exists && tool?.command_path);
}

export function tokenTotal(flow) {
  return usageTotal(flow?.semantic?.token_usage);
}

export function computeAnalytics(flows) {
  const categories = new Map();
  const mcpServers = new Map();
  const tools = new Map();
  const models = new Map();
  const tokenByModel = new Map();
  const tokenByCategory = new Map();
  const topTokenFlows = [];
  let errors = 0;
  let redactions = 0;
  let tokenFlows = 0;
  const tokens = {
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    total: 0,
  };

  for (const flow of flows || []) {
    const semantic = flow.semantic || {};
    const category = semantic.category || "HTTP";
    categories.set(category, (categories.get(category) || 0) + 1);
    if (Number(flow.status) >= 400) errors += 1;
    redactions += Number(semantic.redaction_hits || 0);

    if (semantic.mcp_server) {
      const current = mcpServers.get(semantic.mcp_server) || { name: semantic.mcp_server, count: 0, tools: new Set() };
      current.count += 1;
      for (const name of semantic.tool_names || []) current.tools.add(name);
      mcpServers.set(semantic.mcp_server, current);
    }

    for (const name of semantic.tool_names || []) {
      tools.set(name, (tools.get(name) || 0) + 1);
    }
    if (semantic.model) {
      models.set(semantic.model, (models.get(semantic.model) || 0) + 1);
    }

    const usage = semantic.token_usage || {};
    tokens.input += Number(usage.input_tokens || 0);
    tokens.output += Number(usage.output_tokens || 0);
    tokens.cached += Number(usage.cached_input_tokens || 0);
    tokens.reasoning += Number(usage.reasoning_output_tokens || 0);
    tokens.total += usageTotal(usage);

    const total = usageTotal(usage);
    if (total > 0) {
      tokenFlows += 1;
      addTokenBucket(tokenByModel, semantic.model || providerLabel(flow), total, usage);
      addTokenBucket(tokenByCategory, category, total, usage);
      topTokenFlows.push({
        id: flow.id,
        name: `#${flow.id} ${flow.host}`,
        path: flow.path || flow.url,
        model: semantic.model || providerLabel(flow),
        category,
        total,
        input: Number(usage.input_tokens || 0),
        output: Number(usage.output_tokens || 0),
        cached: Number(usage.cached_input_tokens || 0),
        reasoning: Number(usage.reasoning_output_tokens || 0),
      });
    }
  }

  return {
    totalFlows: flows?.length || 0,
    errors,
    redactions,
    tokenFlows,
    categories: [...categories.entries()].map(([name, count]) => ({ name, count })),
    mcpServers: [...mcpServers.values()].map((server) => ({
      ...server,
      tools: [...server.tools],
    })),
    tools: [...tools.entries()].map(([name, count]) => ({ name, count })),
    models: [...models.entries()].map(([name, count]) => ({ name, count })),
    tokens,
    tokenByModel: tokenBuckets(tokenByModel),
    tokenByCategory: tokenBuckets(tokenByCategory),
    topTokenFlows: topTokenFlows.sort((a, b) => b.total - a.total).slice(0, 12),
  };
}

export function usageTotal(usage: AnyRecord = {}) {
  const explicit = Number(usage.total_tokens || 0);
  if (explicit > 0) return explicit;
  return Number(usage.input_tokens || 0)
    + Number(usage.output_tokens || 0)
    + Number(usage.cached_input_tokens || 0)
    + Number(usage.reasoning_output_tokens || 0);
}

export function formatTokenShort(usage: AnyRecord = {}) {
  const total = usageTotal(usage);
  return total > 0 ? `${total} tok` : "";
}

function addTokenBucket(map, name, total, usage: AnyRecord = {}) {
  const current = map.get(name) || {
    name,
    total: 0,
    input: 0,
    output: 0,
    cached: 0,
    reasoning: 0,
    count: 0,
  };
  current.total += total;
  current.input += Number(usage.input_tokens || 0);
  current.output += Number(usage.output_tokens || 0);
  current.cached += Number(usage.cached_input_tokens || 0);
  current.reasoning += Number(usage.reasoning_output_tokens || 0);
  current.count += 1;
  map.set(name, current);
}

function tokenBuckets(map) {
  return [...map.values()].sort((a, b) => b.total - a.total);
}

function providerLabel(flow) {
  return flow?.provider && flow.provider !== "Unknown" ? flow.provider : "Unknown model";
}

export function isNoiseFlow(flow) {
  const category = flow?.semantic?.category;
  const method = flow?.method;
  const path = flow?.path || flow?.url || "";
  return Boolean(flow?.semantic?.low_signal)
    || method === "CONNECT"
    || category === "Telemetry"
    || path.includes("/hooks/claude-code")
    || path.includes("/hooks/codex")
    || path.includes("analytics-events")
    || path.includes("/otlp/")
    || path.includes("/metrics");
}

export function generateCurl(request) {
  if (!request?.url) return "";
  const method = request.method || "GET";
  const headers = request.headers || {};
  const parts = ["curl", "-X", shellQuote(method), shellQuote(request.url)];
  for (const [key, value] of Object.entries(headers)) {
    if (!value || key.toLowerCase() === "content-length") continue;
    parts.push("-H", shellQuote(`${key}: ${value}`));
  }
  const body = bodyText(request.body);
  if (body) {
    parts.push("--data-raw", shellQuote(body));
  }
  return parts.join(" \\\n  ");
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}
