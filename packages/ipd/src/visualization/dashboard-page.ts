import { DASHBOARD_SCRIPT, DASHBOARD_STYLE } from "./dashboard-assets.generated.ts";
import type { DashboardSnapshot } from "./dashboard-model.ts";

export interface DashboardPageOptions {
	title?: string;
	runId: string;
	liveEndpoint?: string;
	snapshotUrl?: string;
	initialSnapshot?: DashboardSnapshot;
}

export function renderDashboardPage(options: DashboardPageOptions): string {
	const initial = options.initialSnapshot ? safeJson(options.initialSnapshot) : "null";
	const liveEndpoint = safeJson(options.liveEndpoint ?? null);
	const snapshotUrl = safeJson(options.snapshotUrl ?? null);
	const title = escapeHtml(options.title ?? "IPD 运行看板");
	return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width,initial-scale=1" />
<title>${title}</title>
<style>
${DASHBOARD_STYLE}
</style>
</head>
<body>
<div class="shell">
  <div class="top"><div><div class="eyebrow">IPD 实时看板</div><div class="title">IPD 运行看板</div><div class="sub" id="run-subtitle">运行 ${escapeHtml(options.runId)}</div></div><div class="actions"><span class="live" id="live-indicator"><span class="dot"></span><span id="live-label">快照</span></span><button class="btn" id="refresh-btn">刷新</button><a class="btn hidden" id="snapshot-btn" href="#">下载当前快照</a></div></div>
  <div class="card"><div class="stages" id="stages"></div><div id="run-failure"></div></div>
  <div class="grid"><section class="card task-card"><div class="section-title"><h2>用户任务</h2><span class="meta" id="task-meta"></span></div><div class="task-markdown scroll-panel" id="task-text">等待任务输入……</div><div id="task-detail"></div></section><section class="card"><div class="section-title"><h2>IPD Selection</h2><span id="selection-status"></span></div><div id="selection-body" class="empty">等待 IPD 完成流程选择……</div></section></div>
  <section class="card" style="margin-top:14px"><div class="workflow-head"><div><div class="section-title" style="margin:0"><h2>工作流设计与执行</h2></div><div class="meta" id="workflow-meta">等待工作流设计……</div></div><div class="metrics" id="workflow-metrics"></div></div><div class="graph-wrap" id="graph-wrap"><div class="empty">设计器创建节点后将在这里显示工作流。</div></div><div class="legend"><span><i></i>前向依赖</span><span><i class="rework"></i>评审返工路径</span><span>点击节点查看详情</span></div><div class="node-detail card" id="node-detail"></div></section>
  <section class="card" style="margin-top:14px"><div class="section-title"><h2>运行事件</h2><span class="meta" id="event-meta"></span></div><div class="events" id="events"><div class="empty">暂无事件。</div></div></section><div class="foot" id="generated-at"></div>
</div>
<script>
${DASHBOARD_SCRIPT}
IpdDashboard.startDashboard({liveEndpoint: ${liveEndpoint}, snapshotUrl: ${snapshotUrl}, initialSnapshot: ${initial}});
</script>
</body>
</html>`;
}

function safeJson(value: unknown): string {
	return JSON.stringify(value).replaceAll("<", "\\u003c").replaceAll(">", "\\u003e").replaceAll("&", "\\u0026");
}

function escapeHtml(value: string): string {
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
}
