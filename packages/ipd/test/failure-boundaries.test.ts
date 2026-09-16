import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	compileWorkflow,
	FileRunStore,
	MechanicalChecker,
	type NodeWorker,
	NodeWorkerError,
	prepareRunDirectory,
	SubmissionStore,
	validateReplan,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("M7 failure boundaries", () => {
	// Pi owns model retries. Even an explicitly retryable diagnostic must not
	// make Runtime replay a whole node (or treat it as submission correction).
	it.each([
		new NodeWorkerError("transient", "native retry exhausted", true),
		new NodeWorkerError("external_outcome_unknown", "write outcome is unknown", false),
		new NodeWorkerError("cancelled", "cancelled work", false),
	])("does not replay work after $kind", async (failure) => {
		const root = await mkdtemp(join(tmpdir(), "ipd-failure-boundary-"));
		try {
			const fixture = createCompilerFixture();
			const compiled = compileWorkflow(fixture);
			if (!compiled.ok) throw new Error("Fixture did not compile");
			const directory = await prepareRunDirectory(root, "run-1");
			const store = new FileRunStore();
			store.bind("run-1", directory.stateFile);
			let calls = 0;
			const worker: NodeWorker = {
				async runExecution() {
					calls++;
					throw failure;
				},
				async runReview() {
					throw new Error("A failed execution must not reach review");
				},
			};
			const runtime = new WorkflowRuntime(
				store,
				directory,
				worker,
				new SubmissionStore(),
				new MechanicalChecker(new CheckExecutorRegistry()),
			);
			await runtime.activate(compiled.baseline, fixture.taskInput);
			const state = await runtime.run();
			expect(calls).toBe(1);
			expect(state.status).toBe(failure.kind === "external_outcome_unknown" ? "blocked" : "paused");
			expect(state.submissions).toHaveLength(0);
			expect(state.rounds).toHaveLength(1);
			if (failure.kind === "external_outcome_unknown")
				await expect(runtime.resume()).rejects.toThrow("explicit reconciliation");
			expect(state.events).toContainEqual(
				expect.objectContaining({
					type: "round_blocked",
					data: expect.objectContaining({ kind: failure.kind }),
				}),
			);
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	});

	it("rejects replans that change frozen criteria or responsible participants", () => {
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const candidate = structuredClone(compiled.baseline);
		candidate.workflow.criteria[0].description = "Changed acceptance standard";
		candidate.nodes[0].agents[0].participantId = "replacement";
		const errors = validateReplan(compiled.baseline, candidate, {
			runId: "run-1",
			revision: 1,
			phase: "execute",
			status: "running",
			baseline: compiled.baseline,
			nodes: [{ nodeId: "produce", kind: "execution", status: "waiting_review", nextRound: 2 }],
			rounds: [
				{
					roundId: "produce:round:1",
					nodeId: "produce",
					index: 1,
					status: "submitted",
					inputSubmissionIds: [],
					inputBindings: [],
					startedAt: 1,
					finishedAt: 2,
				},
			],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		});
		expect(errors).toContain("Replan cannot change frozen acceptance criteria");
		expect(errors).toContain("Replan cannot replace responsible participants for produce");
	});
});
