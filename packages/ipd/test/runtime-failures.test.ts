import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	compileWorkflow,
	defineCheckExecutor,
	FileRunStore,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("WorkflowRuntime failure classification", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("does not send a storage failure back to the Agent as submission correction", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-storage-failure-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		let calls = 0;
		const worker: NodeWorker = {
			async runExecution() {
				calls++;
				return {
					summary: "result",
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
			async runReview() {
				throw new Error("unexpected review");
			},
		};
		const brokenStore = {
			async seal() {
				const error = new Error("submission storage is read-only") as NodeJS.ErrnoException;
				error.code = "EACCES";
				throw error;
			},
		} as SubmissionStore;
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			brokenStore,
			new MechanicalChecker(fixture.assets.checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		expect(result.status).toBe("blocked");
		expect(calls).toBe(1);
		expect(result.events.at(-2)).toMatchObject({
			type: "round_blocked",
			data: { kind: "transient", message: "submission storage is read-only" },
		});
	});

	it("retains mechanical failure details and returns them to the next execution round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-mechanical-feedback-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		let checksRun = 0;
		const checks = new CheckExecutorRegistry();
		checks.add(
			defineCheckExecutor({
				id: "artifact-integrity",
				parameters: Type.Object({}, { additionalProperties: false }),
				async execute() {
					checksRun++;
					return checksRun === 1
						? { result: "FAIL", evidence: { reason: "checksum" }, message: "checksum mismatch" }
						: { result: "PASS", evidence: { reason: "valid" }, message: "checksum valid" };
				},
			}),
		);
		fixture.assets = { ...fixture.assets, checks };
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		let executionRounds = 0;
		const worker: NodeWorker = {
			async runExecution(work) {
				executionRounds++;
				if (executionRounds === 2) expect(work.feedback).toContain("integrity: checksum mismatch");
				await mkdir(join(directory.workspace, "outputs", "produce"), { recursive: true });
				await writeFile(join(directory.workspace, "outputs", "produce", "result.txt"), `round-${executionRounds}`);
				return {
					summary: "result",
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
			async runReview() {
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: [{ description: "Inspected result", reference: "result.txt", criterion_id: "quality" }],
							rationale: "accepted",
							required_rework: [],
						},
					],
					rework_node_ids: [],
					unresolved_issues: [],
				};
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		expect(result.status).toBe("succeeded");
		expect(result.mechanicalChecks.map((check) => check.result)).toEqual(["FAIL", "PASS"]);
	});
});
