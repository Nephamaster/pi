import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	buildDashboardSnapshot,
	IpdDashboardServer,
	renderDashboardPage,
	type RunState,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function stateFixture(): { state: RunState; processSpec: ReturnType<typeof createCompilerFixture>["processSpec"] } {
	const fixture = createCompilerFixture();
	const state: RunState = {
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
			{ sequence: 1, type: "process_selected", timestamp: 1, data: { processSpec: fixture.processSpec.process_spec_id } },
			{ sequence: 2, type: "workflow_designed", timestamp: 2, data: { workflowId: fixture.workflow.workflow_id } },
		],
		operations: {},
	};
	return { state, processSpec: fixture.processSpec };
}

describe("IPD visualization", () => {
	const roots: string[] = [];
	const servers: IpdDashboardServer[] = [];
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
		expect(page).toContain("IPD Run Observatory");
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
		expect(await live.text()).toContain("Workflow Design & Execution");
		const snapshot = await fetch(link.snapshotUrl);
		expect(snapshot.status).toBe(200);
		expect(snapshot.headers.get("content-disposition")).toContain("attachment");
		const body = await snapshot.text();
		expect(body).toContain(state.taskInput!.raw_task.text);
		expect(body).toContain("Standalone snapshot");
	});
});
