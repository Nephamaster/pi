import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	createArtifactIntegrityCheckExecutor,
	FileRunStore,
	FileWorkflowAssetStore,
	hashJson,
	IpdControlPlane,
	IpdService,
	MechanicalChecker,
	type NodeWorker,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
	while (cleanups.length) await cleanups.pop()?.();
});

async function setup() {
	const root = await mkdtemp(join(tmpdir(), "ipd-optional-skill-"));
	cleanups.push(() => rm(root, { recursive: true, force: true, maxRetries: 3 }));
	const fixture = createCompilerFixture();
	const store = new FileRunStore();
	const workflowAssets = new FileWorkflowAssetStore({ directory: join(root, "workflows") });
	const preparation: string[] = [];
	const create = (pendingSelection = false) => {
		const service = new IpdService({
			projectRoot: root,
			store,
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [] },
			workflowAssets,
			idFactory: () => "run-1",
			createControlPlane(_runId, skill) {
				expect(skill).toBeUndefined();
				return new IpdControlPlane(
					store,
					{
						select: async () => {
							preparation.push("select");
							return pendingSelection ? new Promise(() => {}) : fixture.processSelection;
						},
					},
					{
						design: async () => {
							preparation.push("design");
							return fixture.workflow;
						},
					},
					workflowAssets,
				);
			},
			createRuntime(directory, controller) {
				const worker: NodeWorker = {
					async runExecution() {
						await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
						await writeFile(
							join(directory.workspace, "outputs/produce/result.txt"),
							"No business Skill required",
						);
						return {
							summary: "Result",
							outputs: [
								{
									output_id: "content-output",
									files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
								},
							],
							evidence: [],
							metadata: {},
						};
					},
					async runReview(work) {
						const submission = work.inputSubmissions[0];
						return {
							decision: "PASS",
							criteria: [
								{
									criterion_id: "quality",
									result: "PASS",
									rationale: "Read and checked the output",
									required_rework: [],
									rework_targets: [],
									evidence: [
										{
											description: "Sealed result",
											reference: "outputs/produce/result.txt",
											node_id: submission.nodeId,
											output_id: "content-output",
											submission_id: submission.submissionId,
											criterion_id: "quality",
										},
									],
								},
							],
							unresolved_issues: [],
						};
					},
				};
				const checks = new CheckExecutorRegistry();
				checks.add(createArtifactIntegrityCheckExecutor());
				return new WorkflowRuntime(store, directory, worker, new SubmissionStore(), new MechanicalChecker(checks), {
					controller,
				});
			},
		});
		cleanups.push(() => service.close());
		return service;
	};
	return { fixture, create, workflowAssets, preparation };
}

it("creates, deduplicates, executes and reviews a Run with no business Skills in the asset pool", async () => {
	const { fixture, create } = await setup();
	const service = create();
	const first = await service.createRun("request", fixture.taskInput);
	expect((await service.createRun("request", fixture.taskInput)).runId).toBe(first.runId);
	await expect.poll(async () => (await service.getRun(first.runId)).status).toBe("succeeded");
	await expect.poll(async () => (await service.getRun(first.runId)).cleanup?.status).toBe("complete");
	const state = await service.getRun(first.runId);
	expect(state.runSkill).toBeUndefined();
	expect(state.request?.runSkillId).toBeUndefined();
	expect(state.baseline?.nodes.every((node) => node.agents.every((agent) => agent.lockedSkills.length === 0))).toBe(
		true,
	);
});

it("recovers interrupted preparation without inventing or requiring a Run Skill", async () => {
	const { fixture, create } = await setup();
	const original = create(true);
	await original.createRun("request", fixture.taskInput);
	await expect.poll(async () => (await original.getRun("run-1")).phase).toBe("selection");
	await original.close();
	expect((await original.getRun("run-1")).status).toBe("paused");
	const restored = create();
	await restored.resumeRun("run-1");
	await expect.poll(async () => (await restored.getRun("run-1")).status).toBe("succeeded");
	await expect.poll(async () => (await restored.getRun("run-1")).cleanup?.status).toBe("complete");
});

it("starts a selected Workflow template without a Run Skill or invoking design roles", async () => {
	const { fixture, create, workflowAssets, preparation } = await setup();
	await workflowAssets.save(fixture.workflow, hashJson(fixture.workflow));
	const service = create();
	await service.createRunFromTemplates("template-request", fixture.taskInput, undefined, {
		processSpecId: fixture.processSpec.process_spec_id,
		processSpecVersion: fixture.processSpec.version,
		workflowId: fixture.workflow.workflow_id,
		workflowVersion: fixture.workflow.workflow_version,
	});
	await expect.poll(async () => (await service.getRun("run-1")).status).toBe("succeeded");
	await expect.poll(async () => (await service.getRun("run-1")).cleanup?.status).toBe("complete");
	expect(preparation).toEqual([]);
});

it("still rejects an explicitly requested missing business Skill", async () => {
	const { fixture, create } = await setup();
	await expect(create().createRun("request", fixture.taskInput, "missing-skill")).rejects.toThrow("Unknown Run Skill");
});
