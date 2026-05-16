const LOOP_STEP_ORDER = [
  "User Prompt",
  "Model Step",
  "Tool Batch",
  "Tool",
  "MCP",
  "Skill",
  "Tool Result",
  "Permission",
  "Compact",
  "Rate Limit",
  "Network Flow",
  "Final Result",
];

const MCP_SEARCH_TOOLS = new Set([
  "search",
  "search_code",
  "search_repositories",
  "search_issues",
  "search_pull_requests",
  "search_files",
  "search_nodes",
  "brave_web_search",
  "brave_local_search",
  "web_search_exa",
  "tavily_search",
  "perplexity_search",
  "gmail_search_messages",
  "google_drive_search",
]);

const MCP_READ_PREFIXES = [
  "get_",
  "list_",
  "read_",
  "fetch_",
  "lookup_",
  "find_",
  "pull_request_read",
  "issue_read",
];

export function buildAgentLoopModel({ flows = [], claudeSessionDetail = null, sourceFilter = "all" } = {}) {
  const messages = normalizeMessages(claudeSessionDetail?.messages || []);
  const flowSteps = normalizeFlowSteps(flows);
  const turns = [];
  const allSteps = [];
  const toolUseMap = new Map();
  let currentTurn = null;
  let turnIndex = 0;

  function ensureTurn(message) {
    if (!currentTurn) {
      turnIndex += 1;
      currentTurn = createTurn(turnIndex, message?.timestamp);
      turns.push(currentTurn);
    }
    return currentTurn;
  }

  for (const message of messages) {
    const isToolResultOnly = message.toolResults.length > 0 && !message.text && message.role === "user";
    const startsUserTurn = message.role === "user" && !isToolResultOnly;
    if (startsUserTurn || !currentTurn) {
      turnIndex += startsUserTurn || !currentTurn ? 1 : 0;
      currentTurn = createTurn(turnIndex, message.timestamp);
      turns.push(currentTurn);
    }

    const turn = ensureTurn(message);
    if (message.role === "user" && !isToolResultOnly) {
      addStep(turn, allSteps, userPromptStep(message, turn.index));
    } else if (message.role === "assistant") {
      const modelStep = modelStepFromMessage(message, turn.index);
      addStep(turn, allSteps, modelStep);
      if (message.toolUses.length > 0) {
        const batchStep = toolBatchStep(message, turn.index, modelStep.id);
        addStep(turn, allSteps, batchStep);
        for (const tool of message.toolUses) {
          const step = toolUseStep(tool, message, turn.index, batchStep.id);
          toolUseMap.set(tool.id, step);
          addStep(turn, allSteps, step);
        }
      }
      if (message.stopReason === "end_turn" && message.toolUses.length === 0) {
        addStep(turn, allSteps, finalResultStep(message, turn.index, modelStep.id));
      }
    } else if (message.toolResults.length > 0) {
      for (const result of message.toolResults) {
        const matchedTool = toolUseMap.get(result.tool_use_id);
        const step = toolResultStep(result, message, turn.index, matchedTool?.id);
        if (matchedTool) {
          matchedTool.status = result.is_error ? "error" : "success";
          matchedTool.relatedIds.push(step.id);
          step.relatedIds.push(matchedTool.id);
        }
        addStep(turn, allSteps, step);
      }
    } else if (message.kind === "compact_boundary" || message.subtype === "compact_boundary") {
      addStep(turn, allSteps, compactStep(message, turn.index));
    } else if (message.kind === "rate_limit_event" || message.typeName === "rate_limit_event") {
      addStep(turn, allSteps, rateLimitStep(message, turn.index));
    } else if (message.kind === "tool_progress" || message.typeName === "tool_progress") {
      addStep(turn, allSteps, progressStep(message, turn.index));
    } else if (message.kind === "tool_use_summary" || message.typeName === "tool_use_summary") {
      addStep(turn, allSteps, summaryStep(message, turn.index));
    }
  }

  if (turns.length === 0 && flowSteps.length > 0) {
    currentTurn = createTurn(1, flowSteps[0]?.timestamp);
    turns.push(currentTurn);
  }

  correlateNetworkFlows(turns, allSteps, flowSteps);
  for (const step of flowSteps) {
    const turn = nearestTurn(turns, step.timestamp) || currentTurn;
    addStep(turn, allSteps, step);
  }

  for (const turn of turns) {
    turn.steps.sort(stepSort);
    turn.startedAt = turn.steps[0]?.timestamp || turn.startedAt;
    turn.updatedAt = turn.steps.at(-1)?.timestamp || turn.updatedAt;
    turn.tokens = sumUsage(turn.steps.map((step) => step.tokens));
    turn.status = turn.steps.some((step) => step.status === "error")
      ? "error"
      : turn.steps.some((step) => step.status === "unmatched")
        ? "unmatched"
        : "success";
    turn.title = turn.steps.find((step) => step.type === "User Prompt")?.title || `Turn ${turn.index}`;
  }

  const sortedSteps = allSteps.sort(stepSort);
  return {
    id: [
      claudeSessionDetail?.session?.session_id || claudeSessionDetail?.session?.file_name || "no-session",
      sourceFilter,
      flows.length,
      messages.length,
    ].join(":"),
    turns,
    steps: sortedSteps,
    totals: {
      turns: turns.length,
      steps: sortedSteps.length,
      tools: sortedSteps.filter((step) => ["Tool", "MCP", "Skill"].includes(step.type)).length,
      mcp: sortedSteps.filter((step) => step.type === "MCP").length,
      skills: sortedSteps.filter((step) => step.type === "Skill").length,
      network: flowSteps.length,
      errors: sortedSteps.filter((step) => step.status === "error").length,
      unmatched: sortedSteps.filter((step) => step.status === "unmatched").length,
      tokens: sumUsage(sortedSteps.map((step) => step.tokens)),
    },
    diagnostics: diagnosticsForLoop(messages, flows, sortedSteps),
  };
}

export function stepTypeClass(type = "") {
  return `loop-type-${type.toLowerCase().replaceAll(" ", "-")}`;
}

export function stepStatusClass(status = "") {
  return `loop-status-${status.toLowerCase()}`;
}

export function formatLoopTokens(usage = {}) {
  const total = usageTotal(usage);
  if (!total && !usage.inputTokens && !usage.outputTokens) return "unknown";
  return [
    total ? `${formatCompactNumber(total)} total` : null,
    usage.inputTokens ? `${formatCompactNumber(usage.inputTokens)} in` : null,
    usage.outputTokens ? `${formatCompactNumber(usage.outputTokens)} out` : null,
    usage.cacheReadInputTokens ? `${formatCompactNumber(usage.cacheReadInputTokens)} cache read` : null,
    usage.cacheCreationInputTokens ? `${formatCompactNumber(usage.cacheCreationInputTokens)} cache write` : null,
  ].filter(Boolean).join(" · ");
}

export function usageTotal(usage = {}) {
  return Number(usage.totalTokens || 0)
    || Number(usage.total_tokens || 0)
    || Number(usage.inputTokens || 0)
      + Number(usage.outputTokens || 0)
      + Number(usage.cacheReadInputTokens || 0)
      + Number(usage.cacheCreationInputTokens || 0)
      + Number(usage.cachedInputTokens || 0)
      + Number(usage.reasoningOutputTokens || 0);
}

export function formatCompactNumber(value) {
  const number = Number(value || 0);
  if (number >= 1_000_000) return `${(number / 1_000_000).toFixed(1)}M`;
  if (number >= 10_000) return `${Math.round(number / 1000)}K`;
  return number.toLocaleString();
}

function normalizeMessages(messages) {
  return messages.map((message, index) => {
    const raw = message.raw || {};
    const typeName = message.type_name || message.type || raw.type;
    const subtype = message.subtype || raw.subtype;
    const role = message.role || raw.message?.role || raw.type || "event";
    const content = raw.message?.content;
    const rawToolUses = contentBlocks(content).filter((block) => block.type === "tool_use");
    const rawToolResults = contentBlocks(content).filter((block) => block.type === "tool_result");
    return {
      ...message,
      index,
      id: message.uuid || raw.uuid || `${message.timestamp || "message"}-${index}`,
      role,
      typeName,
      subtype,
      kind: subtype || typeName,
      timestamp: message.timestamp || raw.timestamp,
      model: message.model || raw.message?.model,
      stopReason: message.stop_reason || raw.message?.stop_reason || raw.stop_reason,
      text: message.text_preview || textFromContent(content),
      toolUses: rawToolUses.length ? rawToolUses.map(normalizeToolUse) : (message.tool_uses || []).map((tool) => ({
        id: tool.id,
        name: tool.name,
        input: tool.input,
        inputPreview: tool.input_preview,
      })),
      toolResults: rawToolResults.length ? rawToolResults.map(normalizeToolResult) : (message.tool_results || []).map((result) => ({
        tool_use_id: result.tool_use_id,
        is_error: result.is_error,
        content: result.content,
        contentPreview: result.content_preview,
      })),
      tokens: normalizeUsage(message.token_usage || raw.message?.usage || raw.usage),
      raw,
    };
  }).sort((a, b) => timeMs(a.timestamp) - timeMs(b.timestamp) || a.index - b.index);
}

function normalizeFlowSteps(flows) {
  return (flows || []).map((flow) => {
    const semantic = flow.semantic || {};
    const tokens = normalizeUsage(semantic.token_usage);
    const category = semantic.category || "HTTP";
    const type = "Network Flow";
    const status = Number(flow.status) >= 400 ? "error" : flow.status ? "success" : "running";
    return {
      id: `flow:${flow.id}`,
      type,
      status,
      title: flowTitle(flow),
      subtitle: [flow.method, flow.status || "pending", flow.host].filter(Boolean).join(" · "),
      timestamp: flow.started_at || flow.updated_at,
      updatedAt: flow.updated_at,
      tokens,
      networkFlows: [flow],
      relatedIds: [],
      confidence: "source",
      whyNext: category === "Model" ? "network flow carried model traffic" : "network flow is available as evidence for nearby loop steps",
      input: flow.path || flow.url,
      output: `${flow.chunk_count || 0} chunks · ${flow.total_chunk_bytes || 0} bytes`,
      raw: flow,
      meta: {
        category,
        host: flow.host,
        path: flow.path,
        model: semantic.model,
        mcpServer: semantic.mcp_server,
        tools: semantic.tool_names || [],
      },
    };
  });
}

function createTurn(index, timestamp) {
  return {
    id: `turn:${index}`,
    index,
    title: `Turn ${index}`,
    status: "success",
    startedAt: timestamp,
    updatedAt: timestamp,
    tokens: emptyUsage(),
    steps: [],
  };
}

function addStep(turn, allSteps, step) {
  if (!turn || !step || allSteps.some((item) => item.id === step.id)) return;
  turn.steps.push(step);
  allSteps.push(step);
}

function userPromptStep(message, turnIndex) {
  return baseStep({
    id: `user:${message.id}`,
    type: "User Prompt",
    status: "success",
    title: "User prompt",
    subtitle: message.text || "User message",
    timestamp: message.timestamp,
    turnIndex,
    input: message.text,
    whyNext: "user prompt started a new agent turn",
    raw: message.raw,
  });
}

function modelStepFromMessage(message, turnIndex) {
  const hasTools = message.toolUses.length > 0;
  return baseStep({
    id: `model:${message.id}`,
    type: "Model Step",
    status: message.stopReason === "max_tokens" ? "retried" : "success",
    title: message.model || "Assistant model step",
    subtitle: message.text || (hasTools ? `${message.toolUses.length} tool_use blocks` : "assistant message"),
    timestamp: message.timestamp,
    turnIndex,
    tokens: message.tokens,
    input: message.text,
    output: hasTools ? message.toolUses.map((tool) => `${tool.name}(${tool.id})`).join("\n") : message.text,
    whyNext: hasTools ? "assistant emitted tool_use, so tool batch started" : "assistant did not emit tool_use in this step",
    raw: message.raw,
    meta: {
      model: message.model,
      stopReason: message.stopReason,
      thinking: message.thinking_count,
    },
  });
}

function toolBatchStep(message, turnIndex, parentId) {
  return baseStep({
    id: `tool-batch:${message.id}`,
    type: "Tool Batch",
    status: "running",
    title: `${message.toolUses.length} tool call${message.toolUses.length > 1 ? "s" : ""}`,
    subtitle: message.toolUses.map((tool) => tool.name).join(", "),
    timestamp: message.timestamp,
    turnIndex,
    parentId,
    relatedIds: [parentId],
    output: message.toolUses.map((tool) => `${tool.name} · ${tool.id || "no id"}`).join("\n"),
    whyNext: "Claude Code batches tool_use blocks before feeding tool_result messages back to the model",
    raw: message.raw,
  });
}

function toolUseStep(tool, message, turnIndex, parentId) {
  const type = inferToolType(tool);
  const mcpCategory = classifyMcpTool(tool.name);
  return baseStep({
    id: `tool:${tool.id || `${message.id}:${tool.name}`}`,
    type,
    status: tool.id ? "running" : "unmatched",
    title: type === "Skill" ? skillName(tool) : tool.name || "unknown tool",
    subtitle: type === "MCP" ? `${mcpCategory} MCP tool` : tool.inputPreview || "tool_use",
    timestamp: message.timestamp,
    turnIndex,
    parentId,
    relatedIds: [parentId].filter(Boolean),
    input: stringifyToolInput(tool),
    whyNext: type === "Skill"
      ? "assistant invoked a skill through a tool_use block"
      : type === "MCP"
        ? "assistant invoked an MCP tool; result should return as tool_result"
        : "assistant emitted tool_use; result should return with the same tool_use_id",
    raw: tool,
    meta: {
      toolId: tool.id,
      toolName: tool.name,
      mcpCategory,
    },
  });
}

function toolResultStep(result, message, turnIndex, parentId) {
  return baseStep({
    id: `tool-result:${result.tool_use_id || `${message.id}:result`}`,
    type: "Tool Result",
    status: result.is_error ? "error" : parentId ? "success" : "unmatched",
    title: result.is_error ? "Tool error" : "Tool result",
    subtitle: result.contentPreview || result.tool_use_id || "result",
    timestamp: message.timestamp,
    turnIndex,
    parentId,
    relatedIds: [parentId].filter(Boolean),
    output: normalizeContentPreview(result.content),
    whyNext: result.is_error
      ? "tool_result returned error, so the model may retry or recover"
      : "tool_result is appended to the conversation before the next model step",
    raw: result,
    meta: {
      toolUseId: result.tool_use_id,
    },
  });
}

function compactStep(message, turnIndex) {
  return baseStep({
    id: `compact:${message.id}`,
    type: "Compact",
    status: "compacted",
    title: "Compact boundary",
    subtitle: message.text || "context was compacted",
    timestamp: message.timestamp,
    turnIndex,
    whyNext: "context pressure triggered compact before continuing the agent loop",
    raw: message.raw,
  });
}

function rateLimitStep(message, turnIndex) {
  return baseStep({
    id: `rate-limit:${message.id}`,
    type: "Rate Limit",
    status: "retried",
    title: "Rate limit",
    subtitle: message.text || "rate_limit_event",
    timestamp: message.timestamp,
    turnIndex,
    whyNext: "rate limit event delayed or changed the next model request",
    raw: message.raw,
  });
}

function progressStep(message, turnIndex) {
  return baseStep({
    id: `progress:${message.id}`,
    type: "Tool",
    status: "running",
    title: "Tool progress",
    subtitle: message.text || "tool_progress",
    timestamp: message.timestamp,
    turnIndex,
    whyNext: "tool is still running and producing progress updates",
    raw: message.raw,
  });
}

function summaryStep(message, turnIndex) {
  return baseStep({
    id: `tool-summary:${message.id}`,
    type: "Tool Batch",
    status: "success",
    title: "Tool use summary",
    subtitle: message.text || "tool_use_summary",
    timestamp: message.timestamp,
    turnIndex,
    whyNext: "Claude Code emitted a compact summary of tool usage",
    raw: message.raw,
  });
}

function finalResultStep(message, turnIndex, parentId) {
  return baseStep({
    id: `final:${message.id}`,
    type: "Final Result",
    status: "success",
    title: "Final result",
    subtitle: message.text || "assistant completed this turn",
    timestamp: message.timestamp,
    turnIndex,
    parentId,
    relatedIds: [parentId].filter(Boolean),
    output: message.text,
    whyNext: "assistant reached end_turn without additional tool_use blocks",
    raw: message.raw,
  });
}

function baseStep(step) {
  return {
    parentId: null,
    relatedIds: [],
    networkFlows: [],
    tokens: emptyUsage(),
    input: "",
    output: "",
    confidence: "exact",
    meta: {},
    ...step,
  };
}

function correlateNetworkFlows(turns, steps, flowSteps) {
  const loopSteps = steps.filter((step) => step.type !== "Network Flow");
  for (const flowStep of flowSteps) {
    const nearest = nearestStep(loopSteps, flowStep);
    if (!nearest) {
      flowStep.status = flowStep.status === "error" ? "error" : "unmatched";
      flowStep.confidence = "low";
      continue;
    }
    const diff = Math.abs(timeMs(nearest.timestamp) - timeMs(flowStep.timestamp));
    const semanticBoost = sharesSemantic(nearest, flowStep);
    const confidence = semanticBoost ? "high" : diff < 180_000 ? "medium" : "low";
    if (confidence !== "low") {
      nearest.networkFlows.push(flowStep.raw);
      nearest.relatedIds.push(flowStep.id);
      flowStep.relatedIds.push(nearest.id);
      flowStep.parentId = nearest.id;
      flowStep.confidence = confidence;
    } else {
      flowStep.status = flowStep.status === "error" ? "error" : "unmatched";
      flowStep.confidence = "low";
    }
  }

  for (const turn of turns) {
    const turnFlows = flowSteps.filter((flow) => {
      if (!turn.steps.length) return false;
      return flow.parentId && turn.steps.some((step) => step.id === flow.parentId);
    });
    for (const flow of turnFlows) {
      if (!turn.steps.some((step) => step.id === flow.id)) continue;
    }
  }
}

function nearestStep(steps, flowStep) {
  const flowTime = timeMs(flowStep.timestamp);
  if (!flowTime) return null;
  return steps
    .filter((step) => timeMs(step.timestamp) > 0)
    .map((step) => ({ step, diff: Math.abs(timeMs(step.timestamp) - flowTime), semantic: sharesSemantic(step, flowStep) }))
    .sort((a, b) => Number(b.semantic) - Number(a.semantic) || a.diff - b.diff)[0]?.step || null;
}

function nearestTurn(turns, timestamp) {
  const target = timeMs(timestamp);
  if (!target) return turns.at(-1) || null;
  return turns
    .map((turn) => ({ turn, diff: Math.min(...turn.steps.map((step) => Math.abs(timeMs(step.timestamp) - target)).filter(Number.isFinite), Infinity) }))
    .sort((a, b) => a.diff - b.diff)[0]?.turn || turns.at(-1) || null;
}

function sharesSemantic(step, flowStep) {
  const meta = flowStep.meta || {};
  const stepText = `${step.title} ${step.subtitle} ${step.meta?.toolName || ""} ${step.meta?.model || ""}`.toLowerCase();
  return Boolean(
    (meta.model && stepText.includes(String(meta.model).toLowerCase()))
      || (meta.mcpServer && stepText.includes(String(meta.mcpServer).toLowerCase()))
      || (meta.tools || []).some((tool) => stepText.includes(String(tool).toLowerCase())),
  );
}

function inferToolType(tool) {
  const name = String(tool.name || "");
  const input = JSON.stringify(tool.input || tool.inputPreview || "").toLowerCase();
  if (name === "Skill" || name === "SkillTool" || input.includes('"skill"')) return "Skill";
  if (name.includes("__") || name.startsWith("mcp__") || input.includes("mcp")) return "MCP";
  return "Tool";
}

function classifyMcpTool(name = "") {
  const normalized = normalizeToolName(name);
  if (MCP_SEARCH_TOOLS.has(normalized) || normalized.includes("search")) return "search";
  if (MCP_READ_PREFIXES.some((prefix) => normalized.startsWith(prefix))) return "read";
  if (/^(create|update|delete|send|post|write|add|remove|archive|label)_/.test(normalized)) return "write";
  if (normalized) return "action";
  return "unknown";
}

function normalizeToolName(name) {
  return String(name)
    .replace(/^mcp__[^_]+__/, "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replaceAll("-", "_")
    .toLowerCase();
}

function skillName(tool) {
  const input = tool.input || parseMaybeJson(tool.inputPreview);
  return input?.skill || input?.name || tool.name || "Skill";
}

function normalizeToolUse(tool) {
  return {
    id: tool.id,
    name: tool.name || "unknown tool",
    input: tool.input,
    inputPreview: normalizeContentPreview(tool.input),
  };
}

function normalizeToolResult(result) {
  return {
    tool_use_id: result.tool_use_id,
    is_error: Boolean(result.is_error),
    content: result.content,
    contentPreview: normalizeContentPreview(result.content),
  };
}

function normalizeUsage(usage = {}) {
  const cacheRead = number(usage.cache_read_input_tokens ?? usage.cacheReadInputTokens);
  const cacheCreation = number(usage.cache_creation_input_tokens ?? usage.cacheCreationInputTokens);
  const cached = number(usage.cached_input_tokens ?? usage.cachedInputTokens);
  return {
    inputTokens: number(usage.input_tokens ?? usage.inputTokens),
    outputTokens: number(usage.output_tokens ?? usage.outputTokens),
    cacheReadInputTokens: cacheRead || cached,
    cacheCreationInputTokens: cacheCreation,
    cachedInputTokens: cached || cacheRead + cacheCreation,
    reasoningOutputTokens: number(usage.reasoning_output_tokens ?? usage.reasoningOutputTokens),
    webSearchRequests: number(usage.web_search_requests ?? usage.webSearchRequests),
    costUSD: number(usage.cost_usd ?? usage.costUSD),
    contextWindow: number(usage.context_window ?? usage.contextWindow),
    maxOutputTokens: number(usage.max_output_tokens ?? usage.maxOutputTokens),
    totalTokens: number(usage.total_tokens ?? usage.totalTokens),
  };
}

function sumUsage(items) {
  const total = emptyUsage();
  for (const usage of items || []) {
    total.inputTokens += number(usage?.inputTokens);
    total.outputTokens += number(usage?.outputTokens);
    total.cacheReadInputTokens += number(usage?.cacheReadInputTokens);
    total.cacheCreationInputTokens += number(usage?.cacheCreationInputTokens);
    total.cachedInputTokens += number(usage?.cachedInputTokens);
    total.reasoningOutputTokens += number(usage?.reasoningOutputTokens);
    total.webSearchRequests += number(usage?.webSearchRequests);
    total.costUSD += number(usage?.costUSD);
    total.totalTokens += usageTotal(usage);
  }
  return total;
}

function emptyUsage() {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    cachedInputTokens: 0,
    reasoningOutputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
    contextWindow: 0,
    maxOutputTokens: 0,
    totalTokens: 0,
  };
}

function contentBlocks(content) {
  return Array.isArray(content) ? content : [];
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  return contentBlocks(content)
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .filter(Boolean)
    .join("\n");
}

function stringifyToolInput(tool) {
  if (tool.input !== undefined) return JSON.stringify(tool.input, null, 2);
  return tool.inputPreview || "{}";
}

function normalizeContentPreview(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value;
  return JSON.stringify(value, null, 2);
}

function parseMaybeJson(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function flowTitle(flow) {
  const semantic = flow.semantic || {};
  if (semantic.skill_names?.length) return `Skill: ${semantic.skill_names.join(", ")}`;
  if (semantic.tool_names?.length) return semantic.tool_names.join(", ");
  if (semantic.rpc_method) return semantic.rpc_method;
  if (semantic.model) return semantic.model;
  return `${flow.method || "-"} ${semantic.category || flow.provider || "HTTP"}`;
}

function diagnosticsForLoop(messages, flows, steps) {
  const diagnostics = [];
  if (!messages.length) diagnostics.push("No Claude session messages available; AI Loop is inferred from proxy flows only.");
  if (!flows.length) diagnostics.push("No proxy flows available; network correlation is empty.");
  const unmatched = steps.filter((step) => step.status === "unmatched").length;
  if (unmatched) diagnostics.push(`${unmatched} step${unmatched > 1 ? "s" : ""} could not be matched with a parent/result.`);
  if (!diagnostics.length) diagnostics.push("Loop model ready.");
  return diagnostics;
}

function stepSort(a, b) {
  return timeMs(a.timestamp) - timeMs(b.timestamp)
    || LOOP_STEP_ORDER.indexOf(a.type) - LOOP_STEP_ORDER.indexOf(b.type)
    || String(a.id).localeCompare(String(b.id));
}

function timeMs(value) {
  if (!value) return 0;
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  const time = date.getTime();
  return Number.isNaN(time) ? 0 : time;
}

function number(value) {
  const next = Number(value || 0);
  return Number.isFinite(next) ? next : 0;
}
