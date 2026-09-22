import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildDashboardSnapshot, IpdDashboardServer, type RunState, renderDashboardPage } from "../src/index.ts";
import { createCompilerFixture, createEmptyRuntimeRecords } from "./fixtures.ts";

function stateFixture(): { state: RunState; processSpec: ReturnType<typeof createCompilerFixture>["processSpec"] } {
	const fixture = createCompilerFixture();
	const state: RunState = {
		...createEmptyRuntimeRecords(),
		runId: fixture.runId,
		revision: 3,
		phase: "compile",
		status: "running",
		taskInput: fixture.taskInput,
		processSelection: fixture.processSelection,
		workflowCandidate: fixture.workflow,
		nodes: [],
		rounds: [],
		submissions: [],
		reviews: [],
		approvals: [],
		mechanicalChecks: [],
		events: [
			{
				sequence: 1,
				type: "process_selected",
				timestamp: 1,
				data: { processSpec: fixture.processSpec.process_spec_id },
			},
			{ sequence: 2, type: "workflow_designed", timestamp: 2, data: { workflowId: fixture.workflow.workflow_id } },
		],
		operations: {},
	};
	return { state, processSpec: fixture.processSpec };
}

describe("IPD visualization", () => {
	const roots: string[] = [];
	const servers: IpdDashboardServer[] = [];
	it("returns 304 without rereading unchanged Run history and preserves updated revisions", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-dashboard-version-"));
		roots.push(root);
		const { state, processSpec } = stateFixture();
		const getRun = vi.fn(async () => structuredClone(state));
		const server = new IpdDashboardServer({
			projectRoot: root,
			processSpecs: [processSpec],
			getRun,
			getRunVersion: async () => String(state.revision),
		});
		servers.push(server);
		const link = await server.registerRun(state.runId);
		const url = `${new URL(link.url).origin}/api/runs/${state.runId}`;
		const first = await fetch(url);
		const etag = first.headers.get("etag")!;
		await first.text();
		const same = await fetch(url, { headers: { "If-None-Match": etag } });
		expect(same.status).toBe(304);
		expect(getRun).toHaveBeenCalledTimes(1);
		state.revision++;
		const next = await fetch(url, { headers: { "If-None-Match": etag } });
		expect(next.status).toBe(200);
		expect(await next.json()).toMatchObject({ run: { revision: state.revision } });
		expect(getRun).toHaveBeenCalledTimes(2);
	});
	afterEach(async () => {
		await Promise.all(servers.splice(0).map((server) => server.close()));
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("projects selection rationale and Workflow dependency/rework edges", () => {
		const { state, processSpec } = stateFixture();
		const snapshot = buildDashboardSnapshot(state, [processSpec]);
		expect(snapshot.selection).toMatchObject({
			status: "selected",
			processSpec: { id: processSpec.process_spec_id, version: processSpec.version },
		});
		expect(snapshot.selection.rationale).toContain("production and independent review");
		expect(snapshot.workflow.source).toBe("candidate");
		expect(snapshot.workflow.nodes.map((node) => node.id)).toEqual(["produce", "review-produce"]);
		expect(snapshot.workflow.nodes[0]).toMatchObject({
			workRequirements: ["Use the supplied material"],
			nonResponsibilities: ["Approve the result"],
			requiredCapabilities: ["production"],
			permissions: { readPaths: ["."], writePaths: ["outputs/produce"], externalActions: false },
		});
		expect(snapshot.workflow.edges).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ from: "produce", to: "review-produce", kind: "dependency" }),
				expect.objectContaining({ from: "review-produce", to: "produce", kind: "rework" }),
			]),
		);
	});

	it("renders a standalone HTML snapshot without external frontend assets", () => {
		const { state, processSpec } = stateFixture();
		const snapshot = buildDashboardSnapshot(state, [processSpec]);
		const page = renderDashboardPage({ runId: state.runId, initialSnapshot: snapshot });
		expect(page).toContain("<!doctype html>");
		expect(page).toContain('<html lang="zh-CN">');
		expect(page).toContain("IPD 运行看板");
		expect(page).toContain("IPD Selection");
		expect(page).toContain('class="card task-card"');
		expect(page).toContain('class="task-markdown scroll-panel"');
		expect(page).toContain("color-scheme:light");
		expect(page).toContain(".task-markdown{height:310px;min-height:310px;flex:1 1 310px");
		expect(page).toContain("font-size:12px");
		expect(page).toContain(".selection-rationale{max-height:190px");
		expect(page).toContain("function renderMarkdown(value)");
		expect(page).toContain("selectionApplicabilityOpen = previousDetails.open");
		expect(page).toContain(state.taskInput!.raw_task.text);
		expect(page).not.toMatch(/<script\s+src=/i);
		expect(page).not.toMatch(/<link[^>]+stylesheet[^>]+href=/i);
	});

	it("serves a live dashboard and downloadable self-contained snapshot on a local ephemeral port", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-visualization-"));
		roots.push(root);
		const { state, processSpec } = stateFixture();
		const server = new IpdDashboardServer({
			projectRoot: root,
			processSpecs: [processSpec],
			getRun: async (runId) => {
				if (runId !== state.runId) throw Object.assign(new Error("not found"), { code: "ENOENT" });
				return state;
			},
			host: "127.0.0.1",
			port: 0,
		});
		servers.push(server);
		const link = await server.registerRun(state.runId);
		const live = await fetch(link.url);
		expect(live.status).toBe(200);
		expect(await live.text()).toContain("工作流设计与执行");
		const snapshot = await fetch(link.snapshotUrl);
		expect(snapshot.status).toBe(200);
		expect(snapshot.headers.get("content-disposition")).toContain("attachment");
		const body = await snapshot.text();
		expect(body).toContain(state.taskInput!.raw_task.text);
		expect(body).toContain("离线快照");
	});

	it("projects the latest RunState on every live API request", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-visualization-live-"));
		roots.push(root);
		const { state, processSpec } = stateFixture();
		let currentState = structuredClone(state);
		const server = new IpdDashboardServer({
			projectRoot: root,
			processSpecs: [processSpec],
			getRun: async (runId) => {
				if (runId !== state.runId) throw Object.assign(new Error("not found"), { code: "ENOENT" });
				return structuredClone(currentState);
			},
			host: "127.0.0.1",
			port: 0,
		});
		servers.push(server);
		const link = await server.registerRun(state.runId);
		const apiUrl = `${new URL(link.url).origin}/api/runs/${encodeURIComponent(state.runId)}`;

		let response = await fetch(apiUrl);
		expect(response.status).toBe(200);
		let snapshot = (await response.json()) as {
			run: { revision: number; phase: string };
			workflow: { nodes: Array<{ id: string; status: string; activeRoundId?: string; roundCount: number }> };
		};
		expect(snapshot.run).toMatchObject({ revision: 3, phase: "compile" });
		expect(snapshot.workflow.nodes.every((node) => node.status === "planned")).toBe(true);

		currentState = {
			...currentState,
			revision: 4,
			phase: "execute",
			nodes: [
				{
					nodeId: "produce",
					kind: "execution",
					status: "active",
					scopeEpoch: 1,
					nextRound: 2,
					activeRoundId: "produce:round:1",
				},
				{ nodeId: "review-produce", kind: "review", status: "waiting", scopeEpoch: 1, nextRound: 1 },
			],
			rounds: [
				{
					roundId: "produce:round:1",
					nodeId: "produce",
					index: 1,
					status: "active",
					inputSubmissionIds: [],
					inputBindings: [],
					startedAt: 3,
				},
			],
			events: [
				...currentState.events,
				{
					sequence: 3,
					type: "round_started",
					timestamp: 3,
					nodeId: "produce",
					roundId: "produce:round:1",
					data: null,
				},
			],
		};

		response = await fetch(apiUrl);
		expect(response.status).toBe(200);
		snapshot = (await response.json()) as typeof snapshot;
		expect(snapshot.run).toMatchObject({ revision: 4, phase: "execute" });
		expect(snapshot.workflow.nodes.find((node) => node.id === "produce")).toMatchObject({
			status: "active",
			activeRoundId: "produce:round:1",
			roundCount: 1,
		});
	});

	it("contains snapshot failures within the HTTP response", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-visualization-error-"));
		roots.push(root);
		const { state, processSpec } = stateFixture();
		const server = new IpdDashboardServer({
			projectRoot: root,
			processSpecs: [processSpec],
			getRun: async () => {
				throw new Error("snapshot unavailable");
			},
			host: "127.0.0.1",
			port: 0,
		});
		servers.push(server);
		const link = await server.registerRun(state.runId);
		const response = await fetch(link.snapshotUrl);
		expect(response.status).toBe(500);
		expect(await response.text()).toContain("snapshot unavailable");
	});
});
