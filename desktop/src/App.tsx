import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties } from "react";
import * as ScrollArea from "@radix-ui/react-scroll-area";
import * as Select from "@radix-ui/react-select";
import * as Tabs from "@radix-ui/react-tabs";
import * as Tooltip from "@radix-ui/react-tooltip";
import { flexRender, getCoreRowModel, useReactTable } from "@tanstack/react-table";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  Activity as ActivityIcon,
  ArrowLeft,
  Bot,
  Check,
  ChevronDown,
  CircleAlert,
  CircleCheck,
  Coins,
  Gauge,
  History as HistoryIcon,
  Info as InfoIcon,
  KeyRound,
  Network,
  Palette,
  Radio,
  ReceiptText,
  Route,
  Settings as SettingsIcon,
  ShieldCheck,
  SlidersHorizontal,
  Terminal,
  Webhook,
  Workflow,
  X,
} from "lucide-react";
import appLogo from "./assets/looplens-logo.svg";
import launchGraphic from "./assets/looplens-launch.svg";
import { isNativeRuntime, nativeInvoke } from "./native";
import {
  bodyText,
  buildUnifiedTimeline,
  clientLabel,
  clientKey,
  computeAnalytics,
  computeClientStats,
  flowSearchText,
  structuredFlowSearch,
  formatTokenShort,
  formatBytes,
  formatTime,
  generateCurl,
  isNoiseFlow,
  isToolReady,
  methodClass,
  promptText,
  statusClass,
  sourceMatches,
  toolStatusLabel,
  usageTotal,
} from "./flowModel";
import {
  buildAgentLoopModel,
  estimateCost,
  formatCompactNumber,
  formatCostUSD,
  formatLoopTokens,
  stepStatusClass,
  stepTypeClass,
  usageTotal as loopUsageTotal,
} from "./loopModel";

const DEFAULT_LISTEN = "127.0.0.1:8899";
const TABS = ["Summary", "Parsed", "Prompt", "Response", "Raw", "Chunks"];
const INSPECT_TABS = ["Loop", "Timeline", "Tokens", "Raw"];
const LOOP_DETAIL_TABS = ["Summary", "Input", "Output", "Network", "Tokens", "Raw"];
const QUICK_FILTERS = [
  { label: "All", category: "All", status: "All" },
  { label: "Model", category: "Model", status: "All" },
  { label: "Tools", category: "Tool call", status: "All" },
  { label: "MCP", category: "MCP", status: "All" },
  { label: "Skills", category: "Skill", status: "All" },
  { label: "Errors", category: "All", status: "Errors" },
];

type AnyRecord = Record<string, any>;
type CssVars = CSSProperties & Record<string, string | number | undefined>;

const THEME_STORAGE_KEY = "looplens.theme";
const LANGUAGE_STORAGE_KEY = "looplens.language";
const FIRST_RUN_GUIDE_STORAGE_KEY = "looplens.firstRunGuide.dismissed";
const PREVIEW_HINT_STORAGE_KEY = "looplens.previewHint.dismissed";
const EMPTY_CAPTURE_INDEX = { file: null, flows: [], last_flow_id: null };
const EMPTY_CLAUDE_SESSION_DETAIL = { session: null, messages: [] };
const EMPTY_HOOK_EVENTS = { file: "", total: 0, events: [] };
const WINDOW_DRAG_BLOCK_SELECTOR = [
  "a",
  "button",
  "input",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='tab']",
  "[role='combobox']",
  "[data-no-window-drag]",
].join(",");
const THEMES = ["dark", "light"];
const LANGUAGES = ["en", "zh"];

const TRANSLATIONS = {
  en: {
    "app.tagline": "Visual debugger for AI agent loops",
    "sidebar.subtitle": "Agent loop workbench",
    "sidebar.sectionViews": "Workspace",
    "settings.title": "Settings",
    "settings.open": "Open settings",
    "settings.close": "Close settings",
    "settings.subtitle": "Gateway, hooks, display",
    "settings.backToApp": "Back to app",
    "settings.general": "General",
    "settings.categoryGeneral": "General",
    "settings.categoryAppearance": "Appearance",
    "settings.categoryGateway": "Gateway",
    "settings.categoryProxy": "Proxy",
    "settings.categoryHooks": "Hooks",
    "settings.categoryTrust": "Trust",
    "settings.categoryDiagnostics": "Diagnostics",
    "settings.diagnostics": "Diagnostics",
    "settings.readOnly": "Read-only",
    "settings.desc.general": "Core defaults for capture and loop review.",
    "settings.desc.appearance": "Theme and product language.",
    "settings.desc.gateway": "Local OpenAI/Anthropic compatible gateway.",
    "settings.desc.proxy": "HTTPS proxy and raw capture behavior.",
    "settings.desc.hooks": "Official Claude Code and Codex structured events.",
    "settings.desc.trust": "Native app, CA, and binary readiness.",
    "settings.desc.diagnostics": "Read-only paths and local storage policy.",
    "settings.display": "Display",
    "settings.theme": "Theme",
    "settings.themeDetail": "Switch the workbench palette instantly",
    "settings.language": "Language",
    "settings.languageDetail": "Applies to the core product UI",
    "settings.theme.dark": "Dark",
    "settings.theme.light": "Light",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.runDefaults": "Run Defaults",
    "settings.livePolling": "Live polling",
    "settings.livePollingDetail": "1s capture refresh",
    "settings.followLatest": "Follow latest",
    "settings.followLatestDetail": "Auto-select newest step",
    "settings.hideNoise": "Hide network noise",
    "settings.hideNoiseDetail": "CONNECT, registry, telemetry",
    "settings.gateway": "Gateway",
    "settings.status": "Status",
    "settings.listen": "Listen",
    "settings.openaiKey": "OpenAI key",
    "settings.openaiUrl": "OpenAI URL",
    "settings.anthropicKey": "Anthropic key",
    "settings.anthropicUrl": "Anthropic URL",
    "settings.maxRetries": "Max retries",
    "settings.redaction": "Redaction",
    "settings.redactionDetail": "Never write API keys to capture files",
    "settings.copy": "Copy",
    "settings.save": "Save",
    "settings.stop": "Stop",
    "settings.start": "Start",
    "settings.testOpenAI": "Test OpenAI",
    "settings.testAnthropic": "Test Anthropic",
    "settings.clearOpenAI": "Clear OpenAI key",
    "settings.clearAnthropic": "Clear Anthropic key",
    "settings.proxyCapture": "Proxy & Capture",
    "settings.listenAddress": "Listen address",
    "settings.bodyLimit": "Body limit",
    "settings.captureAll": "Capture all traffic",
    "settings.captureAllDetail": "Keep raw JSONL complete",
    "settings.proxy": "Proxy",
    "settings.hooks": "Hooks",
    "settings.receiver": "Receiver",
    "settings.capturedEvents": "Captured events",
    "settings.enable": "Enable",
    "settings.test": "Test",
    "settings.remove": "Remove",
    "settings.trustEnvironment": "Trust & Environment",
    "settings.nativeApp": "Native app",
    "settings.proxyBinary": "Proxy binary",
    "settings.caFiles": "CA files",
    "settings.caTrust": "CA trust",
    "settings.generateCA": "Generate CA",
    "settings.trustCA": "Trust CA",
    "settings.dataPrivacy": "Data & Privacy",
    "settings.storage": "Storage",
    "settings.rawCapture": "Raw capture",
    "settings.gatewayKeys": "Gateway keys",
    "settings.exportMode": "Export mode",
    "settings.future": "Future",
    "settings.interface": "Interface",
    "settings.defaultView": "Default view",
    "settings.history": "History",
    "settings.typography": "Typography",
    "settings.paths": "Paths",
    "settings.project": "Project",
    "settings.captures": "Captures",
    "settings.hookEvents": "Hook events",
    "settings.gatewaySettings": "Gateway settings",
    "value.running": "running",
    "value.stopped": "stopped",
    "value.external": "external",
    "value.enabled": "enabled",
    "value.preview": "preview",
    "value.ready": "ready",
    "value.missing": "missing",
    "value.generated": "generated",
    "value.trusted": "trusted",
    "value.notTrusted": "not trusted",
    "value.installed": "installed",
    "value.notInstalled": "not installed",
    "value.offline": "offline",
    "value.localOnly": "local only",
    "value.retained": "retained",
    "value.localMasked": "local masked",
    "value.manual": "manual",
    "value.redactedBundle": "redacted bundle",
    "value.collapsed": "collapsed",
    "value.systemMono": "system + mono",
    "value.densityThemeFont": "density, theme, font size",
    "run.openCodex": "Open Codex",
    "run.openClaude": "Open Claude Code",
    "run.idle": "Idle",
    "run.live": "Live",
    "run.current": "Current Run",
    "run.refresh": "Refresh",
    "run.clear": "Clear",
    "run.confirm": "Confirm",
    "run.clearing": "Clearing...",
    "run.cleared": "Cleared {count}",
    "run.nothingToClear": "Nothing to clear",
    "run.noPrevious": "No previous runs.",
    "run.exportLoop": "Export Loop",
    "hooks.title": "Structured Hooks",
    "hooks.receiverLive": "Receiver live",
    "hooks.receiverOffline": "Receiver offline",
    "hooks.events": "{count} events",
    "hooks.enabled": "enabled",
    "hooks.setup": "setup",
    "hooks.httpHooks": "HTTP hooks",
    "hooks.commandHooks": "command hooks",
    "hooks.notInstalled": "not installed",
    "toolbar.title": "Inspect Workbench",
    "toolbar.liveReview": "Live capture review",
    "toolbar.paused": "Capture paused",
    "toolbar.searchPlaceholder": "Search URL, host, provider, method, status",
    "toolbar.searchFlows": "Search flows",
    "toolbar.mainViews": "Main views",
    "toolbar.quickFilters": "Quick filters",
    "toolbar.loopFocus": "Loop focus",
    "toolbar.categoryFilter": "Category filter",
    "toolbar.statusFilter": "Status filter",
    "toolbar.visibleFlows": "{shown}/{total} flows visible",
    "toolbar.live": "Live",
    "toolbar.followLatest": "Follow latest",
    "toolbar.hideNoise": "Hide noise",
    "toolbar.noFile": "No file selected",
    "runbar.label": "Run controls",
    "runbar.proxy": "Proxy",
    "runbar.gateway": "Gateway",
    "runbar.run": "Run",
    "runbar.start": "Start",
    "runbar.stop": "Stop",
    "runbar.startProxy": "Start proxy",
    "runbar.stopProxy": "Stop proxy",
    "view.Activity": "Activity",
    "view.Inspect": "Inspect",
    "view.Network": "Network",
    "inspect.tabs": "Inspect tabs",
    "inspect.tab.loop": "Loop",
    "inspect.tab.timeline": "Timeline",
    "inspect.tab.tokens": "Tokens",
    "inspect.tab.raw": "Raw",
    "headline.Activity": "Run activity",
    "headline.Inspect": "Follow the agent run",
    "headline.default": "Inspect traffic",
    "subline.Activity": "Start tools, watch live status, and open recent runs.",
    "subline.Inspect": "Loop, timeline, tokens and raw evidence for the current run.",
    "desc.Activity": "Current run status, launch actions, health, and recent runs.",
    "desc.Inspect": "Loop rail, unified timeline, token attribution, and raw payloads.",
    "desc.Network": "Dense HTTP capture table and request inspector.",
    "quick.All": "All",
    "quick.Model": "Model",
    "quick.Tools": "Tools",
    "quick.MCP": "MCP",
    "quick.Skills": "Skills",
    "quick.Errors": "Errors",
    "focus.All": "All",
    "focus.Attention": "Attention",
    "focus.Hooks": "Hooks",
    "focus.Errors": "Errors",
    "focus.Expensive": "Expensive",
    "focus.Tools": "Tools",
    "empty.noTraffic": "No traffic captured yet",
    "empty.startCapture": "Start a run from the Activity page — click Open Codex or Open Claude.",
    "empty.preview": "Preview mode",
    "empty.previewMessage": "Open the Tauri app to start the proxy and launch native tools.",
    "empty.waiting": "Waiting for traffic",
    "empty.waitingMessage": "Capture is running. Send Claude Code or Codex through the proxy to see flows here.",
    "empty.noFlows": "No flows in this capture",
    "empty.noFlowsMessage": "Choose another capture file or start a fresh session.",
    "empty.startCaptureButton": "Start Capture",
    "empty.nativeReason": "Native actions are available after opening the Tauri app.",
    "native.disabledHint": "Open the Tauri app to use native launchers.",
    "error.title": "Something went wrong",
    "error.details": "Show details",
    "onboarding.path": "Setup → Start Run → Inspect Loop",
    "onboarding.title": "Start your first agent loop",
    "onboarding.body": "LoopLens opens Codex or Claude Code with a fresh capture, then follows the latest loop automatically.",
    "onboarding.finishSetup": "Finish setup",
    "onboarding.setupNeeds": "{count} setup item{plural} need attention.",
    "onboarding.ready": "Environment is ready.",
    "onboarding.openTool": "Open a tool",
    "onboarding.openToolBody": "Opening a tool starts proxy capture and creates a new run.",
    "onboarding.sendPrompt": "Send a prompt",
    "onboarding.sendPromptBody": "Ask the agent to use tools, MCP, files, or skills.",
    "onboarding.watchLoop": "Watch the loop",
    "onboarding.liveRunning": "Live capture is running.",
    "onboarding.followAfterLaunch": "LoopLens will follow the latest run after launch.",
    "onboarding.nativeDisabled": "Native launch actions are disabled in browser preview.",
    "activity.title": "Activity",
    "activity.subtitle": "Start a fresh run, watch status, then inspect the loop.",
    "activity.launch": "Start Run",
    "activity.status": "Status",
    "activity.overview": "Overview",
    "activity.recentRuns": "Recent Runs",
    "activity.noRun": "No current run",
    "activity.currentRun": "Current Run",
    "activity.loopSteps": "Loop Steps",
    "activity.toolsMcp": "Tools / MCP",
    "activity.tokens": "Tokens",
    "activity.network": "Network Evidence",
    "activity.warnings": "Warnings",
    "activity.proxy": "Proxy",
    "activity.gateway": "Gateway",
    "activity.hooks": "Hooks",
    "activity.health": "Health",
    "activity.openSettings": "Open Settings",
    "activity.copyOpenAI": "Copy OpenAI env",
    "activity.copyAnthropic": "Copy Anthropic env",
    "activity.turns": "{count} turns",
    "activity.hooksCount": "{count} hooks",
    "activity.usageFlows": "{count} usage flows",
    "activity.errorsCount": "{count} errors",
    "setup.title": "First run path",
    "setup.subtitle": "Start with official hooks for structured loop data. Add proxy capture only when you need network evidence.",
    "setup.dismiss": "Hide checklist",
    "setup.doneAll": "All set — hide this",
    "setup.stepProxy": "Start the HTTPS proxy",
    "setup.stepProxyDetail": "LoopLens records traffic into the current run file.",
    "setup.stepCa": "Trust the LoopLens CA",
    "setup.stepCaDetail": "Required for decrypting HTTPS without fake errors.",
    "setup.stepTraffic": "Send traffic through the proxy",
    "setup.stepTrafficDetail": "Use Open Codex / Claude here, or point your tool at the listen address.",
    "setup.stepHooks": "Enable structured Hooks",
    "setup.stepHooksDetail": "Recommended first: records prompts, tools, permissions, compact, stop, and Codex events without trusting a CA.",
    "setup.stepLaunch": "Open Codex or Claude Code",
    "setup.stepLaunchDetail": "LoopLens creates a fresh source-specific run file and replaces the current run.",
    "setup.stepPrompt": "Send a prompt, then inspect Loop",
    "setup.stepPromptDetail": "Once a prompt or hook event arrives, the run becomes debuggable.",
    "setup.enableHooks": "Enable Hooks",
    "setup.openAiLoop": "Open Loop",
    "setup.advancedTitle": "Advanced network evidence",
    "setup.advancedDetail": "Use Proxy + CA only when you need full HTTPS request/response evidence. Hooks and Gateway are lower-friction ways to start.",
    "setup.privacyTitle": "Local data boundary",
    "setup.privacyDetail": "Hooks, local capture files, gateway settings, and masked keys stay on this Mac. Clear old runs from Recent Runs or export only when you choose.",
    "setup.methodHooks": "Hooks",
    "setup.methodHooksDetail": "Best for agent loop accuracy.",
    "setup.methodGateway": "Gateway",
    "setup.methodGatewayDetail": "Best for API clients you can configure.",
    "setup.methodProxy": "Proxy",
    "setup.methodProxyDetail": "Best for complete network evidence.",
    "setup.startProxy": "Start proxy",
    "setup.openTrust": "Open Trust",
    "setup.openProxySettings": "Proxy settings",
    "setup.copyListen": "Copy listen address",
    "setup.hookHint": "Recommended: enable Hooks before your first prompt. Proxy/CA can wait until you need HTTPS evidence.",
    "setup.previewBanner": "Preview build — native capture, proxy, and hooks need the packaged LoopLens app.",
    "setup.previewDismiss": "Dismiss",
    "setup.emptyStateHint": "New here? Switch to Activity for the setup checklist.",
    "setup.statusDone": "Done",
    "setup.statusTodo": "To do",
    "setup.allStepsDoneSummary": "Hooks are ready and this run has captured loop activity.",
    "setup.expandSteps": "Show steps",
    "setup.activityChecklistHint": "First run setup: enable Hooks and start a fresh run from Activity first.",
    "story.title": "Run Story",
    "story.waitingTitle": "Waiting for loop evidence",
    "story.waitingBody": "Open Codex or Claude Code, send a prompt, then LoopLens will turn events into a debuggable run.",
    "story.cleanTitle": "Run looks coherent",
    "story.cleanBody": "{turns} turns and {steps} steps are correlated. Use Network only when you need raw evidence.",
    "story.errorTitle": "Start with the failed step",
    "story.errorBody": "{count} error step{plural} found. Inspect the highlighted step before reading raw logs.",
    "story.rateLimitTitle": "Rate limit changed the path",
    "story.rateLimitBody": "{count} rate-limit event{plural} detected. Check retry and wait behavior.",
    "story.unmatchedTitle": "Correlation needs review",
    "story.unmatchedBody": "{count} unmatched step{plural} remain. Open Raw or Network before drawing conclusions.",
    "story.expensiveTitle": "Token spike found",
    "story.expensiveBody": "The largest token step used {tokens}. Review input context before optimizing tools.",
    "story.focus": "Focus step",
    "story.noAction": "No urgent step",
    "story.turns": "Turns",
    "story.steps": "Steps",
    "story.tokens": "Tokens",
    "story.evidence": "Evidence",
    "story.evidenceValue": "{hooks} hooks · {network} flows",
  },
  zh: {
    "app.tagline": "AI Agent 循环的可视化调试器",
    "sidebar.subtitle": "Agent Loop 工作台",
    "sidebar.sectionViews": "工作区",
    "settings.title": "设置",
    "settings.open": "打开设置",
    "settings.close": "关闭设置",
    "settings.subtitle": "网关、Hooks、显示",
    "settings.backToApp": "返回应用",
    "settings.general": "常规",
    "settings.categoryGeneral": "常规",
    "settings.categoryAppearance": "外观",
    "settings.categoryGateway": "网关",
    "settings.categoryProxy": "代理",
    "settings.categoryHooks": "Hooks",
    "settings.categoryTrust": "信任",
    "settings.categoryDiagnostics": "诊断",
    "settings.diagnostics": "诊断信息",
    "settings.readOnly": "只读",
    "settings.desc.general": "抓包与 Loop 查看时的核心默认行为。",
    "settings.desc.appearance": "主题和产品语言。",
    "settings.desc.gateway": "本地 OpenAI/Anthropic 兼容网关。",
    "settings.desc.proxy": "HTTPS 代理和 raw capture 行为。",
    "settings.desc.hooks": "Claude Code 和 Codex 的官方结构化事件。",
    "settings.desc.trust": "Native App、CA 和二进制可用性。",
    "settings.desc.diagnostics": "只读路径和本地存储策略。",
    "settings.display": "显示",
    "settings.theme": "主题",
    "settings.themeDetail": "即时切换工作台配色",
    "settings.language": "语言",
    "settings.languageDetail": "应用到核心产品界面",
    "settings.theme.dark": "深色",
    "settings.theme.light": "浅色",
    "settings.language.en": "English",
    "settings.language.zh": "中文",
    "settings.runDefaults": "运行默认值",
    "settings.livePolling": "实时轮询",
    "settings.livePollingDetail": "每 1 秒刷新 capture",
    "settings.followLatest": "跟随最新",
    "settings.followLatestDetail": "自动选中最新 step",
    "settings.hideNoise": "隐藏网络噪声",
    "settings.hideNoiseDetail": "CONNECT、registry、telemetry",
    "settings.gateway": "网关",
    "settings.status": "状态",
    "settings.listen": "监听地址",
    "settings.openaiKey": "OpenAI Key",
    "settings.openaiUrl": "OpenAI URL",
    "settings.anthropicKey": "Anthropic Key",
    "settings.anthropicUrl": "Anthropic URL",
    "settings.maxRetries": "最大重试",
    "settings.redaction": "脱敏",
    "settings.redactionDetail": "API Key 永不写入 capture 文件",
    "settings.copy": "复制",
    "settings.save": "保存",
    "settings.stop": "停止",
    "settings.start": "启动",
    "settings.testOpenAI": "测试 OpenAI",
    "settings.testAnthropic": "测试 Anthropic",
    "settings.clearOpenAI": "清空 OpenAI Key",
    "settings.clearAnthropic": "清空 Anthropic Key",
    "settings.proxyCapture": "代理与抓包",
    "settings.listenAddress": "监听地址",
    "settings.bodyLimit": "Body 限制",
    "settings.captureAll": "捕获全部流量",
    "settings.captureAllDetail": "完整保留 raw JSONL",
    "settings.proxy": "代理",
    "settings.hooks": "Hooks",
    "settings.receiver": "接收器",
    "settings.capturedEvents": "已捕获事件",
    "settings.enable": "启用",
    "settings.test": "测试",
    "settings.remove": "移除",
    "settings.trustEnvironment": "信任与环境",
    "settings.nativeApp": "Native App",
    "settings.proxyBinary": "代理二进制",
    "settings.caFiles": "CA 文件",
    "settings.caTrust": "CA 信任",
    "settings.generateCA": "生成 CA",
    "settings.trustCA": "信任 CA",
    "settings.dataPrivacy": "数据与隐私",
    "settings.storage": "存储",
    "settings.rawCapture": "Raw capture",
    "settings.gatewayKeys": "Gateway Keys",
    "settings.exportMode": "导出模式",
    "settings.future": "未来",
    "settings.interface": "界面",
    "settings.defaultView": "默认视图",
    "settings.history": "历史",
    "settings.typography": "字体",
    "settings.paths": "路径",
    "settings.project": "项目",
    "settings.captures": "Captures",
    "settings.hookEvents": "Hook 事件",
    "settings.gatewaySettings": "网关设置",
    "value.running": "运行中",
    "value.stopped": "已停止",
    "value.external": "外部进程",
    "value.enabled": "已启用",
    "value.preview": "预览",
    "value.ready": "就绪",
    "value.missing": "缺失",
    "value.generated": "已生成",
    "value.trusted": "已信任",
    "value.notTrusted": "未信任",
    "value.installed": "已安装",
    "value.notInstalled": "未安装",
    "value.offline": "离线",
    "value.localOnly": "仅本地",
    "value.retained": "完整保留",
    "value.localMasked": "本地脱敏",
    "value.manual": "手动",
    "value.redactedBundle": "脱敏调试包",
    "value.collapsed": "默认折叠",
    "value.systemMono": "系统字体 + 等宽",
    "value.densityThemeFont": "密度、主题、字号",
    "run.openCodex": "打开 Codex",
    "run.openClaude": "打开 Claude Code",
    "run.idle": "空闲",
    "run.live": "实时",
    "run.current": "当前 Run",
    "run.refresh": "刷新",
    "run.clear": "清空",
    "run.confirm": "确认",
    "run.clearing": "清空中...",
    "run.cleared": "已清空 {count}",
    "run.nothingToClear": "没有可清空内容",
    "run.noPrevious": "暂无历史 run。",
    "run.exportLoop": "导出 Loop",
    "hooks.title": "结构化 Hooks",
    "hooks.receiverLive": "接收器在线",
    "hooks.receiverOffline": "接收器离线",
    "hooks.events": "{count} 个事件",
    "hooks.enabled": "已启用",
    "hooks.setup": "待设置",
    "hooks.httpHooks": "HTTP hooks",
    "hooks.commandHooks": "命令 hooks",
    "hooks.notInstalled": "未安装",
    "toolbar.title": "Inspect 工作台",
    "toolbar.liveReview": "实时 capture 审查",
    "toolbar.paused": "Capture 已暂停",
    "toolbar.searchPlaceholder": "搜索 URL、host、provider、method、status",
    "toolbar.searchFlows": "搜索 flows",
    "toolbar.mainViews": "主视图",
    "toolbar.quickFilters": "快捷筛选",
    "toolbar.loopFocus": "Loop 关注点",
    "toolbar.categoryFilter": "分类筛选",
    "toolbar.statusFilter": "状态筛选",
    "toolbar.visibleFlows": "显示 {shown}/{total} 个 flows",
    "toolbar.live": "实时",
    "toolbar.followLatest": "跟随最新",
    "toolbar.hideNoise": "隐藏噪声",
    "toolbar.noFile": "未选择文件",
    "runbar.label": "运行控制",
    "runbar.proxy": "代理",
    "runbar.gateway": "Gateway",
    "runbar.run": "运行",
    "runbar.start": "启动",
    "runbar.stop": "停止",
    "runbar.startProxy": "启动代理",
    "runbar.stopProxy": "停止代理",
    "view.Activity": "活动",
    "view.Inspect": "Inspect",
    "view.Network": "网络",
    "inspect.tabs": "Inspect 子标签",
    "inspect.tab.loop": "Loop",
    "inspect.tab.timeline": "时间线",
    "inspect.tab.tokens": "Token",
    "inspect.tab.raw": "Raw",
    "headline.Activity": "当前运行状态",
    "headline.Inspect": "看懂这次 Agent Run",
    "headline.default": "检查流量",
    "subline.Activity": "启动工具、观察实时状态、打开最近的 run。",
    "subline.Inspect": "在 Loop、时间线、Token 和 Raw 之间切换查看当前 run 的全部证据。",
    "desc.Activity": "当前 run 状态、启动入口、健康状态和最近运行。",
    "desc.Inspect": "Loop 轨道、统一时间线、Token 归因和 Raw payload。",
    "desc.Network": "密集 HTTP capture 表格与 request inspector。",
    "quick.All": "全部",
    "quick.Model": "模型",
    "quick.Tools": "工具",
    "quick.MCP": "MCP",
    "quick.Skills": "Skills",
    "quick.Errors": "错误",
    "focus.All": "全部",
    "focus.Attention": "关注",
    "focus.Hooks": "Hooks",
    "focus.Errors": "错误",
    "focus.Expensive": "高消耗",
    "focus.Tools": "工具",
    "empty.noTraffic": "还没有捕获到流量",
    "empty.startCapture": "前往 Activity 页，点击 Open Codex 或 Open Claude 启动一次 run。",
    "empty.preview": "预览模式",
    "empty.previewMessage": "打开 Tauri App 后才能启动代理和 native 工具。",
    "empty.waiting": "等待流量",
    "empty.waitingMessage": "Capture 正在运行。让 Claude Code 或 Codex 通过代理后，这里会出现 flows。",
    "empty.noFlows": "这个 capture 里没有 flows",
    "empty.noFlowsMessage": "选择其他 capture 文件，或开始新的 session。",
    "empty.startCaptureButton": "启动 Capture",
    "empty.nativeReason": "Native 操作需要在 Tauri App 中使用。",
    "native.disabledHint": "在 Tauri App 中才能使用 native 启动器。",
    "error.title": "出错了",
    "error.details": "查看详情",
    "onboarding.path": "设置 → 开始 Run → 检查 Loop",
    "onboarding.title": "开始第一个 Agent Loop",
    "onboarding.body": "LoopLens 会用全新的 capture 打开 Codex 或 Claude Code，并自动跟随最新 loop。",
    "onboarding.finishSetup": "完成设置",
    "onboarding.setupNeeds": "{count} 个设置项需要处理。",
    "onboarding.ready": "环境已就绪。",
    "onboarding.openTool": "打开工具",
    "onboarding.openToolBody": "打开工具会启动代理抓包，并创建新的 run。",
    "onboarding.sendPrompt": "发送 prompt",
    "onboarding.sendPromptBody": "让 agent 使用工具、MCP、文件或 skills。",
    "onboarding.watchLoop": "观察 loop",
    "onboarding.liveRunning": "Live capture 正在运行。",
    "onboarding.followAfterLaunch": "LoopLens 会在启动后跟随最新 run。",
    "onboarding.nativeDisabled": "浏览器预览中无法使用 native 启动操作。",
    "activity.title": "活动",
    "activity.subtitle": "启动新的 run，观察状态，然后进入 loop 调试。",
    "activity.launch": "开始 Run",
    "activity.status": "状态",
    "activity.overview": "总览",
    "activity.recentRuns": "最近 Runs",
    "activity.noRun": "暂无当前 run",
    "activity.currentRun": "当前 Run",
    "activity.loopSteps": "Loop 步骤",
    "activity.toolsMcp": "工具 / MCP",
    "activity.tokens": "Token",
    "activity.network": "网络证据",
    "activity.warnings": "警告",
    "activity.proxy": "代理",
    "activity.gateway": "Gateway",
    "activity.hooks": "Hooks",
    "activity.health": "健康",
    "activity.openSettings": "打开设置",
    "activity.copyOpenAI": "复制 OpenAI 环境变量",
    "activity.copyAnthropic": "复制 Anthropic 环境变量",
    "activity.turns": "{count} 轮",
    "activity.hooksCount": "{count} 个 hooks",
    "activity.usageFlows": "{count} 个 usage flow",
    "activity.errorsCount": "{count} 个错误",
    "setup.title": "第一次 Run 路径",
    "setup.subtitle": "先用官方 Hooks 拿到结构化 loop 数据；只有需要网络证据时，再启用 Proxy 抓包。",
    "setup.dismiss": "隐藏清单",
    "setup.doneAll": "已完成 — 隐藏",
    "setup.stepProxy": "启动 HTTPS 代理",
    "setup.stepProxyDetail": "LoopLens 会把流量写入当前 Run 的 capture 文件。",
    "setup.stepCa": "信任 LoopLens 根证书",
    "setup.stepCaDetail": "不解密 HTTPS 会看到大量失败或空白流量。",
    "setup.stepTraffic": "让流量走代理",
    "setup.stepTrafficDetail": "在此启动 Codex / Claude，或在工具里把代理指向监听地址。",
    "setup.stepHooks": "启用结构化 Hooks",
    "setup.stepHooksDetail": "推荐第一步：无需信任 CA，就能记录 prompt、工具、权限、compact、stop 和 Codex 事件。",
    "setup.stepLaunch": "打开 Codex 或 Claude Code",
    "setup.stepLaunchDetail": "LoopLens 会创建新的、按来源区分的 run 文件，并替换当前 run。",
    "setup.stepPrompt": "发送 prompt，然后查看 Loop",
    "setup.stepPromptDetail": "只要 prompt 或 hook event 到达，这次 run 就可以开始调试。",
    "setup.enableHooks": "启用 Hooks",
    "setup.openAiLoop": "打开 Loop",
    "setup.advancedTitle": "高级网络证据",
    "setup.advancedDetail": "只有需要完整 HTTPS request/response 证据时再使用 Proxy + CA。Hooks 和 Gateway 更适合作为低摩擦起点。",
    "setup.privacyTitle": "本地数据边界",
    "setup.privacyDetail": "Hooks、本地 capture 文件、Gateway 设置和脱敏后的 key 都保存在这台 Mac。旧 run 可在「最近 Runs」清理，导出只在你主动操作时发生。",
    "setup.methodHooks": "Hooks",
    "setup.methodHooksDetail": "最适合提高 agent loop 准确度。",
    "setup.methodGateway": "Gateway",
    "setup.methodGatewayDetail": "最适合可配置 API endpoint 的客户端。",
    "setup.methodProxy": "Proxy",
    "setup.methodProxyDetail": "最适合完整网络证据。",
    "setup.startProxy": "启动代理",
    "setup.openTrust": "打开信任",
    "setup.openProxySettings": "代理设置",
    "setup.copyListen": "复制监听地址",
    "setup.hookHint": "推荐：第一次 prompt 前先启用 Hooks。Proxy/CA 可以等需要 HTTPS 证据时再处理。",
    "setup.previewBanner": "当前为预览模式 — 完整抓包、代理与 Hooks 需使用已安装的 LoopLens 桌面应用。",
    "setup.previewDismiss": "不再显示",
    "setup.emptyStateHint": "第一次使用？切换到「活动」查看设置清单。",
    "setup.statusDone": "已完成",
    "setup.statusTodo": "待完成",
    "setup.allStepsDoneSummary": "Hooks 已就绪，并且当前 run 已捕获到 loop 活动。",
    "setup.expandSteps": "展开步骤",
    "setup.activityChecklistHint": "首次 Run 设置：请先在「活动」页启用 Hooks 并启动一个新 run。",
    "story.title": "Run 摘要",
    "story.waitingTitle": "等待 Loop 证据",
    "story.waitingBody": "打开 Codex 或 Claude Code，发送一个 prompt 后，LoopLens 会把事件整理成可调试的 run。",
    "story.cleanTitle": "Run 看起来连贯",
    "story.cleanBody": "{turns} 轮、{steps} 个步骤已完成关联。只有需要原始证据时再进入 Network。",
    "story.errorTitle": "先看失败步骤",
    "story.errorBody": "发现 {count} 个错误步骤。先检查高亮步骤，再读 raw 日志。",
    "story.rateLimitTitle": "Rate limit 改变了路径",
    "story.rateLimitBody": "检测到 {count} 个 rate-limit 事件。建议检查 retry 和等待行为。",
    "story.unmatchedTitle": "关联需要复核",
    "story.unmatchedBody": "还有 {count} 个未匹配步骤。下结论前先看 Raw 或 Network。",
    "story.expensiveTitle": "发现 Token 高点",
    "story.expensiveBody": "最大 token 步骤使用了 {tokens}。优化工具前，先检查输入上下文。",
    "story.focus": "定位步骤",
    "story.noAction": "暂无紧急步骤",
    "story.turns": "轮次",
    "story.steps": "步骤",
    "story.tokens": "Token",
    "story.evidence": "证据",
    "story.evidenceValue": "{hooks} hooks · {network} flows",
  },
};

const I18nContext = createContext({
  language: "en",
  t: (key: string, values?: AnyRecord) => formatTranslation(key, values),
});

function readStoredChoice(key: string, choices: string[], fallback: string) {
  if (typeof window === "undefined") return fallback;
  const stored = window.localStorage.getItem(key);
  return stored && choices.includes(stored) ? stored : fallback;
}

function defaultLanguage() {
  if (typeof navigator !== "undefined" && navigator.language.toLowerCase().startsWith("zh")) {
    return "zh";
  }
  return "en";
}

function formatTranslation(key: string, values: AnyRecord = {}, language = "en") {
  const template = TRANSLATIONS[language]?.[key] ?? TRANSLATIONS.en[key] ?? key;
  return String(template).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? ""));
}

function useI18n() {
  return useContext(I18nContext);
}

function handleWindowDragMouseDown(event) {
  if (!isNativeRuntime()) return;
  if (event.button !== 0) return;
  if (event.detail > 1) return;
  const target = event.target as HTMLElement | null;
  if (target?.closest(WINDOW_DRAG_BLOCK_SELECTOR)) return;
  getCurrentWindow().startDragging().catch(() => {});
}

export default function App() {
  const native = isNativeRuntime();
  const [theme, setTheme] = useState(() => readStoredChoice(THEME_STORAGE_KEY, THEMES, "dark"));
  const [language, setLanguage] = useState(() => readStoredChoice(LANGUAGE_STORAGE_KEY, LANGUAGES, defaultLanguage()));
  const [appInfo, setAppInfo] = useState(null);
  const [proxyStatus, setProxyStatus] = useState(null);
  const [gatewayStatus, setGatewayStatus] = useState(null);
  const [gatewaySettings, setGatewaySettings] = useState(null);
  const [environment, setEnvironment] = useState(null);
  const [files, setFiles] = useState([]);
  const [captureIndex, setCaptureIndex] = useState(EMPTY_CAPTURE_INDEX);
  const [captureHealth, setCaptureHealth] = useState(null);
  const [claudeSessionIndex, setClaudeSessionIndex] = useState({
    project_dir: "",
    storage_dir: "",
    sessions: [],
    latest_session_id: null,
  });
  const [claudeSessionDetail, setClaudeSessionDetail] = useState(EMPTY_CLAUDE_SESSION_DETAIL);
  const [hookStatus, setHookStatus] = useState(null);
  const [hookEvents, setHookEvents] = useState(EMPTY_HOOK_EVENTS);
  const [activeFile, setActiveFile] = useState(null);
  const [activeFlowId, setActiveFlowId] = useState(null);
  const [flowDetail, setFlowDetail] = useState(null);
  const [activeTab, setActiveTab] = useState("Summary");
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("All");
  const [statusFilter, setStatusFilter] = useState("All");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [hideNoise, setHideNoise] = useState(true);
  const [activeView, setActiveView] = useState("Activity");
  const [activeInspectTab, setActiveInspectTab] = useState("Loop");
  const [loopFocus, setLoopFocus] = useState("All");
  const [compareA, setCompareA] = useState(null);
  const [compareB, setCompareB] = useState(null);
  const [listen, setListen] = useState(DEFAULT_LISTEN);
  const [bodyLimit, setBodyLimit] = useState("0");
  const [captureAll, setCaptureAll] = useState(true);
  const [live, setLive] = useState(true);
  const [followLatest, setFollowLatest] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsInitialSection, setSettingsInitialSection] = useState(null);
  const [booting, setBooting] = useState(true);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState(null);
  const i18n = useMemo(
    () => ({
      language,
      t: (key: string, values?: AnyRecord) => formatTranslation(key, values, language),
    }),
    [language],
  );

  const openSettingsGeneral = useCallback(() => {
    setSettingsInitialSection(null);
    setSettingsOpen(true);
  }, []);

  const openSettingsSection = useCallback((section) => {
    setSettingsInitialSection(section);
    setSettingsOpen(true);
  }, []);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.documentElement.style.colorScheme = theme;
    window.localStorage.setItem(THEME_STORAGE_KEY, theme);
  }, [theme]);

  useEffect(() => {
    document.documentElement.lang = language === "zh" ? "zh-CN" : "en";
    window.localStorage.setItem(LANGUAGE_STORAGE_KEY, language);
  }, [language]);

  const refreshStatus = useCallback(async () => {
    const status = await nativeInvoke("proxy_status");
    setProxyStatus(status);
    return status;
  }, []);

  const refreshGatewayStatus = useCallback(async () => {
    const status = await nativeInvoke("gateway_status");
    setGatewayStatus(status);
    return status;
  }, []);

  const refreshGatewaySettings = useCallback(async () => {
    const settings = await nativeInvoke("read_gateway_settings");
    setGatewaySettings(settings);
    return settings;
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
    if (!fileName) {
      setCaptureIndex(EMPTY_CAPTURE_INDEX);
      setActiveFlowId(null);
      setFlowDetail(null);
      return EMPTY_CAPTURE_INDEX;
    }
    const index = await nativeInvoke("read_capture_index", { name: fileName || null });
    setCaptureIndex(index);
    setActiveFile(index.file?.name || null);
    setActiveFlowId((current) => {
      const ids = new Set((index.flows || []).map((flow) => flow.id));
      if (followLatest && index.last_flow_id) return index.last_flow_id;
      if (current && ids.has(current)) return current;
      return index.last_flow_id || null;
    });
    return index;
  }, [activeFile, followLatest]);

  const refreshCaptureHealth = useCallback(async (fileName = activeFile) => {
    if (!fileName) {
      setCaptureHealth(null);
      return null;
    }
    const health = await nativeInvoke("validate_capture", { name: fileName });
    setCaptureHealth(health);
    return health;
  }, [activeFile]);

  const refreshClaudeSessions = useCallback(async () => {
    const index = await nativeInvoke("read_claude_session_index");
    setClaudeSessionIndex(index);
    const detail = await nativeInvoke("read_claude_session_detail", {
      sessionId: index.latest_session_id || null,
    });
    setClaudeSessionDetail(detail);
    return { index, detail };
  }, []);

  const refreshHooks = useCallback(async () => {
    const [status, events] = await Promise.all([
      nativeInvoke("hook_status"),
      nativeInvoke("read_hook_events", { limit: 500 }),
    ]);
    setHookStatus(status);
    setHookEvents(events);
    return { status, events };
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      setError(null);
      const [info] = await Promise.all([
        nativeInvoke("app_info"),
        refreshStatus(),
        refreshGatewayStatus(),
        refreshGatewaySettings(),
        refreshEnvironment(),
        refreshFiles(),
        refreshClaudeSessions(),
        refreshHooks(),
      ]);
      setAppInfo(info);
      await refreshIndex(activeFile);
    } catch (err) {
      setError(String(err));
    } finally {
      setBooting(false);
    }
  }, [activeFile, refreshClaudeSessions, refreshEnvironment, refreshFiles, refreshGatewaySettings, refreshGatewayStatus, refreshHooks, refreshIndex, refreshStatus]);

  useEffect(() => {
    bootstrap();
  }, []);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      refreshStatus().catch(() => {});
      refreshGatewayStatus().catch(() => {});
      refreshFiles().catch(() => {});
      refreshIndex(activeFile).catch(() => {});
      refreshCaptureHealth(activeFile).catch(() => {});
    }, 1000);
    return () => clearInterval(id);
  }, [activeFile, live, refreshCaptureHealth, refreshFiles, refreshGatewayStatus, refreshIndex, refreshStatus]);

  useEffect(() => {
    if (!live) return undefined;
    const id = setInterval(() => {
      refreshClaudeSessions().catch(() => {});
      refreshHooks().catch(() => {});
    }, 3000);
    return () => clearInterval(id);
  }, [live, refreshClaudeSessions, refreshHooks]);

  const selectedFlow = useMemo(
    () => captureIndex.flows.find((flow) => flow.id === activeFlowId) || null,
    [activeFlowId, captureIndex.flows],
  );

  useEffect(() => {
    if (!activeFile || !activeFlowId) {
      setFlowDetail(null);
      return;
    }
    const indexBelongsToActiveFile = !captureIndex.file?.name || captureIndex.file.name === activeFile;
    if (indexBelongsToActiveFile && captureIndex.flows.length > 0 && !selectedFlow) {
      setFlowDetail(null);
      setActiveFlowId(followLatest ? captureIndex.last_flow_id || null : null);
      return;
    }
    let cancelled = false;
    nativeInvoke("read_flow_detail", { name: activeFile, flowId: activeFlowId })
      .then((detail) => {
        if (!cancelled) setFlowDetail(detail);
      })
      .catch((err) => {
        if (cancelled) return;
        const message = String(err);
        if (message.includes("flow not found")) {
          setFlowDetail(null);
          setActiveFlowId((current) => current === activeFlowId
            ? followLatest ? captureIndex.last_flow_id || null : null
            : current);
          return;
        }
        setError(message);
      });
    return () => {
      cancelled = true;
    };
  }, [
    activeFile,
    activeFlowId,
    captureIndex.file?.name,
    captureIndex.flows.length,
    captureIndex.last_flow_id,
    followLatest,
    selectedFlow?.id,
    selectedFlow?.updated_at,
  ]);

  useEffect(() => {
    refreshCaptureHealth(activeFile).catch((err) => setError(String(err)));
  }, [activeFile, captureIndex.file?.modified, refreshCaptureHealth]);

  const sourceScopedFlows = useMemo(
    () => captureIndex.flows.filter((flow) => sourceMatches(flow, sourceFilter)),
    [captureIndex.flows, sourceFilter],
  );
  const scopedClaudeSessionDetail = useMemo(
    () => scopeClaudeSessionForRun(claudeSessionDetail, activeFile),
    [activeFile, claudeSessionDetail],
  );
  const scopedHookEvents = useMemo(
    () => filterHookEventsForRun(hookEvents, activeFile, files),
    [activeFile, files, hookEvents],
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
      return !needle || structuredFlowSearch(flow, query);
    });
  }, [categoryFilter, hideNoise, query, sourceScopedFlows, statusFilter]);

  const analytics = useMemo(() => computeAnalytics(sourceScopedFlows), [sourceScopedFlows]);
  const activeRunLoopSummary = useMemo(
    () => buildAgentLoopModel({ flows: sourceScopedFlows, claudeSessionDetail: scopedClaudeSessionDetail, sourceFilter, hookEvents: scopedHookEvents.events }),
    [scopedClaudeSessionDetail, scopedHookEvents.events, sourceFilter, sourceScopedFlows],
  );
  const clientStats = useMemo(() => computeClientStats(captureIndex.flows), [captureIndex.flows]);
  const categories = useMemo(() => ["All", ...analytics.categories.map((item) => item.name)], [analytics]);
  const compareFlowA = sourceScopedFlows.find((flow) => flow.id === compareA) || null;
  const compareFlowB = sourceScopedFlows.find((flow) => flow.id === compareB) || null;

  async function startProxy() {
    setBusy("proxy");
    try {
      setError(null);
      const started = await nativeInvoke("start_proxy", { listen, bodyLimit, captureAll });
      setProxyStatus(started);
      const captureName = started?.capture_file || activeFile;
      await Promise.all([refreshStatus(), refreshEnvironment(), refreshFiles()]);
      if (captureName) {
        setActiveFile(captureName);
        await refreshIndex(captureName);
        await refreshCaptureHealth(captureName);
      } else {
        await refreshIndex(null);
        setCaptureHealth(null);
      }
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

  async function saveGatewaySettings(settings) {
    setBusy("gateway-settings");
    try {
      setError(null);
      const next = await nativeInvoke("save_gateway_settings", { settings });
      setGatewaySettings(next);
      return next;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function startGateway(settings) {
    setBusy("gateway");
    try {
      setError(null);
      const status = await nativeInvoke("start_gateway", {
        settings: settings || null,
        forceNewCapture: true,
      });
      setGatewayStatus(status);
      const captureName = status?.capture_file;
      const [nextFiles, nextSettings] = await Promise.all([
        refreshFiles(),
        refreshGatewaySettings(),
      ]);
      setFiles(nextFiles);
      if (captureName) {
        const index = await nativeInvoke("read_capture_index", { name: captureName });
        setCaptureIndex(index);
        setActiveFile(captureName);
        await refreshCaptureHealth(captureName);
        setActiveFlowId(index.last_flow_id || null);
        setFlowDetail(null);
      }
      setGatewaySettings(nextSettings);
      setLive(true);
      setFollowLatest(true);
      setActiveView("Network");
      return status;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function stopGateway() {
    setBusy("gateway");
    try {
      setError(null);
      const status = await nativeInvoke("stop_gateway");
      setGatewayStatus(status);
      return status;
    } catch (err) {
      setError(String(err));
      return null;
    } finally {
      setBusy(null);
    }
  }

  async function testGatewayProvider(provider) {
    setBusy(`gateway-test-${provider}`);
    try {
      setError(null);
      return await nativeInvoke("test_gateway_provider", { provider });
    } catch (err) {
      setError(String(err));
      return null;
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
      const started = await nativeInvoke("start_proxy", {
        listen,
        bodyLimit,
        captureAll,
        forceNewCapture: true,
        captureSource: tool,
      });
      const captureName = started?.capture_file;
      if (!captureName) {
        throw new Error("Fresh capture was not created. Stop the existing proxy and try again.");
      }
      setProxyStatus(started);
      setActiveFile(captureName);
      setCaptureIndex({ file: { name: captureName, size: 0, modified: null }, flows: [], last_flow_id: null });
      setCaptureHealth(null);
      setActiveFlowId(null);
      setFlowDetail(null);
      setSourceFilter("all");
      setLive(true);
      setFollowLatest(true);
      setActiveView("Inspect");
      setActiveInspectTab("Loop");
      await nativeInvoke("open_tool", { tool, listen: started?.listen || listen });
      const [status, nextFiles, index] = await Promise.all([
        refreshStatus(),
        refreshFiles(),
        nativeInvoke("read_capture_index", { name: captureName }),
      ]);
      setProxyStatus(status);
      setFiles(nextFiles);
      setCaptureIndex(index);
      setActiveFile(captureName);
      await refreshCaptureHealth(captureName);
      setActiveFlowId(index.last_flow_id || null);
      setFlowDetail(null);
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function clearHistory() {
    const keepName = activeFile || captureIndex.file?.name || null;
    setBusy("clear-history");
    try {
      setError(null);
      const removed = await nativeInvoke("clear_capture_history", { keepName });
      const nextFiles = await refreshFiles();
      const nextActive = keepName && nextFiles.some((file) => file.name === keepName)
        ? keepName
        : null;
      setActiveFile(nextActive);
      setFlowDetail(null);
      if (nextActive) {
        await refreshIndex(nextActive);
        await refreshCaptureHealth(nextActive);
      } else {
        await refreshIndex(null);
        setCaptureHealth(null);
      }
      return removed;
    } catch (err) {
      setError(String(err));
      throw err;
    } finally {
      setBusy(null);
    }
  }

  async function installHooks(target = "all") {
    setBusy(`install-hooks-${target}`);
    try {
      setError(null);
      await nativeInvoke("install_hooks", { target });
      await refreshHooks();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function removeHooks(target = "all") {
    setBusy(`remove-hooks-${target}`);
    try {
      setError(null);
      await nativeInvoke("remove_hooks", { target });
      await refreshHooks();
    } catch (err) {
      setError(String(err));
    } finally {
      setBusy(null);
    }
  }

  async function testHooks(target = "all") {
    setBusy(`test-hooks-${target}`);
    try {
      setError(null);
      await nativeInvoke("test_hooks", { target });
      await refreshHooks();
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

  // Global keyboard shortcuts
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      const mod = event.metaKey || event.ctrlKey;
      const target = event.target as HTMLElement;
      const isInput = target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.isContentEditable;

      // ⌘K / Ctrl+K → focus search
      if (mod && event.key === "k") {
        event.preventDefault();
        const searchInput = document.querySelector<HTMLInputElement>(".toolbar input[type='search'], .toolbar input[type='text']");
        searchInput?.focus();
        return;
      }

      // ⌘, → open settings
      if (mod && event.key === ",") {
        event.preventDefault();
        openSettingsGeneral();
        return;
      }

      // Don't capture keys when typing in inputs
      if (isInput) return;

      // ⌘1-3 → switch top-level views
      if (mod && event.key >= "1" && event.key <= "3") {
        event.preventDefault();
        const viewMap = { "1": "Activity", "2": "Inspect", "3": "Network" };
        const view = viewMap[event.key];
        if (view) setActiveView(view);
        return;
      }
      // ⌘4-7 → switch Inspect sub-tabs (and ensure Inspect view is active)
      if (mod && event.key >= "4" && event.key <= "7") {
        event.preventDefault();
        const tabMap = { "4": "Loop", "5": "Timeline", "6": "Tokens", "7": "Raw" };
        const tab = tabMap[event.key];
        if (tab) {
          setActiveView("Inspect");
          setActiveInspectTab(tab);
        }
        return;
      }

      // Space → toggle live capture
      if (event.key === " " && !isInput) {
        event.preventDefault();
        setLive((prev) => !prev);
        return;
      }

      // Arrow keys → navigate flows
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && filteredFlows.length > 0) {
        event.preventDefault();
        const currentIndex = filteredFlows.findIndex((flow) => flow.id === activeFlowId);
        const nextIndex = event.key === "ArrowDown"
          ? Math.min(currentIndex + 1, filteredFlows.length - 1)
          : Math.max(currentIndex - 1, 0);
        const nextFlow = filteredFlows[nextIndex];
        if (nextFlow) selectFlow(nextFlow.id);
        return;
      }

      // Escape → close settings
      if (event.key === "Escape") {
        setSettingsOpen(false);
        setSettingsInitialSection(null);
        return;
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeFlowId, filteredFlows, settingsOpen, openSettingsGeneral]);

  return (
    <I18nContext.Provider value={i18n}>
    <Tooltip.Provider delayDuration={250} skipDelayDuration={100}>
      <div className={`app ${native ? "native" : "preview"} theme-${theme} lang-${language}`}>
      {native && <div className="window-drag-region" data-tauri-drag-region />}
      <LaunchScreen visible={booting} />
      <Sidebar
        appInfo={appInfo}
        activeView={activeView}
        onActiveViewChange={setActiveView}
        onOpenSettings={openSettingsGeneral}
      />

      <main className="workspace">
        <RunBar
          native={native}
          proxyStatus={proxyStatus}
          gatewayStatus={gatewayStatus}
          listen={listen}
          busy={busy}
          file={captureIndex.file}
          onStartProxy={startProxy}
          onStopProxy={stopProxy}
          onOpenSettings={openSettingsGeneral}
        />
        <Toolbar
          native={native}
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
          inspectTab={activeInspectTab}
          onActiveViewChange={setActiveView}
          categories={categories}
          categoryFilter={categoryFilter}
          onCategoryFilterChange={setCategoryFilter}
          statusFilter={statusFilter}
          onStatusFilterChange={setStatusFilter}
          hideNoise={hideNoise}
          onHideNoiseChange={setHideNoise}
          loopFocus={loopFocus}
          onLoopFocusChange={setLoopFocus}
        />

        {error && (
          <div className="error-banner" role="alert">
            <strong>{i18n.t("error.title")}</strong>
            <details>
              <summary>{i18n.t("error.details")}</summary>
              <code>{error}</code>
            </details>
          </div>
        )}

        {activeView === "Network" && <SessionStrip analytics={analytics} />}

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
              captureHealth={captureHealth}
              onViewInLoop={() => {
                setActiveView("Inspect");
                setActiveInspectTab("Loop");
              }}
              onSetCompareA={() => selectedFlow && setCompareA(selectedFlow.id)}
              onSetCompareB={() => selectedFlow && setCompareB(selectedFlow.id)}
            />
          </div>
        ) : (
          <AnalysisView
            view={activeView}
            inspectTab={activeInspectTab}
            onInspectTabChange={setActiveInspectTab}
            flows={sourceScopedFlows}
            filteredFlows={filteredFlows}
            sourceFilter={sourceFilter}
            analytics={analytics}
            compareA={compareFlowA}
            compareB={compareFlowB}
            file={captureIndex.file}
            captureHealth={captureHealth}
            claudeSessionIndex={claudeSessionIndex}
            claudeSessionDetail={scopedClaudeSessionDetail}
            hookEvents={scopedHookEvents}
            files={files}
            activeFile={activeFile}
            clientStats={clientStats}
            activeFlowCount={sourceScopedFlows.length}
            activeLoopSteps={activeRunLoopSummary.totals.steps}
            activeRunLoopSummary={activeRunLoopSummary}
            listen={listen}
            native={native}
            environment={environment}
            proxyStatus={proxyStatus}
            gatewayStatus={gatewayStatus}
            hookStatus={hookStatus}
            busy={busy}
            loopFocus={loopFocus}
            followLatest={followLatest}
            onOpenTool={openTool}
            onStartProxy={startProxy}
            onStopProxy={stopProxy}
            onRefreshFiles={() => refreshFiles().then(() => refreshIndex(activeFile))}
            onClearHistory={clearHistory}
            onSelectFile={selectFile}
            onSourceFilterChange={setSourceFilter}
            onRunHelper={runHelper}
            onOpenSettings={openSettingsGeneral}
            onOpenSettingsSection={openSettingsSection}
            onOpenNetworkFlow={(flowId) => {
              setActiveFlowId(flowId);
              setActiveTab("Summary");
              setActiveView("Network");
            }}
          />
        )}
      </main>

      <SettingsPanel
        open={settingsOpen}
        onClose={() => {
          setSettingsOpen(false);
          setSettingsInitialSection(null);
        }}
        initialSection={settingsInitialSection}
        onInitialSectionConsumed={() => setSettingsInitialSection(null)}
        native={native}
        appInfo={appInfo}
        proxyStatus={proxyStatus}
        gatewayStatus={gatewayStatus}
        gatewaySettings={gatewaySettings}
        environment={environment}
        hookStatus={hookStatus}
        hookEvents={hookEvents}
        listen={listen}
        bodyLimit={bodyLimit}
        captureAll={captureAll}
        live={live}
        followLatest={followLatest}
        hideNoise={hideNoise}
        theme={theme}
        language={language}
        onListenChange={setListen}
        onBodyLimitChange={setBodyLimit}
        onCaptureAllChange={setCaptureAll}
        onLiveChange={setLive}
        onFollowLatestChange={setFollowLatest}
        onHideNoiseChange={setHideNoise}
        onThemeChange={setTheme}
        onLanguageChange={setLanguage}
        onInstallHooks={installHooks}
        onRemoveHooks={removeHooks}
        onTestHooks={testHooks}
        onRunHelper={runHelper}
        onStartProxy={startProxy}
        onStopProxy={stopProxy}
        onStartGateway={startGateway}
        onStopGateway={stopGateway}
        onSaveGatewaySettings={saveGatewaySettings}
        onTestGatewayProvider={testGatewayProvider}
        busy={busy}
      />
    </div>
    </Tooltip.Provider>
    </I18nContext.Provider>
  );
}

function LaunchScreen({ visible }) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <div className="launch-screen">
      <img src={launchGraphic} alt="" />
      <div>
        <strong>LoopLens</strong>
        <span>{t("app.tagline")}</span>
      </div>
    </div>
  );
}

function Sidebar({ appInfo, activeView, onActiveViewChange, onOpenSettings }) {
  const { t } = useI18n();
  const navItems = [
    { view: "Activity", icon: ActivityIcon },
    { view: "Inspect", icon: Workflow },
    { view: "Network", icon: Network },
  ];
  return (
    <aside className="sidebar">
      <div className="brand">
        <div className="brand-mark">
          <img src={appLogo} alt="" />
        </div>
        <div className="brand-copy">
          <h1>LoopLens</h1>
          <p title={appInfo?.root || ""}>{t("sidebar.subtitle")}</p>
        </div>
      </div>
      <div className="sidebar-main">
        <nav className="sidebar-nav-panel" aria-label={t("toolbar.mainViews")}>
          <span className="sidebar-nav-heading">{t("sidebar.sectionViews")}</span>
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeView === item.view;
            return (
              <button
                type="button"
                className={`sidebar-nav-item${active ? " active" : ""}`}
                key={item.view}
                onClick={() => onActiveViewChange(item.view)}
                aria-current={active ? "page" : undefined}
              >
                <Icon aria-hidden="true" />
                <strong>{t(`view.${item.view}`)}</strong>
              </button>
            );
          })}
          <div className="sidebar-nav-divider" aria-hidden="true" />
          <button type="button" className="sidebar-nav-item sidebar-nav-settings" onClick={onOpenSettings} aria-label={t("settings.open")}>
            <SettingsIcon aria-hidden="true" />
            <strong>{t("settings.title")}</strong>
          </button>
        </nav>
      </div>
    </aside>
  );
}

function HookPanel({ native, busy, hookStatus, hookEvents, onInstallHooks, onRemoveHooks, onTestHooks }) {
  const { t } = useI18n();
  const receiverReady = Boolean(hookStatus?.receiver?.running);
  const claudeReady = Boolean(hookStatus?.claude?.installed);
  const codexReady = Boolean(hookStatus?.codex?.installed);
  const allReady = receiverReady && claudeReady && codexReady;
  const hookBusy = String(busy || "").includes("hooks");
  const eventCount = hookEvents?.total || hookStatus?.total_events || 0;
  const lastEvent = hookStatus?.last_event;

  return (
    <div className={`hook-card ${allReady ? "ready" : ""}`}>
      <div className="hook-card-head">
        <div>
          <strong>{t("hooks.title")}</strong>
          <span>{receiverReady ? t("hooks.receiverLive") : t("hooks.receiverOffline")} · {t("hooks.events", { count: eventCount })}</span>
        </div>
        <span className={`hook-pill ${allReady ? "ready" : "attention"}`}>{allReady ? t("hooks.enabled") : t("hooks.setup")}</span>
      </div>

      {!allReady && (
        <div className="hook-status-grid">
          <HookStatusItem label={t("settings.receiver")} ready={receiverReady} detail={hookStatus?.receiver?.listen || "127.0.0.1:37917"} />
          <HookStatusItem label="Claude" ready={claudeReady} detail={hookStatus?.claude?.installed ? t("hooks.httpHooks") : t("hooks.notInstalled")} />
          <HookStatusItem label="Codex" ready={codexReady} detail={hookStatus?.codex?.installed ? t("hooks.commandHooks") : t("hooks.notInstalled")} />
        </div>
      )}

      {lastEvent && (
        <div className="hook-last-event" title={lastEvent.id}>
          <span>{lastEvent.source}</span>
          <strong>{lastEvent.event_name}</strong>
        </div>
      )}

      <div className="hook-actions">
        <button className="mini" disabled={!native || hookBusy} onClick={() => onInstallHooks("all")}>
          {t("settings.enable")}
        </button>
        <button className="mini" disabled={!native || hookBusy} onClick={() => onTestHooks("all")}>
          {t("settings.test")}
        </button>
        <button className="mini danger" disabled={!native || hookBusy || (!claudeReady && !codexReady)} onClick={() => onRemoveHooks("all")}>
          {t("settings.remove")}
        </button>
      </div>
    </div>
  );
}

function HookStatusItem({ label, ready, detail }) {
  return (
    <div className={`hook-status-item ${ready ? "ready" : ""}`}>
      <span aria-hidden="true">
        {ready ? <CircleCheck /> : <CircleAlert />}
      </span>
      <div>
        <strong>{label}</strong>
        <em>{detail}</em>
      </div>
    </div>
  );
}

function SettingsPanel({
  open,
  onClose,
  initialSection = null,
  onInitialSectionConsumed,
  native,
  appInfo,
  proxyStatus,
  gatewayStatus,
  gatewaySettings,
  environment,
  hookStatus,
  hookEvents,
  listen,
  bodyLimit,
  captureAll,
  live,
  followLatest,
  hideNoise,
  theme,
  language,
  onListenChange,
  onBodyLimitChange,
  onCaptureAllChange,
  onLiveChange,
  onFollowLatestChange,
  onHideNoiseChange,
  onThemeChange,
  onLanguageChange,
  onInstallHooks,
  onRemoveHooks,
  onTestHooks,
  onRunHelper,
  onStartProxy,
  onStopProxy,
  onStartGateway,
  onStopGateway,
  onSaveGatewaySettings,
  onTestGatewayProvider,
  busy,
}) {
  const { t } = useI18n();
  const [gatewayDraft, setGatewayDraft] = useState(defaultGatewayDraft(gatewaySettings));
  const [gatewayTest, setGatewayTest] = useState(null);
  const [activeSection, setActiveSection] = useState("general");

  useEffect(() => {
    if (open) {
      setGatewayDraft(defaultGatewayDraft(gatewaySettings));
      setGatewayTest(null);
    }
  }, [gatewaySettings, open]);

  useEffect(() => {
    if (!open || !initialSection) return;
    setActiveSection(initialSection);
    onInitialSectionConsumed?.();
  }, [open, initialSection, onInitialSectionConsumed]);

  useEffect(() => {
    if (!open) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onClose, open]);

  if (!open) return null;

  const hookBusy = String(busy || "").includes("hooks");
  const gatewayBusy = String(busy || "").includes("gateway");
  const claudeReady = Boolean(hookStatus?.claude?.installed);
  const codexReady = Boolean(hookStatus?.codex?.installed);
  const caGenerated = Boolean(environment?.ca_cert_exists && environment?.ca_key_exists);
  const gatewayRunning = Boolean(gatewayStatus?.running);
  const openaiEnvSnippet = `OPENAI_BASE_URL=http://${gatewayDraft.listen || "127.0.0.1:37918"}/v1`;
  const anthropicEnvSnippet = `ANTHROPIC_BASE_URL=http://${gatewayDraft.listen || "127.0.0.1:37918"}`;
  const settingsSections = [
    { id: "general", label: t("settings.categoryGeneral"), description: t("settings.desc.general"), icon: SlidersHorizontal },
    { id: "appearance", label: t("settings.categoryAppearance"), description: t("settings.desc.appearance"), icon: Palette },
    { id: "gateway", label: t("settings.categoryGateway"), description: t("settings.desc.gateway"), icon: Route },
    { id: "proxy", label: t("settings.categoryProxy"), description: t("settings.desc.proxy"), icon: Network },
    { id: "hooks", label: t("settings.categoryHooks"), description: t("settings.desc.hooks"), icon: Webhook },
    { id: "trust", label: t("settings.categoryTrust"), description: t("settings.desc.trust"), icon: ShieldCheck },
    { id: "diagnostics", label: t("settings.categoryDiagnostics"), description: t("settings.desc.diagnostics"), icon: InfoIcon },
  ];
  const activeMeta = settingsSections.find((item) => item.id === activeSection) || settingsSections[0];

  async function runGatewayTest(provider) {
    await onSaveGatewaySettings(gatewayDraft);
    const result = await onTestGatewayProvider(provider);
    if (result) setGatewayTest(result);
  }

  function renderSettingsContent() {
    if (activeSection === "appearance") {
      return (
        <section className="settings-section">
          <h3>{t("settings.display")}</h3>
          <SettingSegmented
            label={t("settings.theme")}
            detail={t("settings.themeDetail")}
            value={theme}
            options={[
              { value: "dark", label: t("settings.theme.dark") },
              { value: "light", label: t("settings.theme.light") },
            ]}
            onChange={onThemeChange}
          />
          <SettingSegmented
            label={t("settings.language")}
            detail={t("settings.languageDetail")}
            value={language}
            options={[
              { value: "en", label: t("settings.language.en") },
              { value: "zh", label: t("settings.language.zh") },
            ]}
            onChange={onLanguageChange}
          />
        </section>
      );
    }

    if (activeSection === "gateway") {
      return (
        <section className="settings-section gateway-section">
          <h3>{t("settings.gateway")}</h3>
          <SettingReadout label={t("settings.status")} value={gatewayRunning ? gatewayStatus?.external ? t("value.external") : t("value.running") : t("value.stopped")} />
          <SettingInput
            label={t("settings.listen")}
            value={gatewayDraft.listen}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, listen: value }))}
          />
          <SettingInput
            label={t("settings.openaiKey")}
            type="password"
            placeholder={gatewaySettings?.openai_key_masked || "sk-..."}
            value={gatewayDraft.openai_api_key}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, openai_api_key: value }))}
          />
          <SettingInput
            label={t("settings.openaiUrl")}
            value={gatewayDraft.openai_base_url}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, openai_base_url: value }))}
          />
          <SettingInput
            label={t("settings.anthropicKey")}
            type="password"
            placeholder={gatewaySettings?.anthropic_key_masked || "sk-ant-..."}
            value={gatewayDraft.anthropic_api_key}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, anthropic_api_key: value }))}
          />
          <SettingInput
            label={t("settings.anthropicUrl")}
            value={gatewayDraft.anthropic_base_url}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, anthropic_base_url: value }))}
          />
          <SettingInput
            label={t("settings.maxRetries")}
            type="number"
            value={gatewayDraft.max_retries}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, max_retries: Number(value || 0) }))}
          />
          <SettingToggle
            label={t("settings.redaction")}
            detail={t("settings.redactionDetail")}
            checked={gatewayDraft.redaction_enabled}
            onChange={(value) => setGatewayDraft((draft) => ({ ...draft, redaction_enabled: value }))}
          />
          <div className="gateway-snippets">
            <div>
              <code>{openaiEnvSnippet}</code>
              <button className="mini" onClick={() => copyText(openaiEnvSnippet)}>{t("settings.copy")}</button>
            </div>
            <div>
              <code>{anthropicEnvSnippet}</code>
              <button className="mini" onClick={() => copyText(anthropicEnvSnippet)}>{t("settings.copy")}</button>
            </div>
          </div>
          {gatewayTest && (
            <div className={`gateway-test ${gatewayTest.ok ? "ok" : "warn"}`}>
              <strong>{gatewayTest.provider}</strong>
              <span>{gatewayTest.message}</span>
            </div>
          )}
          <div className="settings-button-row gateway-buttons">
            <button className="mini" disabled={!native || gatewayBusy} onClick={() => onSaveGatewaySettings(gatewayDraft)}>{t("settings.save")}</button>
            <button className="mini" disabled={!native || gatewayBusy} onClick={() => gatewayRunning ? onStopGateway() : onStartGateway(gatewayDraft)}>
              {gatewayRunning ? t("settings.stop") : t("settings.start")}
            </button>
            <button className="mini" disabled={!native || gatewayBusy} onClick={() => runGatewayTest("openai")}>{t("settings.testOpenAI")}</button>
          </div>
          <div className="settings-button-row gateway-buttons two">
            <button className="mini" disabled={!native || gatewayBusy} onClick={() => runGatewayTest("anthropic")}>{t("settings.testAnthropic")}</button>
            <button className="mini" disabled={!native || gatewayBusy || (!gatewayDraft.openai_api_key && !gatewaySettings?.openai_key_masked)} onClick={() => setGatewayDraft((draft) => ({ ...draft, openai_api_key: "__CLEAR__" }))}>{t("settings.clearOpenAI")}</button>
            <button className="mini" disabled={!native || gatewayBusy || (!gatewayDraft.anthropic_api_key && !gatewaySettings?.anthropic_key_masked)} onClick={() => setGatewayDraft((draft) => ({ ...draft, anthropic_api_key: "__CLEAR__" }))}>{t("settings.clearAnthropic")}</button>
          </div>
        </section>
      );
    }

    if (activeSection === "proxy") {
      const proxyRunning = Boolean(proxyStatus?.running);
      const proxyBusy = busy === "proxy";
      return (
        <section className="settings-section">
          <h3>{t("settings.proxyCapture")}</h3>
          <SettingInput label={t("settings.listenAddress")} value={listen} onChange={onListenChange} />
          <SettingInput label={t("settings.bodyLimit")} value={bodyLimit} onChange={onBodyLimitChange} />
          <SettingToggle label={t("settings.captureAll")} detail={t("settings.captureAllDetail")} checked={captureAll} onChange={onCaptureAllChange} />
          <SettingReadout label={t("settings.proxy")} value={proxyRunning ? proxyStatus.external ? t("value.external") : t("value.running") : t("value.stopped")} />
          <div className="settings-button-row">
            <button
              className="mini"
              disabled={!native || proxyBusy || proxyRunning}
              onClick={onStartProxy}
            >
              {t("settings.start")}
            </button>
            <button
              className="mini danger"
              disabled={!native || proxyBusy || !proxyRunning}
              onClick={onStopProxy}
            >
              {t("settings.stop")}
            </button>
          </div>
        </section>
      );
    }

    if (activeSection === "hooks") {
      return (
        <section className="settings-section">
          <h3>{t("settings.hooks")}</h3>
          <SettingReadout label={t("settings.receiver")} value={hookStatus?.receiver?.running ? hookStatus.receiver.listen : t("value.offline")} />
          <SettingReadout label="Claude Code" value={claudeReady ? t("value.installed") : t("value.notInstalled")} />
          <SettingReadout label="Codex" value={codexReady ? t("value.installed") : t("value.notInstalled")} />
          <SettingReadout label={t("settings.capturedEvents")} value={String(hookEvents?.total || hookStatus?.total_events || 0)} />
          <div className="settings-button-row">
            <button className="mini" disabled={!native || hookBusy} onClick={() => onInstallHooks("all")}>{t("settings.enable")}</button>
            <button className="mini" disabled={!native || hookBusy} onClick={() => onTestHooks("all")}>{t("settings.test")}</button>
            <button className="mini danger" disabled={!native || hookBusy || (!claudeReady && !codexReady)} onClick={() => onRemoveHooks("all")}>{t("settings.remove")}</button>
          </div>
        </section>
      );
    }

    if (activeSection === "trust") {
      return (
        <section className="settings-section">
          <h3>{t("settings.trustEnvironment")}</h3>
          <SettingReadout label={t("settings.nativeApp")} value={native ? t("value.enabled") : t("value.preview")} />
          <SettingReadout label={t("settings.proxyBinary")} value={environment?.proxy_binary_exists ? t("value.ready") : t("value.missing")} />
          <SettingReadout label={t("settings.caFiles")} value={caGenerated ? t("value.generated") : t("value.missing")} />
          <SettingReadout label={t("settings.caTrust")} value={environment?.ca_trusted ? t("value.trusted") : t("value.notTrusted")} />
          <div className="settings-button-row">
            <button className="mini" disabled={!native || busy === "gen-ca" || caGenerated} onClick={() => onRunHelper("gen-ca")}>{t("settings.generateCA")}</button>
            <button className="mini" disabled={!native || busy === "trust-ca" || !caGenerated || environment?.ca_trusted} onClick={() => onRunHelper("trust-ca")}>{t("settings.trustCA")}</button>
          </div>
        </section>
      );
    }

    if (activeSection === "diagnostics") {
      return (
        <>
          <section className="settings-section">
            <h3>{t("settings.dataPrivacy")} <em>{t("settings.readOnly")}</em></h3>
            <SettingReadout label={t("settings.storage")} value={t("value.localOnly")} />
            <SettingReadout label={t("settings.rawCapture")} value={t("value.retained")} />
            <SettingReadout label={t("settings.gatewayKeys")} value={t("value.localMasked")} />
            <SettingReadout label={t("settings.exportMode")} value={t("value.manual")} />
          </section>
          <section className="settings-section">
            <h3>{t("settings.interface")} <em>{t("settings.readOnly")}</em></h3>
            <SettingReadout label={t("settings.defaultView")} value={t("view.Inspect")} />
            <SettingReadout label={t("settings.history")} value={t("value.collapsed")} />
            <SettingReadout label={t("settings.typography")} value={t("value.systemMono")} />
          </section>
          <section className="settings-section compact">
            <h3>{t("settings.paths")} <em>{t("settings.readOnly")}</em></h3>
            <SettingReadout label={t("settings.project")} value={appInfo?.root || "-"} title={appInfo?.root} />
            <SettingReadout label={t("settings.captures")} value={appInfo?.captures_dir || "-"} title={appInfo?.captures_dir} />
            <SettingReadout label={t("settings.hookEvents")} value={hookStatus?.receiver?.event_file || "-"} title={hookStatus?.receiver?.event_file} />
            <SettingReadout label={t("settings.gatewaySettings")} value={gatewaySettings?.settings_path || "-"} title={gatewaySettings?.settings_path} />
          </section>
        </>
      );
    }

    return (
      <section className="settings-section">
        <h3>{t("settings.runDefaults")}</h3>
        <SettingToggle label={t("settings.livePolling")} detail={t("settings.livePollingDetail")} checked={live} onChange={onLiveChange} />
        <SettingToggle label={t("settings.followLatest")} detail={t("settings.followLatestDetail")} checked={followLatest} onChange={onFollowLatestChange} />
        <SettingToggle label={t("settings.hideNoise")} detail={t("settings.hideNoiseDetail")} checked={hideNoise} onChange={onHideNoiseChange} />
      </section>
    );
  }

  return (
    <div className="settings-layer" onMouseDown={onClose}>
      <section className="settings-sheet" role="dialog" aria-modal="true" aria-label={t("settings.title")} onMouseDown={(event) => event.stopPropagation()}>
        <aside className="settings-nav">
          <button className="settings-back" onClick={onClose}>
            <ArrowLeft aria-hidden="true" />
            <strong>{t("settings.backToApp")}</strong>
          </button>
          <div className="settings-nav-brand">
            <img src={appLogo} alt="" />
            <div>
              <strong>LoopLens</strong>
              <span>{t("settings.subtitle")}</span>
            </div>
          </div>
          <nav className="settings-nav-list" aria-label={t("settings.title")}>
            {settingsSections.map((item) => {
              const Icon = item.icon;
              return (
                <button
                  key={item.id}
                  className={activeSection === item.id ? "active" : ""}
                  onClick={() => setActiveSection(item.id)}
                >
                  <span className="settings-nav-icon" aria-hidden="true">
                    <Icon />
                  </span>
                  <span>
                    <strong>{item.label}</strong>
                    <em>{item.description}</em>
                  </span>
                </button>
              );
            })}
          </nav>
        </aside>

        <main className="settings-main">
          <header className="settings-head">
            <div>
              <h2>{activeMeta.label}</h2>
              <p>{activeMeta.description}</p>
            </div>
            <button className="settings-close" onClick={onClose} aria-label={t("settings.close")}>
              <X aria-hidden="true" />
            </button>
          </header>

          <div className="settings-scroll">
            {renderSettingsContent()}
          </div>
        </main>
      </section>
    </div>
  );
}

function SettingToggle({ label, detail, checked, onChange }) {
  return (
    <label className="setting-row toggle-row">
      <span>
        <strong>{label}</strong>
        {detail && <em>{detail}</em>}
      </span>
      <input type="checkbox" checked={Boolean(checked)} onChange={(event) => onChange(event.target.checked)} />
    </label>
  );
}

function SettingInput({ label, value, onChange, type = "text", placeholder = "" }) {
  return (
    <label className="setting-row input-row">
      <span>
        <strong>{label}</strong>
      </span>
      <input type={type} placeholder={placeholder} value={value ?? ""} onChange={(event) => onChange(event.target.value)} />
    </label>
  );
}

function SettingSegmented({ label, detail = "", value, options, onChange }) {
  return (
    <div className="setting-row segmented-row">
      <span>
        <strong>{label}</strong>
        {detail && <em>{detail}</em>}
      </span>
      <div className="setting-segment" role="group" aria-label={label}>
        {options.map((option) => (
          <button
            className={option.value === value ? "active" : ""}
            key={option.value}
            onClick={() => onChange(option.value)}
            aria-pressed={option.value === value}
          >
            {option.label}
          </button>
        ))}
      </div>
    </div>
  );
}

function SettingReadout({ label, value, title = "" }) {
  return (
    <div className="setting-row readout-row">
      <span>
        <strong>{label}</strong>
      </span>
      <code title={title || value}>{value || "-"}</code>
    </div>
  );
}

function defaultGatewayDraft(settings: AnyRecord = {}) {
  return {
    listen: settings?.listen || "127.0.0.1:37918",
    openai_api_key: "",
    openai_base_url: settings?.openai_base_url || "https://api.openai.com",
    anthropic_api_key: "",
    anthropic_base_url: settings?.anthropic_base_url || "https://api.anthropic.com",
    default_provider: settings?.default_provider || "openai",
    routing_rules: settings?.routing_rules || [],
    max_retries: Number(settings?.max_retries ?? 2),
    redaction_enabled: settings?.redaction_enabled ?? true,
  };
}

function setupChecklistItems(environment, native, t = (key) => key) {
  const tools = environment?.tools || [];
  const tool = (id) => tools.find((item) => item.id === id);
  const codex = tool("codex");
  const claude = tool("claude");
  const caGenerated = Boolean(environment?.ca_cert_exists && environment?.ca_key_exists);
  return [
    {
      label: t("settings.nativeApp"),
      ready: native,
      detail: native ? "Tauri controls enabled" : "Browser preview only",
    },
    {
      label: t("settings.proxyBinary"),
      ready: Boolean(environment?.proxy_binary_exists),
      detail: environment?.proxy_binary_exists ? "Built and available" : "Run cargo build -p looplens-proxy --release",
    },
    {
      label: t("settings.caFiles"),
      ready: caGenerated,
      detail: caGenerated ? "Certificate generated" : "Generate local CA files",
      action: caGenerated ? null : "gen-ca",
      actionLabel: t("settings.generateCA"),
      busyKey: "gen-ca",
      optional: true,
    },
    {
      label: t("settings.caTrust"),
      ready: Boolean(environment?.ca_trusted),
      detail: environment?.ca_trusted ? "Trusted in login keychain" : caGenerated ? "Trust CA before HTTPS capture" : "Generate CA files first",
      action: environment?.ca_trusted ? null : "trust-ca",
      actionLabel: t("settings.trustCA"),
      busyKey: "trust-ca",
      actionDisabled: !caGenerated,
      optional: true,
    },
    {
      label: "Codex CLI",
      ready: Boolean(codex?.wrapper_exists && codex?.command_path),
      detail: codex?.command_path || "Command or wrapper missing",
    },
    {
      label: "Claude Code",
      ready: Boolean(claude?.wrapper_exists && claude?.command_path),
      detail: claude?.command_path || "Command or wrapper missing",
    },
  ];
}

function RunCard({
  file,
  active,
  activeRunSource,
  proxyStatus,
  activeFlowCount,
  activeLoopSteps,
  captureHealth = null,
  onSelectFile,
}) {
  return (
    <button
      className={`file-item ${active ? "active" : ""}`}
      onClick={() => onSelectFile(file.name)}
      aria-current={active ? "true" : undefined}
      title={file.name}
    >
      <div className="file-head">
        <div className="file-name">{runTitle(file)}</div>
        <span className={`file-pill ${active && proxyStatus?.running ? "live" : ""}`}>
          {active && proxyStatus?.running ? "live" : active ? activeRunSource : "run"}
        </span>
      </div>
      <div className="file-meta">
        <span>{file.name}</span>
        <span>{formatTime(file.modified)}</span>
      </div>
      {active && (
        <div className="run-metrics">
          <span>{activeFlowCount} flows</span>
          <span>{activeLoopSteps} loop steps</span>
          <span>{formatBytes(file.size)}</span>
          {captureHealth && <span className={`health-badge ${captureHealth.status}`}>{healthLabel(captureHealth)}</span>}
        </div>
      )}
    </button>
  );
}

function runTitle(file) {
  const source = captureSourceLabel(file.name);
  const match = file.name.match(/capture-(?:gateway-|codex-|claude-code-)?(\d{8})-(\d{6})/);
  if (!match) return file.modified ? `${source} ${formatTime(file.modified)}` : `${source}`;
  const [, date, time] = match;
  return `${source} ${date.slice(4, 6)}/${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
}

function healthLabel(health) {
  if (!health) return "";
  if (health.status === "broken") return "Broken";
  if (health.status === "warnings") return "Warnings";
  return "Healthy";
}

function healthChips(health) {
  if (!health || health.status === "healthy") return [];
  return [
    ["invalid lines", health.invalid_lines],
    ["duplicates", health.duplicate_flow_ids?.length],
    ["orphan chunks", health.orphan_chunks],
    ["pending", health.pending_flows],
    ["HTTP errors", health.error_flows],
    ["low signal", health.low_signal_flows],
  ]
    .filter(([, value]) => Number(value) > 0)
    .map(([label, value]) => ({ label, value }));
}

function dominantClientLabel(clientStats) {
  const candidates = clientStats.filter((item) => item.key !== "all");
  const top = candidates.sort((a, b) => b.count - a.count)[0];
  return top?.label || "run";
}

function RunBar({
  native,
  proxyStatus,
  gatewayStatus,
  listen,
  busy,
  file,
  onStartProxy,
  onStopProxy,
  onOpenSettings,
}) {
  const { t } = useI18n();
  const proxyRunning = Boolean(proxyStatus?.running);
  const proxyBusy = busy === "proxy";
  const proxyTone = proxyRunning ? (proxyStatus?.external ? "external" : "running") : "idle";
  const proxyValue = proxyRunning
    ? proxyStatus?.external
      ? t("value.external")
      : proxyStatus?.listen || listen
    : listen;
  const gatewayRunning = Boolean(gatewayStatus?.running);
  const gatewayTone = gatewayRunning ? (gatewayStatus?.external ? "external" : "running") : "idle";
  const fileName = file?.name ? compactRunName(file.name) : t("toolbar.noFile");
  return (
    <header className="runbar" aria-label={t("runbar.label")} onMouseDown={native ? handleWindowDragMouseDown : undefined}>
      <div className={`runbar-cluster proxy ${proxyTone}`}>
        <span className={`runbar-dot ${proxyTone}`} aria-hidden="true" />
        <strong>{t("runbar.proxy")}</strong>
        <code title={proxyValue}>{proxyValue}</code>
        <button
          className="runbar-action"
          disabled={!native || proxyBusy}
          onClick={proxyRunning ? onStopProxy : onStartProxy}
          title={proxyRunning ? t("runbar.stopProxy") : t("runbar.startProxy")}
        >
          {proxyRunning ? t("runbar.stop") : t("runbar.start")}
        </button>
      </div>
      <div className="runbar-cluster file" title={file?.name || ""}>
        <span className="runbar-label">{t("runbar.run")}</span>
        <span className="runbar-value">{fileName}</span>
      </div>
      <div className="runbar-cluster meta">
        <span className={`runbar-dot ${gatewayTone}`} aria-hidden="true" />
        <span className="runbar-label">{t("runbar.gateway")}</span>
        <span className="runbar-value">
          {gatewayRunning
            ? gatewayStatus?.external
              ? t("value.external")
              : gatewayStatus?.listen || t("value.running")
            : t("value.stopped")}
        </span>
        <button className="runbar-action subtle" onClick={onOpenSettings} title={t("settings.title")}>
          <SettingsIcon aria-hidden="true" />
        </button>
      </div>
    </header>
  );
}

function Toolbar({
  native,
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
  inspectTab,
  onActiveViewChange,
  categories,
  categoryFilter,
  onCategoryFilterChange,
  statusFilter,
  onStatusFilterChange,
  hideNoise,
  onHideNoiseChange,
  loopFocus,
  onLoopFocusChange,
}) {
  const { t } = useI18n();
  const isNetwork = activeView === "Network";
  const isLoop = activeView === "Inspect" && inspectTab === "Loop";
  const isActivity = activeView === "Activity";
  function applyQuickFilter(filter) {
    onCategoryFilterChange(filter.category);
    onStatusFilterChange(filter.status);
  }

  return (
    <header className="topbar" onMouseDown={native ? handleWindowDragMouseDown : undefined}>
      <div className="workspace-title">
        <strong>{t(`view.${activeView}`)}</strong>
        <span>{clientLabel(sourceFilter)} · {proxyStatus?.running ? t("toolbar.liveReview") : t("toolbar.paused")}</span>
      </div>
      <div className="search-wrap">
        {isNetwork ? (
          <input
            className="search"
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t("toolbar.searchPlaceholder")}
            aria-label={t("toolbar.searchFlows")}
          />
        ) : isLoop ? (
          <div className="page-context empty" aria-hidden="true" />
        ) : (
          <div className={`page-context ${isLoop ? "minimal" : ""}`}>
            <strong>{viewHeadline(activeView, t)}</strong>
            <span>{viewSubline(activeView, shownCount, totalCount, t)}</span>
          </div>
        )}
      </div>
      <div className="toolbar-actions">
        <div className="toolbar-filter-group">
          {isNetwork && (
            <>
            <div className="quick-filters" aria-label={t("toolbar.quickFilters")}>
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
                    {t(`quick.${filter.label}`)}
                  </button>
                );
              })}
            </div>
            <SelectControl
              label={t("toolbar.categoryFilter")}
              value={categoryFilter}
              onValueChange={onCategoryFilterChange}
              items={categories}
            />
            <SelectControl
              label={t("toolbar.statusFilter")}
              value={statusFilter}
              onValueChange={onStatusFilterChange}
              items={["All", "2xx", "Errors", "Pending"]}
            />
            </>
          )}
          {isLoop && (
            <div className="quick-filters loop-focus" aria-label={t("toolbar.loopFocus")}>
            {["All", "Attention", "Hooks", "Errors", "Expensive", "Tools"].map((focus) => (
              <button
                className={loopFocus === focus ? "active" : ""}
                key={focus}
                onClick={() => onLoopFocusChange(focus)}
                aria-pressed={loopFocus === focus}
              >
                {t(`focus.${focus}`)}
              </button>
            ))}
            </div>
          )}
        </div>
        <div className="toolbar-status-group">
          <label className="toggle">
            <input type="checkbox" checked={live} onChange={(event) => onLiveChange(event.target.checked)} />
            <span>{t("toolbar.live")}</span>
          </label>
          {isLoop && (
            <label className="toggle">
              <input type="checkbox" checked={followLatest} onChange={(event) => onFollowLatestChange(event.target.checked)} />
              <span>{t("toolbar.followLatest")}</span>
            </label>
          )}
          {isNetwork && (
            <label className="toggle">
              <input type="checkbox" checked={hideNoise} onChange={(event) => onHideNoiseChange(event.target.checked)} />
              <span>{t("toolbar.hideNoise")}</span>
            </label>
          )}
          {isNetwork && (
            <>
              <span className="count">{t("toolbar.visibleFlows", { shown: shownCount, total: totalCount })}</span>
              <span className="active-file" title={file?.name || ""}>{file?.name || t("toolbar.noFile")}</span>
            </>
          )}
          {isActivity && file?.name && <span className="active-file" title={file.name}>{compactRunName(file.name)}</span>}
        </div>
      </div>
    </header>
  );
}

function viewHeadline(view, t = (key) => key) {
  return t(`headline.${view}`) === `headline.${view}` ? t("headline.default") : t(`headline.${view}`);
}

function viewSubline(view, shownCount, totalCount, t = (key, values = {}) => formatTranslation(key, values)) {
  const translated = t(`subline.${view}`);
  if (translated !== `subline.${view}`) return translated;
  return t("toolbar.visibleFlows", { shown: shownCount, total: totalCount });
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
        <Select.Icon className="select-icon">
          <ChevronDown aria-hidden="true" />
        </Select.Icon>
      </Select.Trigger>
      <Select.Portal>
        <Select.Content className="select-content" position="popper" sideOffset={6}>
          <Select.Viewport className="select-viewport">
            {items.map((item) => (
              <Select.Item className="select-item" value={item} key={item}>
                <Select.ItemText>{item}</Select.ItemText>
                <Select.ItemIndicator className="select-indicator">
                  <Check aria-hidden="true" />
                </Select.ItemIndicator>
              </Select.Item>
            ))}
          </Select.Viewport>
        </Select.Content>
      </Select.Portal>
    </Select.Root>
  );
}

function viewDescription(view, t = (key) => key) {
  const translated = t(`desc.${view}`);
  return translated === `desc.${view}` ? "" : translated;
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
              <span style={{ "--flow-width": `${Math.max(4, (transfer / maxTransfer) * 100)}%` } as CssVars} />
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
  const table = useReactTable<any>({
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
  captureHealth,
  onViewInLoop,
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
          <DetailActions detail={detail} onViewInLoop={onViewInLoop} onSetCompareA={onSetCompareA} onSetCompareB={onSetCompareB} />
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
        {activeTab === "Parsed" && <ParsedTab semantic={summary.semantic} flowId={summary.id} captureHealth={captureHealth} />}
        {activeTab === "Prompt" && <CodeBlock value={promptText(detail.request) || "No request body."} />}
        {activeTab === "Response" && <CodeBlock value={detail.reconstructed_response || "No response chunks."} />}
        {activeTab === "Raw" && <RawTab detail={detail} />}
        {activeTab === "Chunks" && <ChunksTab chunks={detail.chunks} />}
      </div>
    </section>
  );
}

function EmptyState({ native, proxyStatus, hasFile, hasFlows, onStartProxy, onOpenTool }) {
  const { t } = useI18n();
  let title = t("empty.noTraffic");
  let message = t("empty.startCapture");
  if (!native) {
    title = t("empty.preview");
    message = t("empty.previewMessage");
  } else if (proxyStatus?.running && !hasFlows) {
    title = t("empty.waiting");
    message = t("empty.waitingMessage");
  } else if (hasFile && !hasFlows) {
    title = t("empty.noFlows");
    message = t("empty.noFlowsMessage");
  }

  return (
    <div className="empty-state">
      <h2>{title}</h2>
      <p>{message}</p>
      <div className="empty-actions">
        <button className="primary" disabled={!native} onClick={onStartProxy}>{t("empty.startCaptureButton")}</button>
        <button disabled={!native} onClick={() => onOpenTool("codex")}>{t("run.openCodex")}</button>
        <button disabled={!native} onClick={() => onOpenTool("claude")}>{t("run.openClaude")}</button>
      </div>
      {native && <p className="empty-hint">{t("setup.emptyStateHint")}</p>}
      {!native && <p className="disabled-reason">{t("empty.nativeReason")}</p>}
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
      <Info label="Gateway provider" value={summary.semantic?.gateway_provider} />
      <Info label="Gateway route" value={summary.semantic?.gateway_route_reason} />
      <Info label="Upstream" value={summary.semantic?.upstream_url} />
      <Info label="Retry attempts" value={formatGatewayRetries(summary.semantic)} />
      <Info label="MCP server" value={summary.semantic?.mcp_server} />
      <Info label="RPC method" value={summary.semantic?.rpc_method} />
      <Info label="Request headers" value={Object.keys(request?.headers || {}).join(", ") || "None"} />
      <Info label="Response headers" value={Object.keys(responseStart?.headers || {}).join(", ") || "None"} />
      <Info label="Redactions" value={summary.semantic?.redaction_hits} />
    </div>
  );
}

function ParsedTab({ semantic, flowId, captureHealth }) {
  if (!semantic) return <CodeBlock value="No parsed semantic metadata." />;
  const diagnostics = diagnosticsForFlow(captureHealth, flowId);
  return (
    <div className="parsed-grid">
      <Info label="Category" value={semantic.category} />
      <Info label="Signal" value={semantic.low_signal ? "low signal" : "primary"} />
      <Info label="Client" value={semantic.client} />
      <Info label="Gateway provider" value={semantic.gateway_provider} />
      <Info label="Route reason" value={semantic.gateway_route_reason} />
      <Info label="Upstream" value={semantic.upstream_url} />
      <Info label="Retries" value={formatGatewayRetries(semantic)} />
      <Info label="MCP server" value={semantic.mcp_server} />
      <Info label="RPC method" value={semantic.rpc_method} />
      <Info label="Model" value={semantic.model} />
      <Info label="Tokens" value={formatTokenUsage(semantic.token_usage)} />
      <Info label="Event type" value={semantic.event_type} />
      <Info label="Redaction hits" value={semantic.redaction_hits} />
      <ListInfo label="Tools" items={semantic.tool_names} />
      <ListInfo label="Skills" items={semantic.skill_names} />
      <ListInfo label="Retry evidence" items={semantic.retry_reasons} />
      <ListInfo label="Diagnostics" items={diagnostics.map((item) => `${item.severity}: ${item.message}`)} />
    </div>
  );
}

function diagnosticsForFlow(health, flowId) {
  if (!health || !flowId) return [];
  return (health.diagnostics || []).filter((item) => String(item.flow_id || "") === String(flowId));
}

function SessionStrip({ analytics }) {
  const cost = computeEstimatedCost(analytics);
  return (
    <section className="session-strip">
      <Metric label="Flows" value={analytics.totalFlows} />
      <Metric label="Errors" value={analytics.errors} tone={analytics.errors ? "bad" : ""} />
      <Metric label="MCP servers" value={analytics.mcpServers.length} />
      <Metric label="Tools" value={analytics.tools.length} />
      <Metric label="Models" value={analytics.models.length} />
      <Metric label="Tokens" value={formatTokenMetric(analytics.tokens.total)} />
      {cost > 0 && <Metric label="Est. Cost" value={formatCostUSD(cost)} />}
      <Metric label="Redactions" value={analytics.redactions} />
    </section>
  );
}

function computeEstimatedCost(analytics) {
  let total = 0;
  for (const item of analytics.tokenByModel || []) {
    total += estimateCost({
      inputTokens: item.input,
      outputTokens: item.output,
      cachedInputTokens: item.cached,
    }, item.name);
  }
  return total;
}

function Metric({ label, value, tone = "" }) {
  return (
    <div className={`metric ${tone}`}>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function DetailActions({ detail, onViewInLoop, onSetCompareA, onSetCompareB }) {
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
      <button onClick={onViewInLoop}>View in Loop</button>
      <button onClick={onSetCompareA}>Set A</button>
      <button onClick={onSetCompareB}>Set B</button>
    </div>
  );
}

function AnalysisView({
  view,
  inspectTab,
  onInspectTabChange,
  flows,
  filteredFlows,
  analytics,
  compareA,
  compareB,
  file,
  captureHealth,
  claudeSessionIndex,
  claudeSessionDetail,
  hookEvents,
  files,
  activeFile,
  clientStats,
  activeFlowCount,
  activeLoopSteps,
  activeRunLoopSummary,
  listen,
  sourceFilter,
  native,
  environment,
  proxyStatus,
  gatewayStatus,
  hookStatus,
  busy,
  loopFocus,
  followLatest,
  onOpenTool,
  onStartProxy,
  onStopProxy,
  onRefreshFiles,
  onClearHistory,
  onSelectFile,
  onSourceFilterChange,
  onRunHelper,
  onOpenSettings,
  onOpenSettingsSection,
  onOpenNetworkFlow,
}) {
  if (view === "Activity") {
    return (
      <ActivityDashboard
        files={files}
        activeFile={activeFile}
        clientStats={clientStats}
        proxyStatus={proxyStatus}
        gatewayStatus={gatewayStatus}
        hookStatus={hookStatus}
        hookEvents={hookEvents}
        environment={environment}
        native={native}
        busy={busy}
        captureHealth={captureHealth}
        analytics={analytics}
        activeFlowCount={activeFlowCount}
        activeLoopSteps={activeLoopSteps}
        loopModel={activeRunLoopSummary}
        listen={listen}
        onOpenTool={onOpenTool}
        onStartProxy={onStartProxy}
        onStopProxy={onStopProxy}
        onRefreshFiles={onRefreshFiles}
        onClearHistory={onClearHistory}
        onSelectFile={onSelectFile}
        onSourceFilterChange={onSourceFilterChange}
        onOpenSettings={onOpenSettings}
        onOpenSettingsSection={onOpenSettingsSection}
      />
    );
  }
  if (view === "Inspect") {
    return (
      <InspectShell activeTab={inspectTab} onTabChange={onInspectTabChange}>
        {inspectTab === "Loop" && (
          <LoopWorkbench
            flows={flows}
            filteredFlows={filteredFlows}
            analytics={analytics}
            claudeSessionIndex={claudeSessionIndex}
            claudeSessionDetail={claudeSessionDetail}
            hookEvents={hookEvents}
            captureHealth={captureHealth}
            sourceFilter={sourceFilter}
            native={native}
            environment={environment}
            proxyStatus={proxyStatus}
            busy={busy}
            loopFocus={loopFocus}
            followLatest={followLatest}
            onOpenTool={onOpenTool}
            onRunHelper={onRunHelper}
            onOpenNetworkFlow={onOpenNetworkFlow}
          />
        )}
        {inspectTab === "Timeline" && (
          <TimelineWorkbench flows={flows} claudeSessionDetail={claudeSessionDetail} sourceFilter={sourceFilter} />
        )}
        {inspectTab === "Tokens" && (
          <TokensWorkbench analytics={analytics} claudeSessionDetail={claudeSessionDetail} hookEvents={hookEvents} />
        )}
        {inspectTab === "Raw" && (
          <RawWorkbench file={file} flows={flows} captureHealth={captureHealth} claudeSessionDetail={claudeSessionDetail} hookEvents={hookEvents} />
        )}
      </InspectShell>
    );
  }
  return null;
}

function InspectShell({ activeTab, onTabChange, children }) {
  const { t } = useI18n();
  return (
    <section className="inspect-shell">
      <div className="inspect-subnav" role="tablist" aria-label={t("inspect.tabs")}>
        {INSPECT_TABS.map((tab) => {
          const active = activeTab === tab;
          return (
            <button
              key={tab}
              role="tab"
              aria-selected={active}
              className={active ? "active" : ""}
              onClick={() => onTabChange(tab)}
            >
              {t(`inspect.tab.${tab.toLowerCase()}`)}
            </button>
          );
        })}
      </div>
      <div className="inspect-content">{children}</div>
    </section>
  );
}

function PreviewModeHint({ native }) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined" && window.localStorage.getItem(PREVIEW_HINT_STORAGE_KEY) === "1",
  );
  if (native || dismissed) return null;
  return (
    <div className="preview-mode-hint" role="status">
      <Terminal aria-hidden="true" />
      <p>{t("setup.previewBanner")}</p>
      <button
        type="button"
        className="mini"
        onClick={() => {
          window.localStorage.setItem(PREVIEW_HINT_STORAGE_KEY, "1");
          setDismissed(true);
        }}
      >
        {t("setup.previewDismiss")}
      </button>
    </div>
  );
}

function FirstRunGuide({
  listen,
  proxyStatus,
  hookStatus,
  environment,
  hasActiveRun,
  activeFlowCount,
  hookEventsTotal,
  busy,
  onStartProxy,
  onOpenTool,
  onOpenSettingsSection,
}) {
  const { t } = useI18n();
  const [dismissed, setDismissed] = useState(() =>
    typeof window !== "undefined" && window.localStorage.getItem(FIRST_RUN_GUIDE_STORAGE_KEY) === "1",
  );
  const [collapsed, setCollapsed] = useState(false);
  const prevAllDoneRef = useRef(false);

  const tools = environment?.tools || [];
  const codex = tools.find((tool) => tool.id === "codex");
  const claude = tools.find((tool) => tool.id === "claude");
  const hooksInstalled = Boolean(hookStatus?.claude?.installed || hookStatus?.codex?.installed);
  const hooksReady = Boolean(hookStatus?.receiver?.running && hooksInstalled);
  const runStarted = Boolean(hasActiveRun);
  const loopActivityOk = activeFlowCount > 0 || hookEventsTotal > 0;
  const proxyOn = Boolean(proxyStatus?.running);
  const caOk = Boolean(environment?.ca_trusted);
  const allDone = hooksReady && runStarted && loopActivityOk;
  const proxyBusy = busy === "proxy";

  useEffect(() => {
    if (!allDone) {
      setCollapsed(false);
      prevAllDoneRef.current = false;
      return;
    }
    if (!prevAllDoneRef.current) {
      setCollapsed(true);
    }
    prevAllDoneRef.current = true;
  }, [allDone]);

  function dismissForever() {
    window.localStorage.setItem(FIRST_RUN_GUIDE_STORAGE_KEY, "1");
    setDismissed(true);
  }

  if (dismissed) {
    return null;
  }

  if (collapsed && allDone) {
    return (
      <section className="first-run-guide first-run-guide--compact" aria-labelledby="first-run-guide-compact-title">
        <div className="first-run-guide-head">
          <span className="first-run-guide-compact-icon" aria-hidden="true">
            <CircleCheck />
          </span>
          <div className="first-run-guide-titles">
            <p id="first-run-guide-compact-title" className="first-run-guide-summary-text">
              {t("setup.allStepsDoneSummary")}
            </p>
          </div>
          <div className="first-run-guide-actions-inline">
            <button type="button" className="mini" onClick={() => setCollapsed(false)}>
              {t("setup.expandSteps")}
            </button>
            <button type="button" className="mini ghost" onClick={dismissForever}>
              {t("setup.dismiss")}
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="first-run-guide" aria-labelledby="first-run-guide-title">
      <div className="first-run-guide-head">
        <span className="first-run-guide-icon" aria-hidden="true">
          <ShieldCheck />
        </span>
        <div className="first-run-guide-titles">
          <h3 id="first-run-guide-title">{t("setup.title")}</h3>
          <p>{t("setup.subtitle")}</p>
        </div>
        <button type="button" className="mini ghost" onClick={dismissForever}>
          {allDone ? t("setup.doneAll") : t("setup.dismiss")}
        </button>
      </div>
      <ol className="first-run-steps">
        <li className={hooksReady ? "done" : ""}>
          <div className="first-run-step-row">
            <div className="first-run-step-main">
              <span className="first-run-step-marker" aria-hidden="true">{hooksReady ? <CircleCheck /> : null}</span>
              <div>
                <strong>{t("setup.stepHooks")}</strong>
                <p>{t("setup.stepHooksDetail")}</p>
              </div>
            </div>
            <div className="first-run-step-actions">
              {!hooksReady ? (
                <button type="button" className="mini primary" onClick={() => onOpenSettingsSection("hooks")}>
                  {t("setup.enableHooks")}
                </button>
              ) : (
                <span className="first-run-done-label">{t("setup.statusDone")}</span>
              )}
            </div>
          </div>
        </li>
        <li className={runStarted ? "done" : ""}>
          <div className="first-run-step-row">
            <div className="first-run-step-main">
              <span className="first-run-step-marker" aria-hidden="true">{runStarted ? <CircleCheck /> : null}</span>
              <div>
                <strong>{t("setup.stepLaunch")}</strong>
                <p>{t("setup.stepLaunchDetail")}</p>
              </div>
            </div>
            <div className="first-run-step-actions">
              {!runStarted ? (
                <>
                  <button type="button" className="mini primary" disabled={!codex || busy === "codex"} onClick={() => onOpenTool("codex")}>
                    {t("run.openCodex")}
                  </button>
                  <button type="button" className="mini" disabled={!claude || busy === "claude"} onClick={() => onOpenTool("claude")}>
                    {t("run.openClaude")}
                  </button>
                </>
              ) : (
                <span className="first-run-done-label">{t("setup.statusDone")}</span>
              )}
            </div>
          </div>
        </li>
        <li className={loopActivityOk ? "done" : ""}>
          <div className="first-run-step-row">
            <div className="first-run-step-main">
              <span className="first-run-step-marker" aria-hidden="true">{loopActivityOk ? <CircleCheck /> : null}</span>
              <div>
                <strong>{t("setup.stepPrompt")}</strong>
                <p>{t("setup.stepPromptDetail")}</p>
              </div>
            </div>
            <div className="first-run-step-actions">
              {!loopActivityOk ? null : <span className="first-run-done-label">{t("setup.statusDone")}</span>}
            </div>
          </div>
        </li>
      </ol>
      <div className="first-run-guide-foot first-run-guide-foot--stacked">
        <div className="first-run-methods" aria-label="Capture methods">
          <div>
            <strong>{t("setup.methodHooks")}</strong>
            <span>{t("setup.methodHooksDetail")}</span>
          </div>
          <div>
            <strong>{t("setup.methodGateway")}</strong>
            <span>{t("setup.methodGatewayDetail")}</span>
          </div>
          <div>
            <strong>{t("setup.methodProxy")}</strong>
            <span>{t("setup.methodProxyDetail")}</span>
          </div>
        </div>
        <div className="first-run-advanced">
          <div>
            <strong>{t("setup.advancedTitle")}</strong>
            <p>{t("setup.advancedDetail")}</p>
          </div>
          <div className="first-run-step-actions">
            {!proxyOn ? (
              <button type="button" className="mini" disabled={proxyBusy} onClick={onStartProxy}>
                {t("setup.startProxy")}
              </button>
            ) : (
              <span className="first-run-done-label">{t("setup.statusDone")}</span>
            )}
            {!caOk ? (
              <button type="button" className="mini" onClick={() => onOpenSettingsSection("trust")}>
                {t("setup.openTrust")}
              </button>
            ) : null}
            <button type="button" className="mini" onClick={() => onOpenSettingsSection("proxy")}>
              {t("setup.openProxySettings")}
            </button>
            <button
              type="button"
              className="mini"
              onClick={() => copyText(listen?.startsWith("http") ? listen : `http://${listen || "127.0.0.1:8899"}`)}
            >
              {t("setup.copyListen")}
            </button>
          </div>
        </div>
        <p className="first-run-privacy"><strong>{t("setup.privacyTitle")}</strong> {t("setup.privacyDetail")}</p>
      </div>
    </section>
  );
}

function ActivityDashboard({
  files = [],
  activeFile,
  clientStats = [],
  proxyStatus,
  gatewayStatus,
  hookStatus,
  hookEvents,
  environment,
  native,
  busy,
  captureHealth,
  analytics,
  activeFlowCount,
  activeLoopSteps,
  loopModel,
  listen,
  onOpenTool,
  onStartProxy,
  onStopProxy,
  onRefreshFiles,
  onClearHistory,
  onSelectFile,
  onSourceFilterChange,
  onOpenSettings,
  onOpenSettingsSection,
}) {
  const { t } = useI18n();
  const activeRun = activeFile ? files.find((file) => file.name === activeFile) || null : null;
  const running = Boolean(proxyStatus?.running);
  const gatewayRunning = Boolean(gatewayStatus?.running);
  const hooksReady = Boolean(hookStatus?.receiver?.running);
  const health = captureHealth?.status || (activeRun ? "healthy" : "idle");
  const tokenTotal = loopUsageTotal(loopModel?.totals?.tokens) || analytics?.tokens?.total || 0;
  const toolTotal = Number(loopModel?.totals?.tools || 0) + Number(loopModel?.totals?.mcp || 0) + Number(loopModel?.totals?.skills || 0);
  const warningCount = healthChips(captureHealth).reduce((sum, chip) => sum + Number(chip.value || 0), 0)
    + Number(loopModel?.totals?.unmatched || 0);

  return (
    <section className="activity-dashboard">
      <PreviewModeHint native={native} />
      {native && (
        <FirstRunGuide
          listen={listen}
          proxyStatus={proxyStatus}
          hookStatus={hookStatus}
          environment={environment}
          hasActiveRun={Boolean(activeRun)}
          activeFlowCount={activeFlowCount}
          hookEventsTotal={Number(hookEvents?.total || hookStatus?.total_events || 0)}
          busy={busy}
          onStartProxy={onStartProxy}
          onOpenTool={onOpenTool}
          onOpenSettingsSection={onOpenSettingsSection}
        />
      )}
      <div className="activity-hero">
        <div className="activity-hero-copy">
          <span>{t("activity.title")}</span>
          <h2>{activeRun ? runTitle(activeRun) : t("activity.noRun")}</h2>
          <p>{t("activity.subtitle")}</p>
        </div>
        <RunActionPanel
          environment={environment}
          native={native}
          busy={busy}
          onOpenTool={onOpenTool}
        />
      </div>

      <div className="activity-status-row" aria-label={t("activity.status")}>
        <StatusPill label={t("activity.proxy")} value={running ? proxyStatus?.external ? t("value.external") : t("run.live") : t("run.idle")} active={running} />
        <StatusPill label={t("activity.gateway")} value={gatewayRunning ? gatewayStatus?.external ? t("value.external") : t("value.running") : t("run.idle")} active={gatewayRunning} />
        <StatusPill label={t("activity.hooks")} value={hooksReady ? t("hooks.events", { count: hookEvents?.total || hookStatus?.total_events || 0 }) : t("value.offline")} active={hooksReady} />
        <StatusPill label={t("activity.health")} value={activeRun ? healthLabel(captureHealth) || "Healthy" : "-"} tone={health} />
      </div>

      <div className="activity-section-head">
        <div>
          <h3>{t("activity.overview")}</h3>
          <p>{activeRun?.name || t("activity.noRun")}</p>
        </div>
        <button className="mini" onClick={onOpenSettings}>{t("activity.openSettings")}</button>
      </div>

      <div className="activity-grid">
        <ActivityMetricCard
          icon={ReceiptText}
          label={t("activity.currentRun")}
          value={activeRun ? compactRunName(activeRun.name) : "-"}
          detail={activeRun ? `${formatBytes(activeRun.size)} · ${formatTime(activeRun.modified)}` : t("activity.noRun")}
        />
        <ActivityMetricCard icon={Workflow} label={t("activity.loopSteps")} value={activeLoopSteps || 0} detail={t("activity.turns", { count: loopModel?.totals?.turns || 0 })} />
        <ActivityMetricCard icon={Bot} label={t("activity.toolsMcp")} value={toolTotal} detail={t("activity.hooksCount", { count: loopModel?.totals?.hooks || 0 })} />
        <ActivityMetricCard icon={Coins} label={t("activity.tokens")} value={formatTokenMetric(tokenTotal)} detail={t("activity.usageFlows", { count: analytics?.tokenFlows || 0 })} />
        <ActivityMetricCard icon={Network} label={t("activity.network")} value={activeFlowCount || 0} detail={t("activity.errorsCount", { count: analytics?.errors || 0 })} />
        <ActivityMetricCard icon={CircleAlert} label={t("activity.warnings")} value={warningCount || 0} detail={captureHealth ? healthLabel(captureHealth) : "-"} tone={warningCount ? "warn" : "ok"} />
      </div>

      <RecentRunsPanel
        files={files}
        activeFile={activeFile}
        clientStats={clientStats}
        proxyStatus={proxyStatus}
        busy={busy}
        activeFlowCount={activeFlowCount}
        activeLoopSteps={activeLoopSteps}
        captureHealth={captureHealth}
        onSelectFile={onSelectFile}
        onRefreshFiles={onRefreshFiles}
        onClearHistory={onClearHistory}
        onSourceFilterChange={onSourceFilterChange}
      />
    </section>
  );
}

function RunActionPanel({ environment, native, busy, onOpenTool }) {
  const { t } = useI18n();
  const tools = environment?.tools || [];
  const codex = tools.find((tool) => tool.id === "codex");
  const claude = tools.find((tool) => tool.id === "claude");
  const nativeDisabledTitle = native ? "" : t("native.disabledHint");
  return (
    <div className="run-action-panel">
      <span>{t("activity.launch")}</span>
      <div>
        <button
          className="primary"
          disabled={!native || busy === "codex" || !codex}
          onClick={() => onOpenTool("codex")}
          title={codex ? toolStatusLabel(codex, native) : nativeDisabledTitle}
        >
          {t("run.openCodex")}
        </button>
        <button
          className="secondary"
          disabled={!native || busy === "claude" || !claude}
          onClick={() => onOpenTool("claude")}
          title={claude ? toolStatusLabel(claude, native) : nativeDisabledTitle}
        >
          {t("run.openClaude")}
        </button>
      </div>
    </div>
  );
}

function StatusPill({ label, value, active = false, tone = "" }) {
  return (
    <div className={`status-pill ${active ? "active" : ""} ${tone}`}>
      <span className={`dot ${active ? "running" : ""}`} />
      <strong>{label}</strong>
      <em>{value}</em>
    </div>
  );
}

function ActivityMetricCard({ icon: Icon, label, value, detail, tone = "" }) {
  return (
    <article className={`activity-card ${tone}`}>
      <div className="activity-card-icon" aria-hidden="true">
        <Icon />
      </div>
      <span>{label}</span>
      <strong title={String(value)}>{value}</strong>
      <p title={String(detail || "")}>{detail || "-"}</p>
    </article>
  );
}

function RecentRunsPanel({
  files = [],
  activeFile,
  clientStats = [],
  proxyStatus,
  busy,
  activeFlowCount,
  activeLoopSteps,
  captureHealth,
  onSelectFile,
  onRefreshFiles,
  onClearHistory,
  onSourceFilterChange,
}) {
  const { t } = useI18n();
  const [open, setOpen] = useState(false);
  const [clearArmed, setClearArmed] = useState(false);
  const [clearFeedback, setClearFeedback] = useState("");
  const activeRun = activeFile ? files.find((file) => file.name === activeFile) || null : null;
  const historyFiles = files.filter((file) => file.name !== activeRun?.name);
  const activeRunSource = dominantClientLabel(clientStats);

  useEffect(() => {
    if (!clearArmed) return undefined;
    const id = window.setTimeout(() => setClearArmed(false), 3000);
    return () => window.clearTimeout(id);
  }, [clearArmed]);

  useEffect(() => {
    if (!clearFeedback) return undefined;
    const id = window.setTimeout(() => setClearFeedback(""), 1800);
    return () => window.clearTimeout(id);
  }, [clearFeedback]);

  async function handleClearHistory() {
    if (!clearArmed) {
      setClearFeedback("");
      setClearArmed(true);
      return;
    }
    setClearArmed(false);
    const removed = await onClearHistory();
    setClearFeedback(removed > 0 ? `Cleared ${removed}` : "Nothing to clear");
  }

  const clearing = busy === "clear-history";
  const localizedFeedback = clearFeedback.startsWith("Cleared ")
    ? t("run.cleared", { count: clearFeedback.replace("Cleared ", "") })
    : clearFeedback === "Nothing to clear"
      ? t("run.nothingToClear")
      : clearFeedback;
  const clearLabel = clearing ? t("run.clearing") : localizedFeedback || (clearArmed ? t("run.confirm") : t("run.clear"));

  return (
    <section className={`recent-runs-panel ${open ? "open" : ""}`}>
      <div className="activity-section-head">
        <button className="recent-runs-toggle" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
          <HistoryIcon aria-hidden="true" />
          <span>{t("activity.recentRuns")}</span>
          <strong>{historyFiles.length}</strong>
        </button>
        <div className="recent-run-actions">
          <button className="mini" onClick={onRefreshFiles}>{t("run.refresh")}</button>
          <button className="mini danger" disabled={historyFiles.length === 0 || clearing} onClick={handleClearHistory}>
            {clearLabel}
          </button>
        </div>
      </div>

      {open && (
        <>
          <div className="source-switch compact" aria-label="Capture source">
            {clientStats.map((source) => (
              <button key={source.key} onClick={() => onSourceFilterChange(source.key)}>
                <span>{source.label}</span>
                <strong>{source.count}</strong>
              </button>
            ))}
          </div>
          <div className="recent-run-grid">
            {historyFiles.length === 0 ? (
              <div className="empty small">{t("run.noPrevious")}</div>
            ) : historyFiles.map((file) => (
              <RunCard
                file={file}
                key={file.name}
                active={false}
                activeRunSource={activeRunSource}
                proxyStatus={proxyStatus}
                activeFlowCount={activeFlowCount}
                activeLoopSteps={activeLoopSteps}
                captureHealth={captureHealth}
                onSelectFile={onSelectFile}
              />
            ))}
          </div>
        </>
      )}
    </section>
  );
}

function LoopWorkbench({
  flows,
  filteredFlows,
  analytics,
  claudeSessionIndex,
  claudeSessionDetail,
  hookEvents,
  captureHealth,
  sourceFilter,
  native,
  environment,
  proxyStatus,
  busy,
  loopFocus,
  followLatest,
  onOpenTool,
  onRunHelper,
  onOpenNetworkFlow,
}) {
  const loopModel = useMemo(
    () => buildAgentLoopModel({ flows, claudeSessionDetail, sourceFilter, hookEvents: hookEvents?.events || [] }),
    [flows, claudeSessionDetail, hookEvents?.events, sourceFilter],
  );
  const [activeStepId, setActiveStepId] = useState(null);
  const [activeLoopTab, setActiveLoopTab] = useState("Summary");

  useEffect(() => {
    const visibleSteps = loopModel.steps.filter((step) => stepMatchesLoopFocus(step, loopFocus));
    if (!visibleSteps.length) {
      setActiveStepId(null);
      return;
    }
    setActiveStepId((current) => {
      if (followLatest) return latestLoopStep(visibleSteps)?.id || visibleSteps[0].id;
      return loopModel.steps.some((step) => step.id === current)
        && visibleSteps.some((step) => step.id === current) ? current
        : preferredLoopStep({ ...loopModel, steps: visibleSteps })?.id || visibleSteps[0].id;
    });
  }, [followLatest, loopFocus, loopModel.id]);

  const activeStep = loopModel.steps.find((step) => step.id === activeStepId) || preferredLoopStep(loopModel) || null;
  const tokenTotal = loopUsageTotal(loopModel.totals.tokens) || usageTotal(claudeSessionDetail?.session?.token_usage) || analytics.tokens.total;
  const issueCount = loopModel.totals.unmatched + loopModel.steps.filter((step) => step.status === "error").length;
  const exportPayload = {
    loop: loopModel,
    claude_session: claudeSessionDetail,
    hook_events: hookEvents,
    proxy_flows: flows,
  };

  return (
    <section className="loop-workbench">
      <CurrentRunSummary
        model={loopModel}
        captureHealth={captureHealth}
        tokenTotal={tokenTotal}
        issueCount={issueCount}
        session={claudeSessionDetail?.session}
        storageDir={claudeSessionIndex?.storage_dir}
        onExport={() => downloadText("looplens-ai-loop.json", JSON.stringify(exportPayload, null, 2), "application/json")}
      />

      <RunStoryCard
        model={loopModel}
        analytics={analytics}
        claudeSessionDetail={claudeSessionDetail}
        activeStepId={activeStep?.id}
        onSelectStep={setActiveStepId}
      />

      <LoopSignals
        model={loopModel}
        activeStep={activeStep}
        analytics={analytics}
        claudeSessionDetail={claudeSessionDetail}
        captureHealth={captureHealth}
        activeStepId={activeStep?.id}
        onSelectStep={setActiveStepId}
      />

      <CollapsibleHookEvidence
        hookEvents={hookEvents}
        model={loopModel}
        activeStepId={activeStep?.id}
        onSelectStep={setActiveStepId}
      />

      <div className="loop-workspace">
        <LoopRail
          model={loopModel}
          activeStepId={activeStep?.id}
          focus={loopFocus}
          native={native}
          environment={environment}
          proxyStatus={proxyStatus}
          busy={busy}
          onRunHelper={onRunHelper}
          onOpenTool={onOpenTool}
          onSelectStep={setActiveStepId}
        />
        <LoopInspector
          step={activeStep}
          activeTab={activeLoopTab}
          onTabChange={setActiveLoopTab}
          onOpenNetworkFlow={onOpenNetworkFlow}
        />
      </div>
    </section>
  );
}

function CurrentRunSummary({ model, captureHealth, tokenTotal, issueCount, session, storageDir, onExport }) {
  const { t } = useI18n();
  const hasRun = model.totals.steps > 0;
  const runName = compactRunName(captureHealth?.file || session?.file_name);
  const healthStatus = captureHealth?.status || "healthy";
  const statusLabel = !hasRun ? "Waiting" : issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : healthLabel(captureHealth) || "Healthy";
  const statusTone = !hasRun ? "idle" : issueCount || healthStatus === "broken" ? "bad" : healthStatus === "warnings" ? "warn" : "ok";
  const sessionLabel = session?.file_name ? "Session attached" : "Session pending";
  const summary = hasRun
    ? `${model.totals.turns} turns · ${model.totals.steps} steps · ${formatTokenMetric(tokenTotal)} tokens`
    : t("empty.startCapture");

  return (
    <div className="run-summary">
      <div className="run-summary-main">
        <span>{t("run.current")}</span>
        <h2 title={runName}>{runName}</h2>
        <p>{summary}</p>
      </div>
      <div className="run-summary-meta" aria-label="Current run summary">
        <span>{hasRun ? `${model.totals.hooks || 0} hooks` : "No steps yet"}</span>
        <span title={storageDir || ""}>{sessionLabel}</span>
        <strong className={`summary-status ${statusTone}`}>{statusLabel}</strong>
      </div>
      <button className="secondary" onClick={onExport}>{t("run.exportLoop")}</button>
    </div>
  );
}

function RunStoryCard({ model, analytics, claudeSessionDetail, activeStepId, onSelectStep }) {
  const { t } = useI18n();
  const attentionItems = loopAttentionItems(model);
  const primaryAttention = attentionItems[0] || null;
  const errors = model.steps.filter((step) => step.status === "error").length;
  const rateLimits = model.steps.filter((step) => step.type === "Rate Limit").length;
  const tokenTotal = loopUsageTotal(model.totals.tokens) || usageTotal(claudeSessionDetail?.session?.token_usage) || analytics?.tokens?.total || 0;
  const tokenSteps = model.steps
    .map((step) => ({ step, tokens: loopUsageTotal(step.tokens) }))
    .filter((item) => item.tokens > 0)
    .sort((a, b) => b.tokens - a.tokens);
  const largestTokenStep = tokenSteps[0] || null;
  const hasExpensiveStep = largestTokenStep?.tokens >= 10_000;
  let tone = "ok";
  let title = t("story.cleanTitle");
  let body = t("story.cleanBody", { turns: model.totals.turns, steps: model.totals.steps });
  let focusStep = primaryAttention?.step || null;

  if (!model.steps.length) {
    tone = "empty";
    title = t("story.waitingTitle");
    body = t("story.waitingBody");
  } else if (errors > 0) {
    tone = "bad";
    title = t("story.errorTitle");
    body = t("story.errorBody", { count: errors, plural: errors === 1 ? "" : "s" });
  } else if (rateLimits > 0) {
    tone = "warn";
    title = t("story.rateLimitTitle");
    body = t("story.rateLimitBody", { count: rateLimits, plural: rateLimits === 1 ? "" : "s" });
  } else if (model.totals.unmatched > 0) {
    tone = "warn";
    title = t("story.unmatchedTitle");
    body = t("story.unmatchedBody", { count: model.totals.unmatched, plural: model.totals.unmatched === 1 ? "" : "s" });
  } else if (hasExpensiveStep) {
    tone = "warn";
    title = t("story.expensiveTitle");
    body = t("story.expensiveBody", { tokens: formatTokenMetric(largestTokenStep.tokens) });
    focusStep = largestTokenStep.step;
  }

  const evidenceValue = t("story.evidenceValue", {
    hooks: model.totals.hooks || 0,
    network: model.totals.network || 0,
  });

  return (
    <section className={`run-story-card ${tone}`} aria-label={t("story.title")}>
      <div className="run-story-copy">
        <span>{t("story.title")}</span>
        <strong>{title}</strong>
        <p>{body}</p>
      </div>
      <div className="run-story-metrics">
        <div className="run-story-stat">
          <span>{t("story.turns")}</span>
          <strong>{model.totals.turns || 0}</strong>
        </div>
        <div className="run-story-stat">
          <span>{t("story.steps")}</span>
          <strong>{model.totals.steps || 0}</strong>
        </div>
        <div className="run-story-stat">
          <span>{t("story.tokens")}</span>
          <strong>{formatTokenMetric(tokenTotal)}</strong>
        </div>
        <div className="run-story-stat">
          <span>{t("story.evidence")}</span>
          <strong>{evidenceValue}</strong>
        </div>
      </div>
      <button
        type="button"
        className="mini"
        disabled={!focusStep}
        onClick={() => focusStep && onSelectStep(focusStep.id)}
        aria-pressed={focusStep?.id === activeStepId}
      >
        {focusStep ? t("story.focus") : t("story.noAction")}
      </button>
    </section>
  );
}

function compactRunName(name) {
  if (!name) return "New agent run";
  const text = String(name).split("/").at(-1)?.replace(/\.jsonl$/i, "") || String(name);
  const source = captureSourceLabel(text);
  const timestamp = text.match(/capture-(?:gateway-|codex-|claude-code-)?(\d{8})-(\d{6})/);
  if (timestamp) {
    const [, date, time] = timestamp;
    return `${source} ${date.slice(4, 6)}/${date.slice(6, 8)} ${time.slice(0, 2)}:${time.slice(2, 4)}`;
  }
  const epoch = text.match(/capture-(?:gateway-)?(\d{10,})/);
  const sourceEpoch = text.match(/capture-(?:gateway-|codex-|claude-code-)?(\d{10,})/);
  if (sourceEpoch) return `${source} ${formatTime(Number(sourceEpoch[1]) / 1000)}`;
  if (epoch) return `Run ${formatTime(Number(epoch[1]) / 1000)}`;
  return text;
}

function filterHookEventsForRun(hookEvents: AnyRecord = {}, activeFile, files = []) {
  const events = hookEvents?.events || [];
  if (!activeFile) {
    return {
      ...(hookEvents || EMPTY_HOOK_EVENTS),
      total: 0,
      global_total: hookEvents?.total || events.length,
      events: [],
    };
  }
  if (!events.length) return { ...(hookEvents || EMPTY_HOOK_EVENTS), total: 0, events: [] };
  const window = captureRunWindow(activeFile, files);
  const filtered = events.filter((event) => {
    if (event.capture_file) return event.capture_file === activeFile;
    if (!window) return true;
    const source = normalizeRunSource(event.run_source || event.source);
    if (window.source && source && source !== window.source) return false;
    const receivedAt = Number(event.received_at || 0);
    if (!receivedAt) return false;
    return receivedAt >= window.start - 8 && receivedAt < window.end + 8;
  });
  return {
    ...hookEvents,
    total: filtered.length,
    global_total: hookEvents?.total || events.length,
    events: filtered,
  };
}

function scopeClaudeSessionForRun(detail: AnyRecord = EMPTY_CLAUDE_SESSION_DETAIL, activeFile) {
  if (!activeFile || captureRunSource(activeFile) !== "claude-code") return EMPTY_CLAUDE_SESSION_DETAIL;
  const session = detail?.session;
  if (!session) return EMPTY_CLAUDE_SESSION_DETAIL;
  const start = captureStartSeconds(activeFile);
  const modified = Number(session.modified || 0);
  if (start && modified && modified < start - 15) return EMPTY_CLAUDE_SESSION_DETAIL;
  return detail;
}

function captureRunWindow(activeFile, files = []) {
  const start = captureStartSeconds(activeFile);
  if (!start) return null;
  const source = captureRunSource(activeFile);
  const laterStarts = files
    .map((file) => captureStartSeconds(file.name || file))
    .filter((value) => value && value > start)
    .sort((a, b) => a - b);
  return {
    source,
    start,
    end: laterStarts[0] || Number.POSITIVE_INFINITY,
  };
}

function captureRunSource(name = "") {
  if (String(name).startsWith("capture-codex-")) return "codex";
  if (String(name).startsWith("capture-claude-code-")) return "claude-code";
  if (String(name).startsWith("capture-gateway-")) return "gateway";
  return null;
}

function normalizeRunSource(source = "") {
  const value = String(source || "").toLowerCase().replaceAll("_", "-");
  if (value.includes("claude")) return "claude-code";
  if (value.includes("codex")) return "codex";
  if (value.includes("gateway")) return "gateway";
  return value || null;
}

function captureStartSeconds(name = "") {
  const text = String(name).split("/").at(-1) || String(name);
  const epoch = text.match(/capture-(?:gateway-|codex-|claude-code-)?(\d{10,})(?:-\d+)?\.jsonl$/);
  if (epoch) {
    const value = Number(epoch[1]);
    return value > 1_000_000_000_000 ? value / 1000 : value;
  }
  const timestamp = text.match(/capture-(?:gateway-|codex-|claude-code-)?(\d{8})-(\d{6})/);
  if (!timestamp) return null;
  const [, date, time] = timestamp;
  const parsed = new Date(
    `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}T${time.slice(0, 2)}:${time.slice(2, 4)}:${time.slice(4, 6)}`,
  ).getTime();
  return Number.isFinite(parsed) ? parsed / 1000 : null;
}

function captureSourceLabel(name) {
  if (name.startsWith("capture-codex-")) return "Codex run";
  if (name.startsWith("capture-claude-code-")) return "Claude Code run";
  if (name.startsWith("capture-gateway-")) return "Gateway run";
  return "Run";
}

function LoopSignals({ model, activeStep, analytics, claudeSessionDetail, captureHealth, activeStepId, onSelectStep }) {
  const hasHealthSignals = healthChips(captureHealth).length > 0;
  const hasAttentionSignals = loopAttentionItems(model).length > 0;
  const hasInsight = model.steps.length > 0 && loopInsightTone(model) !== "good";

  if (!hasHealthSignals && !hasAttentionSignals && !hasInsight) return null;

  return (
    <div className="loop-signals">
      <CaptureHealthStrip health={captureHealth} />
      <LoopInsight model={model} activeStep={activeStep} analytics={analytics} claudeSessionDetail={claudeSessionDetail} />
      <LoopAttentionBar model={model} activeStepId={activeStepId} onSelectStep={onSelectStep} />
    </div>
  );
}

function loopInsightTone(model) {
  if (!model.steps.length) return "empty";
  if (model.steps.some((step) => step.status === "error")) return "bad";
  if (model.steps.some((step) => step.type === "Rate Limit")) return "warn";
  if (model.totals.unmatched > 0) return "warn";
  return "good";
}

function LoopInsight({ model, activeStep, analytics, claudeSessionDetail }) {
  const errorCount = model.steps.filter((step) => step.status === "error").length;
  const rateLimitCount = model.steps.filter((step) => step.type === "Rate Limit").length;
  const tokenTotal = loopUsageTotal(model.totals.tokens) || usageTotal(claudeSessionDetail?.session?.token_usage) || analytics?.tokens?.total || 0;
  const toolNodes = model.totals.tools + model.totals.mcp + model.totals.skills;
  let tone = "good";
  let label = "Loop ready";
  let message = `${model.totals.turns} turns, ${toolNodes} tool/MCP/skill steps, ${formatTokenMetric(tokenTotal)} tokens.`;

  if (!model.steps.length) return null;

  if (errorCount > 0) {
    tone = "bad";
    label = "Errors need attention";
    message = `${errorCount} error step${errorCount === 1 ? "" : "s"} found. Select red nodes in the Loop Rail first.`;
  } else if (rateLimitCount > 0) {
    tone = "warn";
    label = "Rate limit changed the path";
    message = `${rateLimitCount} rate-limit event${rateLimitCount === 1 ? "" : "s"} detected. Inspect retry and wait behavior.`;
  } else if (model.totals.unmatched > 0) {
    tone = "warn";
    label = "Correlation incomplete";
    message = `${model.totals.unmatched} unmatched step${model.totals.unmatched === 1 ? "" : "s"} remain. Check Raw or Network evidence.`;
  }

  if (tone === "good") return null;

  return (
    <div className={`loop-insight ${tone}`}>
      <span className="loop-insight-marker" aria-hidden="true" />
      <div>
        <strong>{label}</strong>
        <p>{message}</p>
      </div>
      <em>{activeStep ? `Focus: ${activeStep.type}` : "No focus"}</em>
    </div>
  );
}

function CaptureHealthStrip({ health }) {
  const chips = healthChips(health);
  if (!chips.length) return null;
  return (
    <div className={`capture-health-strip ${health.status}`}>
      <strong>{healthLabel(health)}</strong>
      <div>
        {chips.map((chip) => (
          <span key={chip.label}>{chip.value} {chip.label}</span>
        ))}
      </div>
    </div>
  );
}

function CollapsibleHookEvidence({ hookEvents, model, activeStepId, onSelectStep }) {
  const events = hookEvents?.events || [];
  const [open, setOpen] = useState(false);
  if (!events.length) return null;
  const hookStepIds = new Set(model.steps.filter((step) => isHookStep(step)).map((step) => step.id));
  const visibleEvents = stableHookEvidenceEvents(events, activeStepId, hookStepIds);
  return (
    <div className={`hook-evidence-strip ${open ? "open" : ""}`} aria-label="Captured hook events">
      <button className="hook-evidence-summary" type="button" onClick={() => setOpen((value) => !value)} aria-expanded={open}>
        <strong>Hooks captured</strong>
        <span>{hookEvents.total || events.length} official events</span>
        <em>{open ? "Hide" : "Show"}</em>
      </button>
      {open && (
        <div className="hook-evidence-list">
          {visibleEvents.map((event) => (
            <button
              className={`${event.id === activeStepId ? "active" : ""} ${event.pinned ? "pinned" : ""}`}
              disabled={!event.visible}
              key={event.id}
              type="button"
              onClick={() => onSelectStep(event.id)}
              title={`${event.event_name} · ${event.id}`}
            >
              <strong>{event.event_name}</strong>
              <span>{event.source}{eventPrimaryDetail(event) ? ` · ${eventPrimaryDetail(event)}` : ""}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function stableHookEvidenceEvents(events = [], activeStepId, hookStepIds) {
  const latest = events.slice(-7);
  const latestIds = new Set(latest.map((event) => event.id));
  const activeEvent = activeStepId && !latestIds.has(activeStepId)
    ? events.find((event) => event.id === activeStepId)
    : null;
  const display = activeEvent ? [activeEvent, ...latest.slice(-6)] : latest;
  const seen = new Set();
  return display
    .filter((event) => {
      if (!event?.id || seen.has(event.id)) return false;
      seen.add(event.id);
      return true;
    })
    .map((event) => ({
      ...event,
      pinned: event.id === activeEvent?.id,
      visible: hookStepIds.has(event.id),
    }));
}

function eventPrimaryDetail(event: AnyRecord = {}) {
  return event.tool_name
    || event.mcp_server_name
    || event.task_subject
    || event.file_path
    || event.worktree_name
    || event.memory_type
    || event.prompt
    || event.message
    || event.last_assistant_message
    || event.hook_source
    || event.model
    || event.session_id;
}

function eventSecondaryDetail(event: AnyRecord = {}) {
  return event.cwd
    || event.transcript_path
    || event.tool_use_id
    || event.reason
    || event.decision
    || event.trigger
    || event.load_reason
    || event.permission_mode
    || event.notification_type
    || event.file_event
    || event.action
    || event.agent_type
    || event.team_name
    || formatTime(event.received_at);
}

function eventPayloadPreview(event: AnyRecord = {}) {
  return event.payload_preview
    || event.prompt
    || event.message
    || event.last_assistant_message
    || event.compact_summary
    || event.custom_instructions
    || event.error
    || event.reason
    || (event.raw ? JSON.stringify(event.raw) : "");
}

function LoopAttentionBar({ model, activeStepId, onSelectStep }) {
  const items = loopAttentionItems(model);
  if (!items.length) return null;
  return (
    <div className="loop-attention" aria-label="Attention needed">
      <span>Attention</span>
      <div>
        {items.map((item) => (
          <button
            className={item.step.id === activeStepId ? "active" : ""}
            key={`${item.reason}:${item.step.id}`}
            onClick={() => onSelectStep(item.step.id)}
            title={item.detail}
          >
            <strong>{item.label}</strong>
            <em>{item.step.title}</em>
          </button>
        ))}
      </div>
    </div>
  );
}

function humanWhyNext(step) {
  if (!step) return "No transition explanation available.";
  if (step.status === "error") return "This step failed, so the next model step usually has to recover, retry, or explain the failure.";
  if (step.status === "unmatched") return "LoopLens could not pair this event confidently, so inspect Raw or Network before drawing conclusions.";
  if (step.type === "Model Step" && step.output?.includes("(")) return "The assistant emitted tool_use blocks, so Claude Code should execute tools before the next model step.";
  if (step.type === "Tool Result" && step.parentId) return "This result is fed back into the conversation and can directly shape the next model message.";
  if (step.type === "Tool Result" && !step.parentId) return "This result has no matched tool_use, so the execution chain may be incomplete.";
  if (step.type === "MCP") return "An MCP tool was invoked; check the result payload to see what external context entered the loop.";
  if (step.type === "Skill") return "A skill entered the loop; inspect input and output to see what specialized workflow was activated.";
  if (step.type === "Network Flow" && step.confidence === "low") return "This network flow is related evidence, but attribution confidence is low.";
  return step.whyNext || "No transition explanation available.";
}

function loopAttentionItems(model) {
  const tokenValues = model.steps.map((step) => loopUsageTotal(step.tokens)).filter((value) => value > 0);
  const maxTokens = Math.max(...tokenValues, 0);
  return model.steps
    .map((step) => {
      const reason = attentionReason(step, maxTokens);
      if (!reason) return null;
      return { step, ...reason };
    })
    .filter(Boolean)
    .sort((a, b) => attentionRank(a.reason) - attentionRank(b.reason) || timeValue(a.step.timestamp) - timeValue(b.step.timestamp))
    .slice(0, 5);
}

function attentionReason(step, maxTokens = 0) {
  const tokens = loopUsageTotal(step.tokens);
  if (step.status === "error") {
    return {
      reason: "error",
      label: "Error",
      detail: "This step failed or returned a tool error.",
    };
  }
  if (step.status === "unmatched") {
    return {
      reason: "unmatched",
      label: "Unmatched",
      detail: "LoopLens could not confidently pair this step with its expected counterpart.",
    };
  }
  if (step.type === "Rate Limit") {
    return {
      reason: "rate-limit",
      label: "Rate limit",
      detail: "This event likely delayed, retried, or changed the next model request.",
    };
  }
  if (step.type === "Compact") {
    return {
      reason: "compact",
      label: "Compact",
      detail: "Context compaction can change what the model remembers next.",
    };
  }
  if (tokens > 0 && maxTokens > 0 && tokens === maxTokens && tokens >= 10_000) {
    return {
      reason: "expensive",
      label: formatTokenMetric(tokens),
      detail: "This is the largest token-consuming step in the current run.",
    };
  }
  if ((step.networkFlows || []).some((flow) => Number(flow.status) >= 400)) {
    return {
      reason: "network",
      label: "HTTP error",
      detail: "A related network flow returned an error status.",
    };
  }
  return null;
}

function attentionRank(reason) {
  return {
    error: 0,
    "rate-limit": 1,
    unmatched: 2,
    network: 3,
    compact: 4,
    expensive: 5,
  }[reason] ?? 9;
}

function timeValue(value) {
  if (!value) return 0;
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function preferredLoopStep(model) {
  return model.steps.find((step) => step.type === "Model Step")
    || model.steps.find((step) => ["Tool Batch", "Tool", "MCP", "Skill"].includes(step.type))
    || model.steps[0]
    || null;
}

function latestLoopStep(steps = []) {
  return [...steps].sort((a, b) => timeValue(b.timestamp) - timeValue(a.timestamp))[0] || null;
}

function stepMatchesLoopFocus(step, focus) {
  if (!focus || focus === "All") return true;
  if (focus === "Attention") return Boolean(attentionReason(step));
  if (focus === "Hooks") return isHookStep(step);
  if (focus === "Errors") return step.status === "error";
  if (focus === "Tools") return ["Tool Batch", "Tool", "Tool Result", "MCP", "Skill", "Permission"].includes(step.type);
  if (focus === "Expensive") return loopUsageTotal(step.tokens) > 0 || Number(step.tokens?.costUSD || 0) > 0;
  return true;
}

function isHookStep(step) {
  return String(step?.id || "").startsWith("hook:") || Boolean(step?.meta?.source);
}

function filteredTurnsForFocus(model, focus) {
  if (!focus || focus === "All") return model.turns;
  return model.turns
    .map((turn) => ({ ...turn, steps: turn.steps.filter((step) => stepMatchesLoopFocus(step, focus)) }))
    .filter((turn) => turn.steps.length > 0);
}

function LoopRail({
  model,
  activeStepId,
  focus,
  native,
  environment,
  proxyStatus,
  busy,
  onRunHelper,
  onOpenTool,
  onSelectStep,
}) {
  const visibleTurns = filteredTurnsForFocus(model, focus);
  if (!model.turns.length || model.steps.length === 0) {
    return (
      <section className="loop-rail-panel">
        <LoopOnboardingCard
          native={native}
          environment={environment}
          proxyStatus={proxyStatus}
          busy={busy}
          onRunHelper={onRunHelper}
          onOpenTool={onOpenTool}
        />
      </section>
    );
  }
  if (!visibleTurns.length) {
    return (
      <section className="loop-rail-panel">
        <div className="empty-state compact">
          <h2>No {focus.toLowerCase()} steps</h2>
          <p>Switch the Loop focus back to All, or continue the run until matching steps appear.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="loop-rail-panel" aria-label="AI loop rail">
      {visibleTurns.map((turn) => {
        const turnLabel = `Turn ${turn.index}`;
        const title = turn.title && turn.title !== turnLabel ? turn.title : `${turn.steps.length} steps`;
        const tokenLabel = formatLoopTokens(turn.tokens);
        const showTokens = tokenLabel && tokenLabel !== "unknown";
        return (
          <article className={`loop-turn ${stepStatusClass(turn.status)}`} key={turn.id}>
            <div className="loop-turn-head">
              <span>{turnLabel}</span>
              <strong title={title}>{title}</strong>
              {showTokens ? <em>{tokenLabel}</em> : <em aria-hidden="true" />}
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
        );
      })}
    </section>
  );
}

function LoopOnboardingCard({ native, environment, proxyStatus, busy, onRunHelper, onOpenTool }) {
  const { t } = useI18n();
  const setupItems = setupChecklistItems(environment, native, t);
  const blockers = setupItems.filter((item) => !item.ready && !item.optional);
  const firstAction = blockers.find((item) => item.action && !item.actionDisabled);
  return (
    <div className="loop-onboarding">
      <div className="onboarding-head">
        <span>{t("onboarding.path")}</span>
        <h2>{t("onboarding.title")}</h2>
        <p>{t("onboarding.body")}</p>
        {blockers.length > 0 ? <p className="loop-onboarding-crosslink">{t("setup.activityChecklistHint")}</p> : null}
      </div>

      <div className="onboarding-steps">
        <div className="onboarding-step">
          <strong>1</strong>
          <div>
            <h3>{t("onboarding.finishSetup")}</h3>
            <p>{blockers.length ? t("onboarding.setupNeeds", { count: blockers.length, plural: blockers.length === 1 ? "" : "s" }) : t("onboarding.ready")}</p>
          </div>
          {firstAction && (
            <button
              className="secondary"
              disabled={!native || busy === firstAction.busyKey}
              onClick={() => onRunHelper(firstAction.action)}
            >
              {firstAction.actionLabel}
            </button>
          )}
        </div>
        <div className="onboarding-step">
          <strong>2</strong>
          <div>
            <h3>{t("onboarding.openTool")}</h3>
            <p>{t("onboarding.openToolBody")}</p>
          </div>
          <div className="onboarding-actions">
            <button className="primary" disabled={!native || busy === "codex"} onClick={() => onOpenTool("codex")}>{t("run.openCodex")}</button>
            <button className="secondary" disabled={!native || busy === "claude"} onClick={() => onOpenTool("claude")}>{t("run.openClaude")}</button>
          </div>
        </div>
        <div className="onboarding-step passive">
          <strong>3</strong>
          <div>
            <h3>{t("onboarding.sendPrompt")}</h3>
            <p>{t("onboarding.sendPromptBody")}</p>
          </div>
        </div>
        <div className="onboarding-step passive">
          <strong>4</strong>
          <div>
            <h3>{t("onboarding.watchLoop")}</h3>
            <p>{proxyStatus?.running ? t("onboarding.liveRunning") : t("onboarding.followAfterLaunch")}</p>
          </div>
        </div>
      </div>
      {!native && <p className="disabled-reason">{t("onboarding.nativeDisabled")}</p>}
    </div>
  );
}

function LoopInspector({ step, activeTab, onTabChange, onOpenNetworkFlow }) {
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
        <span>Causality</span>
        <strong>{humanWhyNext(step)}</strong>
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
        {activeTab === "Network" && <LoopNetworkTab step={step} onOpenNetworkFlow={onOpenNetworkFlow} />}
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
      <Info label="Attention" value={attentionReason(step)?.detail || "No obvious issue"} />
      <Info label="Tokens" value={formatLoopTokens(step.tokens)} />
      <ListInfo label="Related steps" items={step.relatedIds || []} />
      <ListInfo label="Network flows" items={(step.networkFlows || []).map((flow) => `#${flow.id} ${flow.host || ""}`)} />
      <Info label="Model" value={step.meta?.model} />
      <Info label="Stop reason" value={step.meta?.stopReason} />
      <Info label="Tool name" value={step.meta?.toolName} />
      <Info label="Hook source" value={step.meta?.source} />
      <Info label="Hook event" value={step.meta?.eventName} />
      <Info label="Hook session" value={step.meta?.sessionId} />
      <Info label="Hook origin" value={step.meta?.hookSource} />
      <Info label="Hook CWD" value={step.meta?.cwd} />
      <Info label="Transcript" value={step.meta?.transcriptPath} />
      <Info label="Permission mode" value={step.meta?.permissionMode} />
      <Info label="Decision" value={step.meta?.decision} />
      <Info label="Reason" value={step.meta?.reason} />
      <Info label="Prompt" value={step.meta?.prompt} />
      <Info label="Message" value={step.meta?.message} />
      <Info label="Last assistant" value={step.meta?.lastAssistantMessage} />
      <Info label="Error" value={step.meta?.error} />
      <Info label="Agent" value={[step.meta?.agentType, step.meta?.agentId].filter(Boolean).join(" · ")} />
      <Info label="MCP server" value={step.meta?.mcpServerName} />
      <Info label="Elicitation" value={step.meta?.elicitationId} />
      <Info label="File" value={step.meta?.filePath} />
      <Info label="File event" value={step.meta?.fileEvent} />
      <Info label="Instructions" value={[step.meta?.memoryType, step.meta?.loadReason].filter(Boolean).join(" · ")} />
      <Info label="Trigger file" value={step.meta?.triggerFilePath} />
      <Info label="Parent file" value={step.meta?.parentFilePath} />
      <Info label="CWD change" value={[step.meta?.oldCwd, step.meta?.newCwd].filter(Boolean).join(" -> ")} />
      <Info label="Worktree" value={[step.meta?.worktreeName, step.meta?.worktreePath].filter(Boolean).join(" · ")} />
      <Info label="Task" value={[step.meta?.taskSubject, step.meta?.taskId].filter(Boolean).join(" · ")} />
      <Info label="Team" value={[step.meta?.teamName, step.meta?.teammateName].filter(Boolean).join(" · ")} />
      <Info label="Custom instructions" value={step.meta?.customInstructions} />
      <Info label="Compact summary" value={step.meta?.compactSummary} />
      <Info label="Notification" value={step.meta?.notificationType} />
      <Info label="Permission suggestions" value={step.meta?.permissionSuggestions ? JSON.stringify(step.meta.permissionSuggestions) : null} />
      <Info label="Payload size" value={step.meta?.payloadSize ? formatBytes(step.meta.payloadSize) : null} />
      <Info label="MCP category" value={step.meta?.mcpCategory} />
    </div>
  );
}

function LoopNetworkTab({ step, onOpenNetworkFlow }) {
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
            {flow.correlation?.confidence && <span className={`confidence ${flow.correlation.confidence}`}>{flow.correlation.confidence}</span>}
            <span>{flow.semantic?.category || flow.provider}</span>
            <span>{flow.chunk_count || 0} chunks</span>
            <span>{formatBytes(flow.total_chunk_bytes || flow.request_size)}</span>
            {usageTotal(flow.semantic?.token_usage) > 0 && <span>{formatTokenUsage(flow.semantic.token_usage)}</span>}
          </div>
          {flow.correlation?.reasons?.length > 0 && (
            <div className="correlation-reasons">
              {flow.correlation.reasons.map((reason) => <span key={reason}>{reason}</span>)}
            </div>
          )}
          <button className="mini" onClick={() => onOpenNetworkFlow?.(flow.id)}>Open in Network</button>
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
    <section className="analysis-panel timeline-workbench">
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

function TokensWorkbench({ analytics, claudeSessionDetail, hookEvents }) {
  const loopModel = buildAgentLoopModel({ flows: [], claudeSessionDetail, hookEvents: hookEvents?.events || [], sourceFilter: "all" });
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
        <div className="list-card session-usage-card">
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

function RawWorkbench({ file, flows, captureHealth, claudeSessionDetail, hookEvents }) {
  const raw = {
    capture_file: file,
    capture_health: captureHealth,
    flow_summaries: flows,
    claude_session: claudeSessionDetail,
    hook_events: hookEvents,
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
      <DiagnosticsPanel health={captureHealth} />
      <HookEventsPanel hookEvents={hookEvents} />
      <CodeBlock value={JSON.stringify(raw, null, 2)} />
    </section>
  );
}

function HookEventsPanel({ hookEvents }) {
  const events = hookEvents?.events || [];
  return (
    <div className="diagnostics-panel healthy">
      <div className="diagnostics-panel-head">
        <strong>Hook Events</strong>
        <span>{hookEvents?.total || 0}</span>
      </div>
      {events.length ? (
        <div className="hook-events-list">
          {events.slice(-12).map((event) => (
            <details className="hook-event-row" key={event.id}>
              <summary>
                <div className="hook-event-row-head">
                  <span>{event.source}</span>
                  <strong>{event.event_name}</strong>
                  <em>{formatTime(event.received_at)}</em>
                </div>
                <div className="hook-event-row-main">
                  <strong title={String(eventPrimaryDetail(event) || "")}>{eventPrimaryDetail(event) || event.session_id || "-"}</strong>
                  <span title={String(eventSecondaryDetail(event) || "")}>{eventSecondaryDetail(event) || "-"}</span>
                </div>
                <p title={eventPayloadPreview(event)}>{eventPayloadPreview(event)}</p>
                <div className="hook-event-row-meta">
                  {event.model && <span>{event.model}</span>}
                  {event.permission_mode && <span>{event.permission_mode}</span>}
                  {event.decision && <span>{event.decision}</span>}
                  {event.reason && <span>{event.reason}</span>}
                  {event.trigger && <span>{event.trigger}</span>}
                  {event.load_reason && <span>{event.load_reason}</span>}
                  {event.notification_type && <span>{event.notification_type}</span>}
                  {event.file_event && <span>{event.file_event}</span>}
                  {event.tool_use_id && <span>{event.tool_use_id}</span>}
                  {event.payload_size ? <span>{formatBytes(event.payload_size)}</span> : null}
                </div>
              </summary>
              <div className="hook-event-row-detail">
                <div className="hook-event-row-detail-actions">
                  <button className="mini" onClick={() => copyText(JSON.stringify(event, null, 2))}>Copy JSON</button>
                </div>
                <CodeBlock value={JSON.stringify(event, null, 2)} />
              </div>
            </details>
          ))}
        </div>
      ) : (
        <div className="empty small">No hook events captured yet.</div>
      )}
    </div>
  );
}

function DiagnosticsPanel({ health }) {
  if (!health) return null;
  return (
    <div className={`diagnostics-panel ${health.status}`}>
      <div className="diagnostics-panel-head">
        <strong>{healthLabel(health)}</strong>
        <span>{health.valid_lines}/{health.total_lines} valid lines</span>
        <span>{health.flow_count} flows</span>
      </div>
      {health.diagnostics?.length > 0 ? (
        <div className="diagnostic-rows">
          {health.diagnostics.map((item, index) => (
            <div className={`diagnostic-row ${item.severity}`} key={`${item.code}-${item.flow_id || "line"}-${index}`}>
              <span>{item.severity}</span>
              <strong>{item.code}</strong>
              <p>{item.message}</p>
            </div>
          ))}
        </div>
      ) : (
        <div className="empty small">No capture diagnostics.</div>
      )}
    </div>
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

function TokenDashboard({ analytics }) {
  const tokens = analytics.tokens || {};
  const total = Number(tokens.total || 0);
  const cost = computeEstimatedCost(analytics);
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
        <p>{analytics.tokenFlows || 0} flows reported usage{cost > 0 ? ` · Est. ${formatCostUSD(cost)}` : ""}</p>
      </div>
      <div className="token-bars">
        {segments.length ? segments.map(([label, value, tone]) => (
          <div className="token-bar-row" key={label}>
            <span>{label}</span>
            <div className="token-bar-track">
              <div
                className={`token-bar-fill ${tone}`}
                style={{ "--token-width": `${Math.max(2, (Number(value) / total) * 100)}%` } as CssVars}
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
            <div style={{ "--token-width": `${Math.max(3, (item.total / max) * 100)}%` } as CssVars} />
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

function formatTokenUsage(usage: AnyRecord = {}) {
  const total = usageTotal(usage);
  if (!total && !usage.input_tokens && !usage.output_tokens) return "unknown";
  return [
    total ? `${formatLargeNumber(total)} total` : null,
    usage.input_tokens ? `${formatLargeNumber(usage.input_tokens)} in` : null,
    usage.output_tokens ? `${formatLargeNumber(usage.output_tokens)} out` : null,
    usage.cached_input_tokens ? `${formatLargeNumber(usage.cached_input_tokens)} cached` : null,
    usage.reasoning_output_tokens ? `${formatLargeNumber(usage.reasoning_output_tokens)} reasoning` : null,
  ].filter(Boolean).join(" · ");
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

function formatGatewayRetries(semantic: AnyRecord = {}) {
  if (!semantic?.gateway_provider && !semantic?.upstream_url) return "-";
  const retries = Number(semantic.retry_count || 0);
  const attempts = Number(semantic.attempt_count || retries + 1);
  return retries > 0 ? `${retries} retry · ${attempts} attempts` : "no retry";
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

function copyText(text) {
  if (navigator.clipboard?.writeText) {
    navigator.clipboard.writeText(text).catch(() => {});
  }
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
