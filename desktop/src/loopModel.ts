type AnyRecord = Record<string, any>;

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

// Pricing per 1M tokens in USD (input / output / cached_input)
const MODEL_PRICING: Record<string, { input: number; output: number; cached?: number }> = {
  "claude-sonnet-4-20250514": { input: 3, output: 15, cached: 0.3 },
  "claude-sonnet-4-6": { input: 3, output: 15, cached: 0.3 },
  "claude-opus-4-20250514": { input: 15, output: 75, cached: 1.5 },
  "claude-opus-4-6": { input: 15, output: 75, cached: 1.5 },
  "claude-3-5-sonnet-20241022": { input: 3, output: 15, cached: 0.3 },
  "claude-3-5-haiku-20241022": { input: 0.8, output: 4, cached: 0.08 },
  "claude-3-haiku-20240307": { input: 0.25, output: 1.25, cached: 0.03 },
  "gpt-4o": { input: 2.5, output: 10, cached: 1.25 },
  "gpt-4o-mini": { input: 0.15, output: 0.6, cached: 0.075 },
  "gpt-4.1": { input: 2, output: 8, cached: 0.5 },
  "gpt-4.1-mini": { input: 0.4, output: 1.6, cached: 0.1 },
  "gpt-4.1-nano": { input: 0.1, output: 0.4, cached: 0.025 },
  "o3": { input: 2, output: 8, cached: 0.5 },
  "o3-mini": { input: 1.1, output: 4.4, cached: 0.275 },
  "o4-mini": { input: 1.1, output: 4.4, cached: 0.275 },
  "glm-4.7": { input: 0.5, output: 0.5, cached: 0.05 },
};

export function buildAgentLoopModel({ flows = [], claudeSessionDetail = null, hookEvents = [], sourceFilter = "all" }: AnyRecord = {}) {
  const messages = normalizeMessages(claudeSessionDetail?.messages || []);
  const rawHookSteps = normalizeHookSteps(hookEvents);
  pairHookToolSteps(rawHookSteps);
  const hookSteps = rawHookSteps.filter(isLoopVisibleHookStep);
  const flowSteps = normalizeFlowSteps(flows);
  const turns = [];
  const allSteps = [];
  const toolUseMap = new Map();
  let currentTurn = null;
  let turnIndex = 0;

  for (const message of messages) {
    const isToolResultOnly = message.toolResults.length > 0 && !message.text && message.role === "user";
    const startsUserTurn = message.role === "user" && !isToolResultOnly;
    if (!messageCreatesLoopStep(message, isToolResultOnly)) continue;
    if (startsUserTurn || !currentTurn) {
      turnIndex += 1;
      currentTurn = createTurn(turnIndex, message.timestamp);
      turns.push(currentTurn);
    }

    const turn = currentTurn;
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

  const hookStartsOwnTurns = turns.length === 0;
  for (const hookStep of hookSteps) {
    const startsTurn = hookStep.meta?.eventName === "UserPromptSubmit";
    if ((hookStartsOwnTurns && startsTurn) || !currentTurn) {
      turnIndex += 1;
      currentTurn = createTurn(turnIndex, hookStep.timestamp);
      turns.push(currentTurn);
    }
    const turn = hookStartsOwnTurns ? currentTurn : nearestTurn(turns, hookStep.timestamp) || currentTurn;
    hookStep.turnIndex = turn.index;
    addStep(turn, allSteps, hookStep);
  }

  const proxyOnlyInference = messages.length === 0 && rawHookSteps.length === 0;
  const visibleFlowSteps = turns.length > 0 || proxyOnlyInference ? flowSteps : [];

  if (turns.length === 0 && proxyOnlyInference && flowSteps.length > 0) {
    currentTurn = createTurn(1, flowSteps[0]?.timestamp || hookSteps[0]?.timestamp);
    turns.push(currentTurn);
  }

  correlateNetworkFlows(turns, allSteps, visibleFlowSteps);
  for (const step of visibleFlowSteps) {
    const turn = nearestTurn(turns, step.timestamp) || currentTurn;
    if (!turn) continue;
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
      rawHookSteps.length,
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
      hooks: rawHookSteps.length,
      errors: sortedSteps.filter((step) => step.status === "error").length,
      unmatched: sortedSteps.filter((step) => step.status === "unmatched").length,
      tokens: sumUsage(sortedSteps.map((step) => step.tokens)),
      estimatedCost: computeLoopCost(turns),
    },
    diagnostics: diagnosticsForLoop(messages, flows, sortedSteps, rawHookSteps),
  };
}

export function stepTypeClass(type = "") {
  return `loop-type-${type.toLowerCase().replaceAll(" ", "-")}`;
}

export function stepStatusClass(status = "") {
  return `loop-status-${status.toLowerCase()}`;
}

export function formatLoopTokens(usage: AnyRecord = {}) {
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

export function usageTotal(usage: AnyRecord = {}) {
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

export function estimateCost(usage: AnyRecord = {}, model?: string): number {
  if (!model) return 0;
  const pricing = findPricing(model);
  if (!pricing) return 0;
  const inputTokens = Number(usage.inputTokens || usage.input_tokens || 0);
  const outputTokens = Number(usage.outputTokens || usage.output_tokens || 0);
  const cachedTokens = Number(usage.cachedInputTokens || usage.cached_input_tokens || usage.cacheReadInputTokens || usage.cache_read_input_tokens || 0);
  const netInput = Math.max(0, inputTokens - cachedTokens);
  return (netInput * pricing.input + outputTokens * pricing.output + cachedTokens * (pricing.cached || pricing.input * 0.1)) / 1_000_000;
}

export function formatCostUSD(cost: number): string {
  if (cost <= 0) return "-";
  if (cost < 0.001) return `<$0.001`;
  if (cost < 0.01) return `$${cost.toFixed(4)}`;
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

function findPricing(model: string) {
  if (!model) return null;
  const lower = model.toLowerCase();
  // Exact match
  if (MODEL_PRICING[lower]) return MODEL_PRICING[lower];
  // Prefix match (handle version suffixes)
  for (const [key, pricing] of Object.entries(MODEL_PRICING)) {
    if (lower.startsWith(key) || lower.includes(key)) return pricing;
  }
  return null;
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
    if (isInternalHookFlow(flow)) return null;
    if (semantic.low_signal && status === "success") return null;
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
      correlation: { confidence: "source", reasons: ["same capture file"] },
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
        lowSignal: Boolean(semantic.low_signal),
      },
    };
  }).filter(Boolean);
}

function messageCreatesLoopStep(message, isToolResultOnly) {
  if (message.role === "user" && !isToolResultOnly) return true;
  if (message.role === "assistant") return true;
  if (message.toolResults.length > 0) return true;
  return isLoopEventMessage(message);
}

function isLoopEventMessage(message) {
  return message.kind === "compact_boundary"
    || message.subtype === "compact_boundary"
    || message.kind === "rate_limit_event"
    || message.typeName === "rate_limit_event"
    || message.kind === "tool_progress"
    || message.typeName === "tool_progress"
    || message.kind === "tool_use_summary"
    || message.typeName === "tool_use_summary";
}

function isLoopVisibleHookStep(step) {
  const eventName = step?.meta?.eventName;
  return eventName !== "SessionStart" && eventName !== "SessionEnd" && eventName !== "Notification";
}

function isInternalHookFlow(flow: AnyRecord = {}) {
  const host = String(flow.host || flow.url || "").toLowerCase();
  const path = String(flow.path || flow.url || "").toLowerCase();
  return (host.includes("127.0.0.1") || host.includes("localhost")) && path.includes("/hooks/");
}

function normalizeHookSteps(events = []) {
  return (events || []).map((event, index) => {
    const raw = event.raw || {};
    const eventName = event.event_name || raw.hook_event_name || raw.hookEventName || "unknown";
    const source = event.source || "hook";
    const toolName = hookField(event, raw, "tool_name", "toolName", "tool");
    const toolUseId = hookField(event, raw, "tool_use_id", "toolUseId", "tool_call_id", "call_id");
    const inputPayload = hookInputPayload(event, raw);
    const outputPayload = hookOutputPayload(event, raw);
    const type = hookStepType(eventName, toolName, event, raw);
    const status = hookStepStatus(eventName, event, raw);
    return baseStep({
      id: event.id || `hook:${source}:${eventName}:${index}`,
      type,
      status,
      title: hookStepTitle(eventName, toolName, event, raw),
      subtitle: hookStepSubtitle(eventName, event, raw),
      timestamp: event.received_at || raw.timestamp,
      input: normalizeContentPreview(inputPayload ?? raw),
      output: normalizeContentPreview(outputPayload),
      whyNext: hookWhyNext(eventName, status, event, raw),
      raw: event,
      confidence: "exact",
      meta: {
        source,
        eventName,
        captureFile: event.capture_file,
        runSource: event.run_source,
        runListen: event.run_listen,
        runStartedAt: event.run_started_at,
        hookSource: event.hook_source || raw.source,
        sessionId: hookField(event, raw, "session_id", "sessionId", "thread_id"),
        turnId: hookField(event, raw, "turn_id", "turnId"),
        transcriptPath: hookField(event, raw, "transcript_path", "transcriptPath"),
        cwd: hookField(event, raw, "cwd"),
        model: hookField(event, raw, "model"),
        permissionMode: hookField(event, raw, "permission_mode", "permissionMode"),
        agentId: hookField(event, raw, "agent_id", "agentId"),
        agentType: hookField(event, raw, "agent_type", "agentType"),
        toolName,
        toolUseId,
        permissionSuggestions: event.permission_suggestions || raw.permission_suggestions || raw.permissionSuggestions,
        prompt: event.prompt || raw.prompt,
        message: event.message || raw.message || raw.last_assistant_message,
        lastAssistantMessage: event.last_assistant_message || raw.last_assistant_message || raw.lastAssistantMessage,
        title: event.title || raw.title,
        error: event.error || raw.error || raw.error_message || raw.error_details,
        reason: event.reason || raw.reason || raw.stop_reason || raw.permission_decision_reason,
        decision: event.decision || raw.decision || raw.permission_decision || raw.behavior || raw.action,
        trigger: event.trigger || raw.trigger,
        customInstructions: event.custom_instructions || raw.custom_instructions || raw.customInstructions,
        compactSummary: event.compact_summary || raw.compact_summary || raw.compactSummary,
        action: event.action || raw.action,
        notificationType: event.notification_type || raw.notification_type || raw.notificationType,
        mcpServerName: event.mcp_server_name || raw.mcp_server_name || raw.mcpServerName,
        elicitationId: event.elicitation_id || raw.elicitation_id || raw.elicitationId,
        filePath: event.file_path || raw.file_path || raw.filePath,
        fileEvent: event.file_event || raw.event || raw.file_event || raw.fileEvent,
        triggerFilePath: event.trigger_file_path || raw.trigger_file_path || raw.triggerFilePath,
        parentFilePath: event.parent_file_path || raw.parent_file_path || raw.parentFilePath,
        memoryType: event.memory_type || raw.memory_type || raw.memoryType,
        loadReason: event.load_reason || raw.load_reason || raw.loadReason,
        oldCwd: event.old_cwd || raw.old_cwd || raw.oldCwd,
        newCwd: event.new_cwd || raw.new_cwd || raw.newCwd,
        worktreePath: event.worktree_path || raw.worktree_path || raw.worktreePath,
        worktreeName: event.worktree_name || raw.worktree_name || raw.worktreeName || raw.name,
        taskId: event.task_id || raw.task_id || raw.taskId,
        taskSubject: event.task_subject || raw.task_subject || raw.taskSubject,
        teammateName: event.teammate_name || raw.teammate_name || raw.teammateName,
        teamName: event.team_name || raw.team_name || raw.teamName,
        stopHookActive: event.stop_hook_active ?? raw.stop_hook_active,
        isInterrupt: event.is_interrupt ?? raw.is_interrupt ?? raw.interrupt,
        payloadSize: event.payload_size,
        payloadPreview: event.payload_preview,
        extracted: event.extracted,
      },
    });
  }).sort(stepSort);
}

function pairHookToolSteps(steps = []) {
  const pending = new Map();
  for (const step of [...steps].sort(stepSort)) {
    const eventName = step.meta?.eventName;
    const key = hookToolPairKey(step);
    if (!key) continue;
    if (eventName === "PreToolUse") {
      if (!pending.has(key)) pending.set(key, []);
      pending.get(key).push(step);
      continue;
    }
    if (eventName !== "PostToolUse" && eventName !== "PostToolUseFailure") continue;
    const candidates = pending.get(key) || [];
    const preStep = candidates.pop();
    if (!preStep) continue;
    preStep.status = step.status === "error" ? "error" : "success";
    preStep.output = step.output || preStep.output;
    preStep.whyNext = step.status === "error"
      ? "official hooks paired tool start with a failed tool result"
      : "official hooks paired tool start with its result";
    preStep.relatedIds = dedupeList([...(preStep.relatedIds || []), step.id]);
    step.relatedIds = dedupeList([...(step.relatedIds || []), preStep.id]);
    step.parentId = preStep.id;
  }
}

function hookToolPairKey(step) {
  const meta = step?.meta || {};
  const source = meta.source || "hook";
  const toolUseId = meta.toolUseId;
  if (toolUseId) return `${source}:tool-use:${toolUseId}`;
  const session = meta.sessionId || meta.captureFile || "";
  const tool = meta.toolName || step.title;
  if (!tool) return null;
  return `${source}:tool:${session}:${tool}`;
}

function dedupeList(items = []) {
  return [...new Set(items.filter(Boolean))];
}

function hookStepType(eventName, toolName, event: AnyRecord = {}, raw: AnyRecord = {}) {
  if (eventName === "UserPromptSubmit" || eventName === "SessionStart") return "User Prompt";
  if (eventName === "Stop" || eventName === "StopFailure" || eventName === "SessionEnd") return "Final Result";
  if (eventName === "PreCompact" || eventName === "PostCompact") return "Compact";
  if (eventName === "PermissionRequest" || eventName === "PermissionDenied") return "Permission";
  if (eventName === "PostToolUse" || eventName === "PostToolUseFailure") return "Tool Result";
  if (eventName === "InstructionsLoaded" || eventName === "ConfigChange" || eventName === "FileChanged" || eventName === "CwdChanged" || eventName === "WorktreeCreate" || eventName === "WorktreeRemove") return "Skill";
  if (eventName === "TaskCreated" || eventName === "TaskCompleted" || eventName === "TeammateIdle") return "Model Step";
  if (eventName === "PreToolUse") return inferToolType({ name: toolName });
  if (eventName === "Elicitation" || eventName === "ElicitationResult" || event.mcp_server_name || raw.mcp_server_name) return "MCP";
  if (eventName === "SubagentStart" || eventName === "SubagentStop") return "Model Step";
  return "Model Step";
}

function hookStepStatus(eventName, event: AnyRecord = {}, raw: AnyRecord = {}) {
  if (eventName.endsWith("Failure")) return "error";
  if (event.error || raw.error || raw.error_message || raw.error_details) return "error";
  if (eventName === "PermissionDenied") return "denied";
  if ((event.decision || raw.decision || raw.behavior) === "deny" || raw.action === "decline") return "denied";
  if (eventName === "TaskCompleted" || eventName === "SubagentStop" || eventName === "SessionEnd") return "success";
  if (eventName === "PreCompact" || eventName === "PostCompact") return "compacted";
  if (eventName === "PreToolUse" || eventName === "PermissionRequest" || eventName === "SubagentStart") return "running";
  if (raw.is_error) return "error";
  return "success";
}

function hookStepTitle(eventName, toolName, event: AnyRecord = {}, raw: AnyRecord = {}) {
  if (toolName && (eventName.includes("ToolUse") || eventName.includes("Permission"))) return toolName;
  if (eventName === "UserPromptSubmit") return "User prompt";
  if (eventName === "Elicitation" || eventName === "ElicitationResult") return event.mcp_server_name || raw.mcp_server_name || "MCP elicitation";
  if (eventName === "InstructionsLoaded") return event.file_path || raw.file_path || "Instructions loaded";
  if (eventName === "FileChanged") return event.file_path || raw.file_path || "File changed";
  if (eventName === "CwdChanged") return "CWD changed";
  if (eventName === "WorktreeCreate" || eventName === "WorktreeRemove") return event.worktree_name || raw.worktree_name || raw.name || event.worktree_path || raw.worktree_path || eventName.replace(/([a-z])([A-Z])/g, "$1 $2");
  if (eventName === "TaskCreated" || eventName === "TaskCompleted") return event.task_subject || raw.task_subject || eventName.replace(/([a-z])([A-Z])/g, "$1 $2");
  return eventName.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function hookStepSubtitle(eventName, event, raw) {
  const source = event.source || "hook";
  const toolName = hookField(event, raw, "tool_name", "toolName", "tool");
  const session = hookField(event, raw, "session_id", "sessionId", "thread_id");
  const cwd = hookField(event, raw, "cwd");
  const model = hookField(event, raw, "model");
  const prompt = hookField(event, raw, "prompt");
  const message = hookField(event, raw, "message");
  const trigger = hookField(event, raw, "trigger");
  const loadReason = hookField(event, raw, "load_reason", "loadReason");
  const permissionMode = hookField(event, raw, "permission_mode", "permissionMode");
  if (toolName) return `${source} · ${eventName} · ${toolName}`;
  if (model) return `${source} · ${eventName} · ${model}`;
  if (trigger) return `${source} · ${eventName} · ${trigger}`;
  if (loadReason) return `${source} · ${eventName} · ${loadReason}`;
  if (permissionMode) return `${source} · ${eventName} · ${permissionMode}`;
  if (prompt) return `${source} · ${compactInline(prompt, 72)}`;
  if (message) return `${source} · ${compactInline(message, 72)}`;
  if (cwd) return `${source} · ${compactPath(cwd)}`;
  if (session) return `${source} · ${session}`;
  return source;
}

function hookWhyNext(eventName, status, event: AnyRecord = {}, raw: AnyRecord = {}) {
  if (eventName === "UserPromptSubmit") return "official hook captured the submitted user prompt before the agent loop continued";
  if (eventName === "PreToolUse") return "official hook observed tool execution before the tool ran";
  if (eventName === "PostToolUse") return "official hook observed tool output before the next model step";
  if (eventName === "PostToolUseFailure") return "official hook observed a tool failure, so the model may need to recover";
  if (eventName === "PermissionRequest") return "official hook observed a permission gate before tool execution";
  if (eventName === "PermissionDenied" || status === "denied") return "permission was denied and should produce a recovery path";
  if (eventName === "PreCompact" || eventName === "PostCompact") return "official hook observed context compaction around this turn";
  if (eventName === "InstructionsLoaded") return "official hook observed project or user instructions entering context";
  if (eventName === "ConfigChange") return "official hook observed configuration changing during the session";
  if (eventName === "CwdChanged" || eventName === "FileChanged") return "official hook observed environment changes that can affect later tool behavior";
  if (eventName === "Elicitation" || eventName === "ElicitationResult") return "official hook observed MCP user input negotiation";
  if (eventName === "TaskCreated" || eventName === "TaskCompleted" || eventName === "TeammateIdle") return "official hook observed task or teammate lifecycle context";
  if (eventName === "WorktreeCreate" || eventName === "WorktreeRemove") return "official hook observed worktree lifecycle changes";
  if (eventName === "StopFailure" || event.error || raw.error) return "official hook captured a stop or hook failure that may explain the next recovery step";
  if (eventName === "Stop" || eventName === "SessionEnd") return "official hook observed the agent stopping";
  return "official hook event provides structured evidence for the loop";
}

function hookField(event: AnyRecord = {}, raw: AnyRecord = {}, ...keys) {
  for (const key of keys) {
    const direct = event[key] ?? raw[key];
    if (direct !== undefined && direct !== null && direct !== "") return direct;
  }
  const extracted = event.extracted || {};
  for (const key of keys) {
    const value = extracted[key];
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function hookInputPayload(event: AnyRecord = {}, raw: AnyRecord = {}) {
  return event.tool_input
    ?? raw.tool_input
    ?? raw.toolInput
    ?? event.prompt
    ?? raw.prompt
    ?? event.message
    ?? raw.message
    ?? raw.last_assistant_message
    ?? raw.lastAssistantMessage
    ?? raw.custom_instructions
    ?? raw.customInstructions
    ?? raw.permission_suggestions
    ?? raw.permissionSuggestions
    ?? raw.requested_schema
    ?? raw.content
    ?? event.extracted?.tool_input;
}

function hookOutputPayload(event: AnyRecord = {}, raw: AnyRecord = {}) {
  return event.tool_response
    ?? raw.tool_response
    ?? raw.toolResponse
    ?? raw.tool_result
    ?? raw.toolResult
    ?? raw.response
    ?? raw.result
    ?? raw.output
    ?? raw.compact_summary
    ?? raw.compactSummary
    ?? raw.last_assistant_message
    ?? raw.lastAssistantMessage
    ?? raw.content
    ?? raw.error
    ?? event.error
    ?? event.extracted?.tool_response
    ?? "";
}

function compactInline(value, max = 80) {
  const text = typeof value === "string" ? value : normalizeContentPreview(value);
  const singleLine = text.replace(/\s+/g, " ").trim();
  return singleLine.length > max ? `${singleLine.slice(0, max - 3)}...` : singleLine;
}

function compactPath(value) {
  const text = String(value || "");
  const parts = text.split("/").filter(Boolean);
  if (parts.length <= 2) return text;
  return `.../${parts.slice(-2).join("/")}`;
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
    const reasons = correlationReasons(nearest, flowStep, diff, semanticBoost, confidence);
    if (confidence !== "low") {
      nearest.networkFlows.push({
        ...flowStep.raw,
        correlation: { confidence, reasons },
      });
      nearest.relatedIds.push(flowStep.id);
      flowStep.relatedIds.push(nearest.id);
      flowStep.parentId = nearest.id;
      flowStep.confidence = confidence;
      flowStep.correlation = { confidence, reasons };
    } else {
      flowStep.status = flowStep.status === "error" ? "error" : "unmatched";
      flowStep.confidence = "low";
      flowStep.correlation = { confidence, reasons };
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

function correlationReasons(step, flowStep, diff, semanticBoost, confidence) {
  const reasons = ["same capture file"];
  if (diff < 180_000) reasons.push(`within ${Math.max(1, Math.round(diff / 1000))}s`);
  if (flowStep.meta?.model && `${step.title} ${step.subtitle}`.toLowerCase().includes(String(flowStep.meta.model).toLowerCase())) {
    reasons.push("model matched");
  }
  if (flowStep.meta?.mcpServer && `${step.title} ${step.subtitle}`.toLowerCase().includes(String(flowStep.meta.mcpServer).toLowerCase())) {
    reasons.push("MCP server matched");
  }
  if ((flowStep.meta?.tools || []).some((tool) => `${step.title} ${step.subtitle}`.toLowerCase().includes(String(tool).toLowerCase()))) {
    reasons.push("tool name matched");
  }
  if (semanticBoost && !reasons.some((reason) => reason.endsWith("matched"))) reasons.push("semantic matched");
  if (flowStep.meta?.lowSignal) reasons.push("low-signal downgraded");
  if (confidence === "low") reasons.push("low confidence");
  return reasons;
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

function normalizeUsage(usage: AnyRecord = {}) {
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

function diagnosticsForLoop(messages, flows, steps, hookSteps = []) {
  const diagnostics = [];
  if (!messages.length && !hookSteps.length) diagnostics.push("No session or hook events available; AI Loop is inferred from proxy flows only.");
  if (hookSteps.length) diagnostics.push(`${hookSteps.length} official hook event${hookSteps.length > 1 ? "s" : ""} captured.`);
  if (!flows.length) diagnostics.push("No proxy flows available; network correlation is empty.");
  const unmatched = steps.filter((step) => step.status === "unmatched").length;
  if (unmatched) diagnostics.push(`${unmatched} step${unmatched > 1 ? "s" : ""} could not be matched with a parent/result.`);

  // Detect repeated tool failures
  const toolSteps = steps.filter((step) => step.type === "Tool" || step.type === "MCP");
  const toolFailCounts = new Map<string, number>();
  for (const step of toolSteps) {
    if (step.status === "error") {
      const name = step.title || "unknown";
      toolFailCounts.set(name, (toolFailCounts.get(name) || 0) + 1);
    }
  }
  for (const [name, count] of toolFailCounts) {
    if (count >= 3) diagnostics.push(`⚠️ Tool "${name}" failed ${count} times — consider checking tool configuration.`);
  }

  // Detect token spikes
  const totalTokens = steps.reduce((sum, step) => sum + usageTotal(step.tokens), 0);
  if (totalTokens > 0) {
    for (const step of steps) {
      const stepTokens = usageTotal(step.tokens);
      if (stepTokens > 0 && stepTokens / totalTokens > 0.5) {
        diagnostics.push(`⚠️ Step "${step.title}" consumed ${Math.round(stepTokens / totalTokens * 100)}% of total tokens (${formatCompactNumber(stepTokens)}).`);
        break;
      }
    }
  }

  // Detect high null-token ratio
  const modelSteps = steps.filter((step) => step.type === "Model Step");
  const nullTokenSteps = modelSteps.filter((step) => usageTotal(step.tokens) === 0);
  if (modelSteps.length > 0 && nullTokenSteps.length / modelSteps.length > 0.5) {
    diagnostics.push(`⚠️ ${nullTokenSteps.length}/${modelSteps.length} model steps have no token data — streaming may not be fully captured.`);
  }

  // Detect pending/stale flows
  const pendingFlows = flows.filter((flow) => !flow.status);
  if (pendingFlows.length > 2) {
    diagnostics.push(`⚠️ ${pendingFlows.length} network flows are still pending — connection may have been interrupted.`);
  }

  if (!diagnostics.length) diagnostics.push("Loop model ready.");
  return diagnostics;
}

function computeLoopCost(turns) {
  let total = 0;
  for (const turn of turns) {
    for (const step of turn.steps) {
      if (step.type === "Model Step" && step.meta?.model) {
        total += estimateCost(step.tokens, step.meta.model);
      }
    }
  }
  return total;
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
