// 实时页面和离线快照共用的客户端，仅读取版本化看板投影。

import { renderMarkdown } from "./dashboard-markdown.ts";
import type { DashboardEdge, DashboardNode, DashboardSnapshot } from "./dashboard-model.ts";
export interface DashboardClientOptions {
	liveEndpoint?: string | null;
	snapshotUrl?: string | null;
	initialSnapshot?: DashboardSnapshot | null;
}
function element<T extends HTMLElement = HTMLElement>(id: string): T {
	const value = document.getElementById(id);
	if (!value) throw new Error(`Missing dashboard element: ${id}`);
	return value as T;
}
export function startDashboard(options: DashboardClientOptions): void {
	const LIVE_ENDPOINT = options.liveEndpoint;
	const SNAPSHOT_URL = options.snapshotUrl;
	let currentData = options.initialSnapshot;
	let selectedNodeId: string | null = null;
	let selectionApplicabilityOpen = false;

	const PHASES = [
		["intake", "任务受理"],
		["selection", "IPD 选择"],
		["design", "工作流设计"],
		["compile", "编译"],
		["execute", "执行"],
		["closed", "结束"],
	];
	const PHASE_LABELS: Record<string, string> = {
		intake: "任务受理",
		selection: "IPD 选择",
		design: "工作流设计",
		compile: "编译",
		execute: "执行",
		closed: "结束",
	};
	const STATUS_LABELS: Record<string, string> = {
		pending: "等待选择",
		running: "运行中",
		paused: "已暂停",
		blocked: "已阻塞",
		succeeded: "已成功",
		failed: "已失败",
		cancelled: "已取消",
		planned: "待安排",
		waiting: "等待中",
		ready: "已就绪",
		active: "执行中",
		waiting_review: "等待评审",
		waiting_rework: "等待返工",
	};
	const EVENT_LABELS: Record<string, string> = {
		process_selected: "流程已选择",
		process_staffing_checked: "人员配置已检查",
		workflow_draft_validated: "工作流草稿已校验",
		workflow_designed: "工作流已设计",
		workflow_compiled: "工作流已编译",
		round_started: "工作轮次开始",
		round_submitted: "工作轮次已提交",
		review_recorded: "评审已记录",
		node_succeeded: "节点已完成",
		node_blocked: "节点已阻塞",
		run_succeeded: "运行已成功",
		run_failed: "运行已失败",
		run_cancelled: "运行已取消",
		run_paused: "运行已暂停",
		run_resumed: "运行已继续",
		work_progress_saved: "工作进度已保存",
		resource_cleanup: "资源清理",
		cleanup_failed: "清理未完成",
	};
	const esc = (value: unknown) =>
		String(value ?? "").replace(/[&<>"']/g, (ch) =>
			ch.charCodeAt(0) === 38
				? "&amp;"
				: ch.charCodeAt(0) === 60
					? "&lt;"
					: ch.charCodeAt(0) === 62
						? "&gt;"
						: ch.charCodeAt(0) === 34
							? "&quot;"
							: "&#39;",
		);
	const statusClass = (value: string) =>
		"status s-" +
		String(value || "planned")
			.replace(/[^a-z_]/gi, "_")
			.toLowerCase();
	const statusLabel = (value: string) => STATUS_LABELS[value] || String(value || "未知");
	const phaseLabel = (value: string) => PHASE_LABELS[value] || String(value || "未知");
	const kindLabel = (value: string) => (value === "review" ? "独立评审" : "执行节点");

	function displayPhase(data: DashboardSnapshot) {
		if (data.run.phase === "intake" && !data.selection.processSpec && data.run.status === "running")
			return "selection";
		return data.run.phase;
	}
	function render(data: DashboardSnapshot) {
		currentData = data;
		renderHeader(data);
		renderStages(data);
		renderTask(data);
		renderSelection(data);
		renderWorkflow(data);
		renderEvents(data);
		element("generated-at").textContent =
			`页面更新于 ${new Date(data.generatedAt).toLocaleString("zh-CN")} · 状态版本 ${data.run.revision}`;
	}
	function renderHeader(data: DashboardSnapshot) {
		element("run-subtitle").innerHTML =
			"运行 <b>" +
			esc(data.run.id) +
			"</b> · 阶段 <b>" +
			esc(phaseLabel(displayPhase(data))) +
			"</b> · 状态 <b>" +
			esc(statusLabel(data.run.status)) +
			"</b>";
		const live = Boolean(LIVE_ENDPOINT);
		element("live-indicator").classList.toggle("on", live);
		element("live-label").textContent = live ? "实时刷新" : "离线快照";
		const snap = element<HTMLAnchorElement>("snapshot-btn");
		if (SNAPSHOT_URL) {
			snap.href = SNAPSHOT_URL;
			snap.classList.remove("hidden");
		} else snap.classList.add("hidden");
	}
	function renderStages(data: DashboardSnapshot) {
		const phase = displayPhase(data),
			idx = Math.max(
				0,
				PHASES.findIndex(([id]) => id === phase),
			);
		element("stages").innerHTML = PHASES.map(([id, label], i) => {
			let cls = "stage";
			if (i < idx || (phase === "closed" && i <= idx)) cls += " done";
			if (i === idx && phase !== "closed") cls += " current";
			if (i === idx && ["blocked", "failed"].includes(data.run.status)) cls += " error";
			const note =
				id === "selection" ? "流程规范" : id === "design" ? "设计器" : id === "execute" ? "执行与评审" : "";
			return `<div class="${cls}"><b>${esc(label)}</b><small>${esc(note)}</small></div>`;
		}).join("");
		element("run-failure").innerHTML = data.run.failure
			? '<div class="errorbox"><b>' +
				esc(data.run.failure.code) +
				"</b><br>" +
				esc(data.run.failure.message) +
				"</div>"
			: "";
	}

	function renderTask(data: DashboardSnapshot) {
		const taskRoot = element("task-text");
		const scrollTop = taskRoot.scrollTop;
		const task = data.task;
		if (!task) {
			taskRoot.textContent = "等待任务输入……";
			element("task-meta").textContent = "";
			return;
		}
		taskRoot.innerHTML = renderMarkdown(task.text);
		taskRoot.scrollTop = scrollTop;
		element("task-meta").textContent =
			`${task.materials.length} 项材料 · ${task.unresolvedFacts.length} 个待确认事项`;
		const requirements = task.requirements.length
			? '<h3 style="font-size:11px">任务要求</h3><ul class="list">' +
				task.requirements
					.map((item) => `<li><span class="tag">${esc(item.id)}</span> ${esc(item.text)}</li>`)
					.join("") +
				"</ul>"
			: "";
		const facts = task.unresolvedFacts.length
			? '<h3 style="font-size:11px">待确认事项</h3><ul class="list">' +
				task.unresolvedFacts
					.map((item) => `<li><span class="tag">${esc(item.id)}</span> ${esc(item.description)}</li>`)
					.join("") +
				"</ul>"
			: "";
		element("task-detail").innerHTML = requirements + facts;
	}

	function renderSelection(data: DashboardSnapshot) {
		const selection = data.selection;
		element("selection-status").innerHTML =
			'<span class="' +
			statusClass(selection.status === "selected" ? "succeeded" : selection.status) +
			'">' +
			esc(selection.status === "selected" ? "已选择" : statusLabel(selection.status)) +
			"</span>";
		const body = element("selection-body");
		const previousDetails = document.getElementById("selection-applicability") as HTMLDetailsElement | null;
		if (previousDetails) selectionApplicabilityOpen = previousDetails.open;
		const previousRationale = document.getElementById("selection-rationale");
		const rationaleScrollTop = previousRationale?.scrollTop || 0;
		if (selection.status !== "selected" || !selection.processSpec) {
			body.className = "empty";
			body.textContent =
				selection.status === "blocked"
					? "流程选择已阻塞，请查看失败信息和运行事件。"
					: "IPD 正在检索并评估可用的流程规范。";
			return;
		}
		body.className = "";
		const process = selection.processSpec;
		body.innerHTML =
			'<div style="font-size:16px;font-weight:750">' +
			esc(process.name) +
			'</div><div class="meta">' +
			esc(process.id) +
			" @ " +
			esc(process.version) +
			'</div><p style="font-size:11px">' +
			esc(process.description) +
			'</p><div class="kv"><div class="k">选择理由</div><div id="selection-rationale" class="selection-rationale scroll-panel">' +
			esc(selection.rationale || "") +
			'</div><div class="k">治理规模</div><div>' +
			process.requiredActivityCount +
			" 项活动 · " +
			process.requiredDeliverableCount +
			" 项交付 · " +
			process.requiredReviewCount +
			' 项评审</div></div><details class="selection-details" id="selection-applicability"><summary>IPD 评估的适用性</summary><div class="selection-details-body"><b>适用条件</b><ul class="list">' +
			process.applicableWhen.map((item) => `<li>${esc(item)}</li>`).join("") +
			'</ul><b>不适用条件</b><ul class="list">' +
			process.notApplicableWhen.map((item) => `<li>${esc(item)}</li>`).join("") +
			"</ul></div></details>";
		const details = document.getElementById("selection-applicability") as HTMLDetailsElement | null;
		details!.open = selectionApplicabilityOpen;
		details!.addEventListener("toggle", () => {
			selectionApplicabilityOpen = details!.open;
		});
		element("selection-rationale").scrollTop = rationaleScrollTop;
	}

	function metric(value: string | number, label: string) {
		return `<div class="metric"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;
	}
	function renderWorkflow(data: DashboardSnapshot) {
		const workflow = data.workflow;
		const sourceText =
			workflow.source === "compiled"
				? "已编译执行基线"
				: workflow.source === "candidate"
					? "编译候选版本"
					: workflow.source === "draft"
						? "设计草稿"
						: "等待设计";
		const bits = [sourceText];
		if (workflow.name) bits.push(workflow.name);
		if (workflow.draftRevision !== undefined) bits.push(`草稿版本 ${workflow.draftRevision}`);
		element("workflow-meta").textContent = bits.join(" · ");
		const succeeded = workflow.nodes.filter((node) => node.status === "succeeded").length,
			active = workflow.nodes.filter((node) => node.status === "active").length;
		element("workflow-metrics").innerHTML =
			metric(workflow.nodes.length, "节点") +
			metric(workflow.criteriaCount, "准出标准") +
			metric(workflow.coverageCount, "规范覆盖") +
			metric(`${succeeded}/${workflow.nodes.length}`, "已完成") +
			(active ? metric(active, "执行中") : "");
		drawGraph(workflow.nodes, workflow.edges);
		if (selectedNodeId && workflow.nodes.some((node) => node.id === selectedNodeId))
			renderNodeDetail(workflow.nodes.find((node) => node.id === selectedNodeId));
		else element("node-detail").classList.remove("show");
	}

	function drawGraph(nodes: DashboardNode[], edges: DashboardEdge[]) {
		const wrap = element("graph-wrap");
		if (!nodes.length) {
			wrap.innerHTML = '<div class="empty">设计器创建节点后将在这里显示工作流。</div>';
			return;
		}
		const dependency = edges.filter((edge) => edge.kind === "dependency"),
			ids = new Set(nodes.map((node) => node.id)),
			indeg = new Map(nodes.map((node) => [node.id, 0])),
			out = new Map<string, string[]>(nodes.map((node) => [node.id, []]));
		dependency.forEach((edge) => {
			if (ids.has(edge.from) && ids.has(edge.to)) {
				indeg.set(edge.to, (indeg.get(edge.to) || 0) + 1);
				out.get(edge.from)!.push(edge.to);
			}
		});
		const queue = nodes.filter((node) => indeg.get(node.id) === 0).map((node) => node.id),
			layer = new Map(queue.map((id) => [id, 0]));
		let queueIndex = 0;
		while (queueIndex < queue.length) {
			const id = queue[queueIndex++],
				base = layer.get(id) || 0;
			for (const next of out.get(id) || []) {
				layer.set(next, Math.max(layer.get(next) || 0, base + 1));
				indeg.set(next, (indeg.get(next) || 1) - 1);
				if (indeg.get(next) === 0) queue.push(next);
			}
		}
		nodes.forEach((node) => {
			if (!layer.has(node.id)) layer.set(node.id, 0);
		});
		const groups = new Map<number, DashboardNode[]>();
		nodes.forEach((node) => {
			const current = layer.get(node.id) || 0;
			if (!groups.has(current)) groups.set(current, []);
			groups.get(current)!.push(node);
		});
		const box = { w: 250, h: 90 },
			gapX = 85,
			gapY = 46,
			pad = 34,
			maxLayer = Math.max(...layer.values()),
			maxRows = Math.max(...[...groups.values()].map((group) => group.length));
		const width = pad * 2 + (maxLayer + 1) * box.w + maxLayer * gapX,
			height = Math.max(330, pad * 2 + maxRows * box.h + (maxRows - 1) * gapY),
			positions = new Map<string, { x: number; y: number }>();
		[...groups.entries()]
			.sort((a, b) => a[0] - b[0])
			.forEach(([current, group]) => {
				const total = group.length * box.h + (group.length - 1) * gapY;
				let y = (height - total) / 2;
				group.forEach((node) => {
					positions.set(node.id, { x: pad + current * (box.w + gapX), y });
					y += box.h + gapY;
				});
			});
		const namespace = "http://www.w3.org/2000/svg",
			svg = document.createElementNS(namespace, "svg");
		svg.setAttribute("width", String(width));
		svg.setAttribute("height", String(height));
		svg.setAttribute("viewBox", `0 0 ${width} ${height}`);
		const defs = document.createElementNS(namespace, "defs");
		defs.innerHTML =
			'<marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#66758b"/></marker><marker id="reworkArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#d74747"/></marker>';
		svg.appendChild(defs);
		edges.forEach((edge) => {
			const start = positions.get(edge.from),
				end = positions.get(edge.to);
			if (!start || !end) return;
			const path = document.createElementNS(namespace, "path"),
				forward = edge.kind === "dependency",
				x1 = forward ? start.x + box.w : start.x + box.w / 2,
				y1 = forward ? start.y + box.h / 2 : start.y + box.h,
				x2 = forward ? end.x : end.x + box.w / 2,
				y2 = forward ? end.y + box.h / 2 : end.y + box.h,
				bend = forward ? (x1 + x2) / 2 : Math.max(start.y, end.y) + box.h + 30;
			path.setAttribute(
				"d",
				forward
					? `M ${x1} ${y1} C ${bend} ${y1}, ${bend} ${y2}, ${x2} ${y2}`
					: `M ${x1} ${y1} C ${x1} ${bend}, ${x2} ${bend}, ${x2} ${y2}`,
			);
			path.setAttribute("fill", "none");
			path.setAttribute("stroke", forward ? "#66758b" : "#d74747");
			path.setAttribute("stroke-width", "1.6");
			if (!forward) path.setAttribute("stroke-dasharray", "6 5");
			path.setAttribute("marker-end", forward ? "url(#arrow)" : "url(#reworkArrow)");
			svg.appendChild(path);
		});
		nodes.forEach((node) => {
			const position = positions.get(node.id)!,
				group = document.createElementNS(namespace, "g");
			group.setAttribute("class", `graph-node${selectedNodeId === node.id ? " selected" : ""}`);
			const rect = document.createElementNS(namespace, "rect");
			rect.setAttribute("x", String(position.x));
			rect.setAttribute("y", String(position.y));
			rect.setAttribute("width", String(box.w));
			rect.setAttribute("height", String(box.h));
			rect.setAttribute("rx", "11");
			rect.setAttribute("fill", nodeFill(node.status, node.kind));
			rect.setAttribute("stroke", nodeStroke(node.status, node.kind));
			rect.setAttribute(
				"stroke-width",
				selectedNodeId === node.id ? "2.8" : node.status === "active" ? "2.4" : "1.2",
			);
			group.appendChild(rect);
			svgText(
				group,
				position.x + 14,
				position.y + 22,
				`${kindLabel(node.kind)} · ${statusLabel(node.status)}`,
				10,
				"#687386",
				700,
			);
			svgText(group, position.x + 14, position.y + 45, short(node.name, 30), 14, "#172033", 700);
			svgText(group, position.x + 14, position.y + 66, short(node.agent, 34), 11, "#596579", 500);
			svgText(
				group,
				position.x + 14,
				position.y + 82,
				node.roundCount ? `已执行 ${node.roundCount} 轮` : "尚未开始",
				9,
				"#7b8595",
				500,
			);
			group.addEventListener("click", () => {
				selectedNodeId = node.id;
				drawGraph(nodes, edges);
				renderNodeDetail(node);
			});
			svg.appendChild(group);
		});
		wrap.replaceChildren(svg);
	}

	function nodeFill(status: string, kind: string) {
		if (status === "active") return "#eaf2ff";
		if (status === "succeeded") return "#e7f7ef";
		if (status === "blocked" || status === "failed") return "#fff0f0";
		if (status === "paused" || status === "waiting_rework" || status === "waiting_review") return "#fff8e7";
		return kind === "review" ? "#f5f1ff" : "#ffffff";
	}
	function nodeStroke(status: string, kind: string) {
		if (status === "active") return "#6ea8fe";
		if (status === "succeeded") return "#55d187";
		if (status === "blocked" || status === "failed") return "#ff6b6b";
		if (status === "paused" || status === "waiting_rework" || status === "waiting_review") return "#e5b454";
		return kind === "review" ? "#8069bf" : "#334257";
	}
	function svgText(
		group: SVGElement,
		x: number,
		y: number,
		value: string,
		size: number,
		color: string,
		weight: number,
	) {
		const element = document.createElementNS("http://www.w3.org/2000/svg", "text");
		element.setAttribute("x", String(x));
		element.setAttribute("y", String(y));
		element.setAttribute("font-size", String(size));
		element.setAttribute("font-family", 'Inter,"PingFang SC","Microsoft YaHei",system-ui,sans-serif');
		element.setAttribute("fill", color);
		element.setAttribute("font-weight", String(weight));
		element.textContent = value;
		group.appendChild(element);
	}
	function short(value: string, length: number) {
		const text = String(value || "");
		return text.length > length ? `${text.slice(0, length - 1)}…` : text;
	}
	function initials(value: string) {
		const parts = String(value || "")
			.replace(/｜.*$/g, "")
			.split(/[ ]+/)
			.filter(Boolean);
		return (
			parts
				.map((part) => part[0])
				.join("")
				.slice(0, 2) || "IPD"
		);
	}
	function pills(items: string[]) {
		if (!items?.length) return '<span class="meta">无额外配置</span>';
		return `<div class="pill-list">${items.map((item) => `<span class="pill">${esc(item)}</span>`).join("")}</div>`;
	}
	function plainList(items: string[], boundary = false) {
		if (!items?.length) return '<div class="meta">无</div>';
		return (
			'<ul class="plain-list' +
			(boundary ? " boundary" : "") +
			'">' +
			items.map((item) => `<li>${esc(item)}</li>`).join("") +
			"</ul>"
		);
	}
	function flowList(items: string[]) {
		if (!items?.length) return '<div class="meta">无</div>';
		return (
			'<div class="flow-list">' +
			items.map((item) => `<div class="flow-item">${esc(item)}</div>`).join("") +
			"</div>"
		);
	}
	function detailSection(title: string, content: string) {
		return `<section class="detail-section"><h3>${esc(title)}</h3>${content}</section>`;
	}

	function renderNodeDetail(node: DashboardNode | undefined) {
		const box = element("node-detail");
		if (!node) {
			box.classList.remove("show");
			return;
		}
		const activeRound = node.activeRoundId ? `<span class="pill">当前轮次：${esc(node.activeRoundId)}</span>` : "";
		const environment = node.environment
			? "<br><b>执行环境：</b>" +
				esc(`${node.environment.id}@${node.environment.version} · ${node.environment.provider}`)
			: "";
		const access =
			'<div class="access"><b>读取范围：</b>' +
			esc(node.permissions.readPaths.join("、") || "无") +
			"<br><b>写入范围：</b>" +
			esc(node.permissions.writePaths.join("、") || "只读") +
			"<br><b>外部操作：</b>" +
			(node.permissions.externalActions ? "允许" : "不允许") +
			environment +
			"</div>";
		box.classList.add("show");
		box.innerHTML =
			'<div class="detail-head"><div><div class="eyebrow">' +
			esc(kindLabel(node.kind)) +
			"</div><h2>" +
			esc(node.name) +
			'</h2><div class="meta">节点 ' +
			esc(node.id) +
			" · 已执行 " +
			node.roundCount +
			' 轮</div></div><span class="' +
			statusClass(node.status) +
			'">' +
			esc(statusLabel(node.status)) +
			'</span></div><div class="detail-body"><div class="detail-hero ' +
			(node.kind === "review" ? "review" : "") +
			'"><div class="label">' +
			(node.kind === "review" ? "这个质量门要判断什么" : "这个节点要完成什么") +
			'</div><div class="objective">' +
			esc(node.objective) +
			'</div></div><div class="detail-grid"><div class="person-card"><div class="avatar ' +
			(node.kind === "review" ? "review" : "") +
			'">' +
			esc(initials(node.agent)) +
			"</div><div><strong>" +
			esc(node.agent) +
			"</strong><small>" +
			esc(node.requiredCapabilities.join(" · ") || "未声明专业能力") +
			'</small></div></div><div class="person-card"><div><strong>运行概况</strong><small>' +
			esc(statusLabel(node.status)) +
			" · " +
			node.roundCount +
			' 个工作轮次</small><div class="pill-list">' +
			activeRound +
			"</div></div></div>" +
			detailSection("具体职责", plainList(node.responsibilities)) +
			detailSection("工作要求与检查清单", plainList(node.workRequirements)) +
			'<div class="detail-grid">' +
			detailSection("所需输入", flowList(node.inputs)) +
			detailSection(node.kind === "review" ? "评审对象" : "交付输出", flowList(node.outputs)) +
			"</div>" +
			detailSection(
				"边界与限制",
				plainList(node.nonResponsibilities, true) +
					(node.constraints.length
						? `<div style="margin-top:11px" class="meta">必须遵守</div>${plainList(node.constraints)}`
						: ""),
			) +
			'<div class="detail-grid">' +
			detailSection(
				"工具与专业方法",
				'<div class="meta">工具</div>' +
					pills(node.tools) +
					'<div class="meta" style="margin-top:10px">专业方法</div>' +
					pills(node.skills),
			) +
			detailSection("文件与外部访问权限", access) +
			"</div></div>";
	}

	function renderEvents(data: DashboardSnapshot) {
		element("event-meta").textContent = `最近 ${data.events.length} 条事件`;
		const root = element("events");
		if (!data.events.length) {
			root.innerHTML = '<div class="empty">暂无事件。</div>';
			return;
		}
		root.innerHTML = [...data.events]
			.reverse()
			.map(
				(event) =>
					'<div class="event"><div class="seq">#' +
					event.sequence +
					"<br>" +
					new Date(event.timestamp).toLocaleTimeString("zh-CN") +
					'</div><div class="type">' +
					esc(EVENT_LABELS[event.type] || event.type) +
					(event.nodeId ? `<br><span class="tag">${esc(event.nodeId)}</span>` : "") +
					'</div><div class="data">' +
					esc(JSON.stringify(event.data)) +
					"</div></div>",
			)
			.join("");
	}
	let etag: string | undefined;
	let refreshing = false;
	async function refresh() {
		if (!LIVE_ENDPOINT) {
			if (currentData) render(currentData);
			return;
		}
		if (refreshing) return;
		refreshing = true;
		try {
			const response = await fetch(LIVE_ENDPOINT, {
				cache: "no-store",
				headers: etag ? { "If-None-Match": etag } : {},
			});
			if (response.status === 304) return;
			if (!response.ok) throw new Error(await response.text());
			const data = (await response.json()) as DashboardSnapshot;
			if (data.schemaVersion !== 1) throw new Error("Unsupported dashboard schema");
			etag = response.headers.get("ETag") ?? undefined;
			render(data);
		} catch (error) {
			element("generated-at").textContent = `实时刷新失败：${String(error)}`;
		} finally {
			refreshing = false;
		}
	}
	element("refresh-btn").addEventListener("click", refresh);
	if (currentData) render(currentData);
	if (LIVE_ENDPOINT) {
		refresh();
		setInterval(refresh, 1200);
	}
}
