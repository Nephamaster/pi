import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	BootstrapProcessSelector,
	BootstrapWorkflowDesigner,
	CheckExecutorRegistry,
	createArtifactIntegrityCheckExecutor,
	createRunId,
	FileRunStore,
	FileWorkflowAssetStore,
	IpdControlPlane,
	IpdService,
	MechanicalChecker,
	type NodeWorker,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("IpdService", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("includes the UTC creation time in default Run IDs", () => {
		expect(createRunId(Date.parse("2026-09-08T12:34:56.789Z"), "00000000-0000-4000-8000-000000000000")).toBe(
			"20260908T123456789Z-00000000-0000-4000-8000-000000000000",
		);
	});

	it("creates once and exposes query-only progress and result APIs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-service-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const worker: NodeWorker = {
			async runExecution() {
				const path = join(root, ".pi", "ipd", "runs", "run-1", "workspace", "outputs", "produce");
				await mkdir(path, { recursive: true });
				await writeFile(join(path, "result.txt"), "done");
				return {
					summary: "done",
					outputs: [
						{ output_id: "result", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
					],
					evidence: [],
					metadata: {},
				};
			},
			async runReview() {
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: [
								{
									description: "Observed sealed output",
									reference: "outputs/produce/result.txt",
									criterion_id: "quality",
								},
							],
							rationale: "accepted",
							required_rework: [],
						},
					],
					rework_node_ids: [],
					unresolved_issues: [],
				};
			},
		};
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			new BootstrapWorkflowDesigner({ id: "producer", version: "1.0.0" }, { id: "reviewer", version: "1.0.0" }),
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const service = new IpdService({
			store,
			createControlPlane: () => control,
			processSpecs: [fixture.processSpec],
			assets: {
				...fixture.assets,
				skills: [
					{
						id: "test-skill",
						hash: "a".repeat(64),
						source: "test",
						filePath: "/test/SKILL.md",
						baseDir: "/test",
						description: "Test Skill",
						allowedTools: [],
					},
				],
			},
			projectRoot: root,
			idFactory: () => "run-1",
			createRuntime: (directory) =>
				new WorkflowRuntime(store, directory, worker, new SubmissionStore(), new MechanicalChecker(checks)),
		});
		const receipt = await service.createRun("request-1", fixture.taskInput, "test-skill");
		expect((await service.createRun("request-1", fixture.taskInput, "test-skill")).runId).toBe(receipt.runId);
		for (let count = 0; count < 50 && (await service.getRun("run-1")).status === "running"; count++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		const before = await service.getRun("run-1");
		const events = await service.readEvents("run-1", 0);
		const result = await service.getResult("run-1");
		const after = await service.getRun("run-1");
		expect(after.revision).toBe(before.revision);
		expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
		expect(result.finalSubmissionIds).toHaveLength(1);
		expect(result.finalSubmission).toMatchObject({
			directory: join(root, ".pi", "ipd", "runs", "run-1", "final_submission"),
			files: [{ path: "result.txt", nodeId: "produce", outputId: "result" }],
		});

		const reopened = new IpdService({
			store: new FileRunStore(),
			createControlPlane: () => {
				throw new Error("not used");
			},
			processSpecs: [],
			assets: fixture.assets,
			projectRoot: root,
			createRuntime: () => {
				throw new Error("not used");
			},
		});
		const reopenedResult = await reopened.getResult("run-1");
		expect(reopenedResult.state.status).toBe("succeeded");
		expect(reopenedResult.finalSubmission?.files.map((file) => file.path)).toEqual(["result.txt"]);
	});
});
