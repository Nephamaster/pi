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
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("IpdControlPlane", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("moves one Run from TaskInput through selection, design, and compilation", async () => {
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
			runSkill: {
				id: "test-skill",
				hash: "a".repeat(64),
				source: "test",
				filePath: "/test/SKILL.md",
				baseDir: "/test",
				description: "Test Skill",
				allowedTools: [],
			},
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error("Control Plane did not compile the Workflow");
		const state = await store.read("run-1");
		expect(state.phase).toBe("compile");
		expect(state.processSelection?.process_spec_ref.id).toBe("delivery-process");
		expect(state.events.map((event) => event.type)).toEqual([
			"process_selected",
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
			runSkill: {
				id: "test-skill",
				hash: "a".repeat(64),
				source: "test",
				filePath: "/test/SKILL.md",
				baseDir: "/test",
				description: "Test Skill",
				allowedTools: [],
			},
			processSpecs: [fixture.processSpec],
			assets: fixture.assets,
		});
		expect(result.ok).toBe(false);
		expect((await store.read("run-1")).failure?.message).toContain("No ProcessSpec applies");
	});
});
