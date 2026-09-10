import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BootstrapProcessSelector,
	BootstrapWorkflowDesigner,
	FileRunStore,
	FileWorkflowAssetStore,
	IpdControlPlane,
	ProcessSelectionBlockedError,
	WorkflowDesignBlockedError,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("IpdControlPlane", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	function runSkill() {
		return {
			id: "test-skill",
			hash: "a".repeat(64),
			source: "test",
			filePath: "/test/SKILL.md",
			baseDir: "/test",
			description: "Test Skill",
			allowedTools: [],
		};
	}

	it("moves one Run from TaskInput through selection, staffing, design, and compilation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-control-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			new BootstrapWorkflowDesigner({ id: "producer", version: "1.0.0" }, { id: "reviewer", version: "1.0.0" }),
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const result = await control.prepare({
			projectRoot: root,
			runId: "run-1",
			taskInput: fixture.taskInput,
			runSkill: runSkill(),
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Control Plane did not compile the Workflow");
		const state = await store.read("run-1");
		expect(state.phase).toBe("compile");
		expect(state.processSelection?.process_spec_ref.id).toBe("delivery-process");
		expect(state.selectedProcessSpec).toEqual(fixture.processSpec);
		expect(state.staffingReport).toEqual({ ok: true, diagnostics: [] });
		expect(state.events.map((event) => event.type)).toEqual([
			"process_selected",
			"process_staffing_checked",
			"workflow_designed",
			"workflow_asset_saved",
		]);
		expect(
			JSON.parse(
				await readFile(
					join(
						root,
						".pi",
						"ipd",
						"workflow",
						result.baseline.workflow.workflow_id,
						`${result.baseline.workflow.workflow_version}.json`,
					),
					"utf8",
				),
			),
		).toEqual(result.baseline.workflow);
	});

	it("records a formal selection block without starting Workflow design", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-control-blocked-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const control = new IpdControlPlane(
			store,
			{
				async select() {
					throw new ProcessSelectionBlockedError("No ProcessSpec applies", []);
				},
			},
			{
				async design() {
					throw new Error("Workflow design must not start");
				},
			},
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const result = await control.prepare({
			projectRoot: root,
			runId: "run-1",
			taskInput: fixture.taskInput,
			runSkill: runSkill(),
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(false);
		expect((await store.read("run-1")).failure?.message).toContain("No ProcessSpec applies");
	});

	it("blocks before design when the selected ProcessSpec cannot be staffed", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-control-unstaffed-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		fixture.processSpec.required_activities[0]!.required_capabilities = ["missing-capability"];
		fixture.processSelection.process_spec_ref.hash = "unused";
		const store = new FileRunStore();
		let designed = false;
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			{
				async design() {
					designed = true;
					return fixture.workflow;
				},
			},
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const result = await control.prepare({
			projectRoot: root,
			runId: "run-1",
			taskInput: fixture.taskInput,
			runSkill: runSkill(),
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(false);
		expect(designed).toBe(false);
		const state = await store.read("run-1");
		expect(state.status).toBe("blocked");
		expect(state.failure?.code).toBe("process_spec_unstaffable");
		expect(state.staffingReport?.ok).toBe(false);
	});

	it("records a structured Workflow Designer block as preparation blocked rather than runtime failure", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-control-design-blocked-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const block = {
			type: "resource_gap" as const,
			reason: "No executable employee can produce the required artifact",
			missing_conditions: ["production capability and required tool must coexist"],
			task_requirement_refs: ["deliver-result"],
			process_requirement_refs: ["produce"],
			diagnostics: [{ code: "staffing", path: "/nodes", message: "No valid assignment" }],
			needed_to_resume: ["Add a compatible AgentCard or tool authorization"],
		};
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			{
				async design() {
					throw new WorkflowDesignBlockedError(block);
				},
			},
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const result = await control.prepare({
			projectRoot: root,
			runId: "run-1",
			taskInput: fixture.taskInput,
			runSkill: runSkill(),
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(false);
		const state = await store.read("run-1");
		expect(state.status).toBe("blocked");
		expect(state.phase).toBe("design");
		expect(state.failure?.code).toBe("workflow_design_blocked");
		expect(state.workflowDesignBlock).toEqual(block);
		expect(state.events.map((event) => event.type)).toContain("workflow_design_blocked");
	});
});
