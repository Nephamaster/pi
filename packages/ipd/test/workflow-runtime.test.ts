import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	FileRunStore,
	MechanicalChecker,
	type NodeRoundWork,
	NodeSubmissionProtocolError,
	type NodeWorker,
	NodeWorkerError,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const reviewEvidence = (work: NodeRoundWork, criterionId = "quality") => {
	const submission = work.inputSubmissions[0];
	const output = submission?.outputs[0];
	if (!submission || !output) throw new Error("Review input is missing");
	return [
		{
			description: "Observed the sealed output",
			reference: output.manifest.files[0]?.path ?? "submission.json",
			submission_id: submission.submissionId,
			node_id: submission.nodeId,
			output_id: output.outputId,
			criterion_id: criterionId,
		},
	];
};

describe("WorkflowRuntime", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("returns review feedback to the execution node and reaches a reviewed result", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		await mkdir(join(directory.workspace, "outputs", "produce"), { recursive: true });
		let executionRounds = 0;
		let reviewRounds = 0;
		const worker: NodeWorker = {
			async runExecution(work) {
				executionRounds++;
				await writeFile(
					join(directory.workspace, "outputs", "produce", "result.txt"),
					executionRounds === 1 ? "draft" : "revised",
				);
				if (executionRounds === 2)
					expect(work.feedback).toContainEqual(
						expect.objectContaining({
							type: "quality_rework",
							criterionId: "quality",
							issue: "Replace the draft",
						}),
					);
				return {
					summary: "Produced content",
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
				reviewRounds++;
				const pass = reviewRounds === 3;
				const declaredDecision = reviewRounds === 1 ? "PASS" : pass ? "PASS" : "REWORK";
				return {
					decision: declaredDecision,
					criteria: [
						{
							criterion_id: "quality",
							result: pass ? "PASS" : "FAIL",
							evidence: reviewEvidence(work),
							rationale: pass ? "The revision is acceptable" : "The first version is a draft",
							required_rework: pass ? [] : ["Replace the draft"],
							rework_targets: pass ? [] : [{ node_id: "produce", output_id: "content-output" }],
						},
					],
					unresolved_issues: [],
				};
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
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
		expect(await readFile(join(directory.finalSubmission, "result.txt"), "utf8")).toBe("revised");
		expect(result.finalSubmission).toMatchObject({
			directory: directory.finalSubmission,
			files: [{ path: "result.txt", nodeId: "produce", outputId: "content-output" }],
		});
		expect(result.events.some((event) => event.type === "final_submission_materialized")).toBe(true);
		expect(executionRounds).toBe(2);
		expect(reviewRounds).toBe(3);
		expect(result.rounds.filter((item) => item.nodeId === "review-produce")).toHaveLength(2);
		expect(result.submissions.map((item) => item.status)).toEqual(["rejected", "approved"]);
	});

	it("corrects a missing structured submission in the same execution round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-submit-correction-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		const executionRoundIds: string[] = [];
		const reviewRoundIds: string[] = [];
		let executionCalls = 0;
		let reviewCalls = 0;
		const worker: NodeWorker = {
			async runExecution(work) {
				executionCalls++;
				executionRoundIds.push(work.roundId);
				if (executionCalls === 1)
					throw new NodeSubmissionProtocolError("Execution node did not call submit_artifact");
				expect(work.feedback).toContainEqual(
					expect.objectContaining({
						type: "submission_correction",
						issue: "Execution node did not call submit_artifact",
					}),
				);
				await mkdir(join(directory.workspace, "outputs", "produce"), { recursive: true });
				await writeFile(join(directory.workspace, "outputs", "produce", "result.txt"), "corrected");
				return {
					summary: "corrected",
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
				reviewCalls++;
				reviewRoundIds.push(work.roundId);
				if (reviewCalls === 1) throw new NodeSubmissionProtocolError("Review node did not call submit_review");
				expect(work.feedback).toContainEqual(
					expect.objectContaining({
						type: "submission_correction",
						issue: "Review node did not call submit_review",
					}),
				);
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: reviewEvidence(work),
							rationale: "accepted",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				};
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		const result = await runtime.activate(compiled.baseline, fixture.taskInput).then(() => runtime.run());
		expect(result.status).toBe("succeeded");
		expect(executionRoundIds).toEqual(["produce:round:1", "produce:round:1"]);
		expect(reviewRoundIds).toEqual(["review-produce:round:1", "review-produce:round:1"]);
		expect(result.rounds.filter((round) => round.nodeId === "produce")).toHaveLength(1);
		expect(result.rounds.filter((round) => round.nodeId === "review-produce")).toHaveLength(1);
	});

	it("records a structured execution business block without submission correction", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-business-block-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		let executionCalls = 0;
		const worker: NodeWorker = {
			async runExecution() {
				executionCalls++;
				return {
					kind: "blocked",
					report: {
						reason: "Required source access is unavailable",
						missing_conditions: ["Source credentials"],
						attempted_actions: ["Checked supplied materials"],
						evidence: [],
						needed_to_resume: ["Provide source credentials"],
					},
				};
			},
			async runReview() {
				throw new Error("Review must not run for a blocked candidate");
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		const node = result.nodes.find((item) => item.nodeId === "produce");
		expect(result.status).toBe("blocked");
		expect(executionCalls).toBe(1);
		expect(result.submissions).toEqual([]);
		expect(result.rounds[0]).toMatchObject({ status: "blocked" });
		expect(node).toMatchObject({
			status: "blocked",
			block: {
				reason: "Required source access is unavailable",
				missingConditions: ["Source credentials"],
				neededToResume: ["Provide source credentials"],
			},
		});
		expect(result.events.map((event) => event.type)).toContain("node_blocked");
	});

	it("dispatches independent execution nodes concurrently without a global workspace lock", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-parallel-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		fixture.assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((item) =>
				item.id === "producer"
					? { ...structuredClone(item), permissions: { ...item.permissions, writeScopes: ["outputs"] } }
					: item,
			),
		};
		const originalExecution = fixture.workflow.nodes.find((item) => item.kind === "execution")!;
		const originalReview = fixture.workflow.nodes.find((item) => item.kind === "review")!;
		const secondExecution = structuredClone(originalExecution);
		secondExecution.node_id = "produce-two";
		secondExecution.name = "Produce Two";
		if (secondExecution.kind !== "execution") throw new Error("Expected execution node");
		secondExecution.outputs[0].output_id = "content-two";
		secondExecution.outputs[0].path_prefix = "outputs/produce-two";
		secondExecution.agents[0].participant_id = "producer-two";
		secondExecution.agents[0].permissions.write_paths = ["outputs/produce-two"];
		const secondReview = structuredClone(originalReview);
		secondReview.node_id = "review-two";
		secondReview.name = "Review Two";
		if (secondReview.kind !== "review") throw new Error("Expected review node");
		secondReview.agents[0].participant_id = "reviewer-two";
		secondReview.targets = [{ node_id: "produce-two", output_id: "content-two", criterion_refs: ["quality"] }];
		secondReview.inputs = [
			{
				kind: "node_output",
				input_id: "candidate-two",
				source: { node_id: "produce-two", output_id: "content-two" },
				required: true,
				availability: "submitted",
				approval_review_node_ids: [],
			},
		];
		secondReview.allowed_rework_node_ids = ["produce-two"];
		fixture.workflow.nodes.push(secondExecution, secondReview);
		fixture.workflow.completion.required_node_ids.push("produce-two", "review-two");
		fixture.workflow.completion.required_review_node_ids.push("review-two");
		fixture.workflow.completion.final_outputs.push({ node_id: "produce-two", output_id: "content-two" });
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok)
			throw new Error(compiled.report.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
		const directory = await prepareRunDirectory(root, "run-1");
		let active = 0;
		let maximum = 0;
		const order: string[] = [];
		let releaseBoth: (() => void) | undefined;
		const bothStarted = new Promise<void>((resolve) => {
			releaseBoth = resolve;
		});
		let releaseSlow: (() => void) | undefined;
		const slow = new Promise<void>((resolve) => {
			releaseSlow = resolve;
		});
		const worker: NodeWorker = {
			async runExecution(work) {
				const definition = work.node.definition;
				if (definition.kind !== "execution") throw new Error("Expected execution");
				active++;
				maximum = Math.max(maximum, active);
				if (active === 2) releaseBoth?.();
				await bothStarted;
				if (definition.node_id === "produce-two") await slow;
				const output = definition.outputs[0];
				await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
				await writeFile(join(directory.workspace, output.path_prefix, "result.txt"), definition.node_id);
				active--;
				order.push(`${definition.node_id}-done`);
				return {
					summary: "done",
					outputs: [
						{
							output_id: output.output_id,
							files: [{ path: `${output.path_prefix}/result.txt`, media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				if (work.node.definition.node_id === "review-produce") {
					order.push("review-produce-start");
					releaseSlow?.();
				}
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: reviewEvidence(work),
							rationale: "accepted",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				};
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
			{ maxConcurrentNodes: 2 },
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		expect((await runtime.run()).status).toBe("succeeded");
		expect(await readdir(directory.finalSubmission)).toEqual(["result.txt"]);
		expect(maximum).toBe(2);
		expect(order.indexOf("review-produce-start")).toBeLessThan(order.indexOf("produce-two-done"));
	});

	it("blocks an unknown external outcome without creating a quality rework round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-unknown-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		const worker: NodeWorker = {
			async runExecution() {
				throw new NodeWorkerError("external_outcome_unknown", "remote write may have completed", false);
			},
			async runReview() {
				throw new Error("unexpected review");
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		expect(result.status).toBe("blocked");
		expect(result.rounds).toHaveLength(1);
		expect(result.rounds[0].status).toBe("failed");
		expect(result.events.some((event) => event.type === "round_blocked")).toBe(true);
	});

	it("records but does not accept a result from a superseded round", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-late-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		await mkdir(join(directory.workspace, "outputs", "produce"), { recursive: true });
		let release: (() => void) | undefined;
		const pending = new Promise<void>((resolve) => {
			release = resolve;
		});
		const worker: NodeWorker = {
			async runExecution() {
				await pending;
				await writeFile(join(directory.workspace, "outputs", "produce", "result.txt"), "late");
				return {
					summary: "late",
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
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const running = runtime.run();
		while ((await store.read("run-1")).rounds.length === 0) await Promise.resolve();
		await store.mutate("run-1", "supersede-round", { action: "supersede" }, (draft) => {
			const node = draft.nodes.find((item) => item.nodeId === "produce")!;
			node.activeRoundId = "new-round";
			draft.status = "blocked";
			return true;
		});
		release?.();
		const result = await running;
		expect(result.submissions).toHaveLength(0);
		expect(result.events.some((event) => event.type === "late_submission_ignored")).toBe(true);
	});

	it("cancels active work and rejects late round callbacks", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-cancel-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		let markStarted: (() => void) | undefined;
		const started = new Promise<void>((resolve) => {
			markStarted = resolve;
		});
		let rejectExecution: ((error: Error) => void) | undefined;
		let released = false;
		const worker: NodeWorker = {
			runExecution() {
				markStarted?.();
				return new Promise((_, reject) => {
					rejectExecution = reject;
				});
			},
			async runReview() {
				throw new Error("Review must not start after cancellation");
			},
			async releaseRun() {
				released = true;
				rejectExecution?.(new Error("cancelled"));
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const running = runtime.run();
		await started;
		const cancelled = await runtime.cancel("Stopped by test");
		expect(cancelled.status).toBe("cancelled");
		expect(cancelled.phase).toBe("closed");
		expect(cancelled.rounds).toEqual([expect.objectContaining({ roundId: "produce:round:1", status: "cancelled" })]);
		expect(cancelled.submissions).toEqual([]);
		expect(cancelled.events.some((event) => event.type === "run_cancelled")).toBe(true);
		expect(released).toBe(true);
		expect((await running).status).toBe("cancelled");
	});

	it("blocks quality rework beyond the configured limit", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-rework-limit-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		const worker: NodeWorker = {
			async runExecution() {
				throw new Error("Exhausted rework must not execute");
			},
			async runReview() {
				throw new Error("Review must not execute");
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
			{ maxQualityReworkRounds: 0 },
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		await store.mutate("run-1", "force-rework", { nodeId: "produce" }, (state) => {
			const node = state.nodes.find((item) => item.nodeId === "produce");
			if (!node) throw new Error("Missing producer state");
			node.status = "waiting_rework";
			node.nextRound = 2;
			return true;
		});
		const result = await runtime.run();
		expect(result.status).toBe("blocked");
		expect(result.nodes.find((node) => node.nodeId === "produce")?.status).toBe("blocked");
		expect(result.events.some((event) => event.type === "quality_rework_exhausted")).toBe(true);
	});

	it("stops and classifies a round that exceeds its timeout", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-timeout-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture Workflow did not compile");
		const directory = await prepareRunDirectory(root, "run-1");
		let rejectExecution: ((error: Error) => void) | undefined;
		let stoppedRound: string | undefined;
		const worker: NodeWorker = {
			runExecution() {
				return new Promise((_, reject) => {
					rejectExecution = reject;
				});
			},
			async runReview() {
				throw new Error("Review must not execute");
			},
			async stopRound(_runId, _nodeId, _participantId, roundId) {
				stoppedRound = roundId;
				rejectExecution?.(new Error("stopped"));
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
			{ roundTimeoutMs: 5 },
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		expect(result.status).toBe("blocked");
		expect(stoppedRound).toBe("produce:round:1");
		expect(result.events).toContainEqual(
			expect.objectContaining({
				type: "round_blocked",
				data: expect.objectContaining({ kind: "timeout" }),
			}),
		);
	});
});
