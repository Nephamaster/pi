import { describe, expect, it } from "vitest";
import { compileWorkflow, type NodeWorker, NodeWorkerError, RetryingNodeWorker, validateReplan } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("M7 failure boundaries", () => {
	it("retries transient failures in the same work round", async () => {
		let calls = 0;
		const feedback: string[][] = [];
		const delegate: NodeWorker = {
			async runExecution(work) {
				feedback.push([...work.feedback]);
				calls++;
				if (calls < 3) throw new NodeWorkerError("transient", "temporary provider failure");
				return { summary: "ok", outputs: [], evidence: [], metadata: {} };
			},
			async runReview() {
				throw new Error("unused");
			},
		};
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const node = compiled.baseline.nodes[0];
		const work = {
			runId: "run-1",
			roundId: "round-1",
			node,
			inputSubmissions: [],
			inputBindings: [],
			taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
			forbiddenMutableReadPaths: [],
			feedback: [],
		};
		await new RetryingNodeWorker(delegate, 3, async () => {}).runExecution(work);
		expect(calls).toBe(3);
		expect(feedback).toEqual([
			[],
			["temporary provider failure"],
			["temporary provider failure", "temporary provider failure"],
		]);
	});

	it("does not retry an unknown external outcome", async () => {
		let calls = 0;
		const delegate: NodeWorker = {
			async runExecution() {
				calls++;
				throw new NodeWorkerError("external_outcome_unknown", "write outcome is unknown", false);
			},
			async runReview() {
				throw new Error("unused");
			},
		};
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture did not compile");
		await expect(
			new RetryingNodeWorker(delegate).runExecution({
				runId: "run-1",
				roundId: "round-1",
				node: compiled.baseline.nodes[0],
				inputSubmissions: [],
				inputBindings: [],
				taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
				forbiddenMutableReadPaths: [],
				feedback: [],
			}),
		).rejects.toMatchObject({ kind: "external_outcome_unknown" });
		expect(calls).toBe(1);
	});

	it("does not retry a round after Runtime stops it", async () => {
		let calls = 0;
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const work = {
			runId: "run-1",
			roundId: "round-1",
			node: compiled.baseline.nodes[0],
			inputSubmissions: [],
			inputBindings: [],
			taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
			forbiddenMutableReadPaths: [],
			feedback: [],
		};
		const delegate: NodeWorker = {
			async runExecution() {
				calls++;
				throw new NodeWorkerError("transient", "temporary provider failure");
			},
			async runReview() {
				throw new Error("unused");
			},
		};
		let retrying: RetryingNodeWorker;
		retrying = new RetryingNodeWorker(delegate, 3, async () => {
			await retrying.stopRound("run-1", "produce", "producer", "round-1");
		});
		await expect(retrying.runExecution(work)).rejects.toThrow("Round is no longer active");
		expect(calls).toBe(1);
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
