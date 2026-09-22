import type { BeforeAgentStartEvent, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	compileWorkflow,
	createCurrentRoundContextExtension,
	renderCurrentRoundContext,
	renderNodeContextFiles,
	type SubmissionRecord,
} from "../src/index.ts";
import { buildNodeRoundPrompt, nodeDispatchKind } from "../src/runtime/node-prompts.ts";
import type { NodeRoundWork, RoundFeedback } from "../src/runtime/node-worker.ts";
import { createCompilerFixture, createExecutionStamp } from "./fixtures.ts";

describe("node round system section", () => {
	it("updates only at dispatch and does not register a per-request context mutation", async () => {
		let current: string | undefined = "current-round-1";
		const callbacks: Array<(event: BeforeAgentStartEvent) => void> = [];
		await createCurrentRoundContextExtension(() => current)({
			on: (name: string, handler: (typeof callbacks)[number]) => {
				expect(name).toBe("before_agent_start");
				callbacks.push(handler);
			},
		} as unknown as ExtensionAPI);
		const event = { systemPromptOptions: { sections: { other: "preserved" } } } as unknown as BeforeAgentStartEvent;
		callbacks[0](event);
		expect(event.systemPromptOptions.sections).toEqual({ other: "preserved", ipd_current_round: current });
		current = "current-round-2";
		callbacks[0](event);
		expect(event.systemPromptOptions.sections.ipd_current_round).toBe(current);
		current = undefined;
		callbacks[0](event);
		expect(event.systemPromptOptions.sections).toEqual({ other: "preserved" });
	});
});

describe("node prompt projections", () => {
	it.each([
		["execute", false, undefined],
		["resume", true, "quality_rework"],
		["quality_rework", false, "quality_rework"],
		["mechanical_rework", false, "mechanical_failure"],
		["submission_correction", true, "submission_correction"],
	] as const)("distinguishes %s dispatch from retained feedback", (kind, resuming, feedbackType) => {
		const compiled = compileWorkflow(createCompilerFixture());
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const feedback: RoundFeedback[] = feedbackType
			? [{ type: feedbackType, sourceId: "review-1", issue: "Keep the exact source" }]
			: [];
		const work: NodeRoundWork = {
			stamp: createExecutionStamp("produce:round:2", 1, 3),
			runId: "run-1",
			roundId: "produce:round:2",
			generation: 3,
			resuming,
			node: compiled.baseline.nodes.find((node) => node.definition.kind === "execution")!,
			inputSubmissions: [],
			inputBindings: [],
			forbiddenMutableReadPaths: [],
			taskContext: { materials: [], unresolvedFacts: [] },
			feedback,
		};
		expect(nodeDispatchKind(work)).toBe(kind);
		expect(buildNodeRoundPrompt(work)).toContain(`Dispatch: ${kind}`);
		expect(JSON.parse(renderCurrentRoundContext(work))).toMatchObject({
			dispatch: kind,
			generation: 3,
			feedback: feedback.map((item) => ({ type: item.type, source_id: item.sourceId, issue: item.issue })),
		});
		if (kind === "quality_rework") expect(buildNodeRoundPrompt(work)).toContain("review-1");
		if (kind === "submission_correction") expect(buildNodeRoundPrompt(work)).toContain("not a new quality review");
	});

	it("orders stable context by task, contract, role, and protocol", () => {
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const node = compiled.baseline.nodes.find((item) => item.definition.kind === "execution");
		if (!node) throw new Error("Execution node is missing");
		const files = renderNodeContextFiles({
			stamp: createExecutionStamp("produce:round:1"),
			runId: "run-1",
			roundId: "produce:round:1",
			node,
			inputSubmissions: [],
			inputBindings: [],
			taskContext: {
				rawTask: fixture.taskInput.raw_task,
				materials: fixture.taskInput.materials,
				unresolvedFacts: fixture.taskInput.unresolved_facts,
			},
			forbiddenMutableReadPaths: [],
			feedback: [],
		});
		expect(files.map((file) => file.path.split("/").at(-1))).toEqual([
			"TASK_SCOPE.md",
			"NODE_CONTRACT.md",
			"PROFESSIONAL_ROLE.md",
			"EXECUTION_PROTOCOL.md",
		]);
		expect(files[0].content).toContain("Create a reviewed deliverable");
		expect(files[0].content).toMatch(/^<task_scope>[\s\S]*<\/task_scope>$/);
		expect(files[1].content).toContain("# Authoritative Node Contract");
		expect(files[1].content).toMatch(/^<execution_contract>[\s\S]*<\/execution_contract>$/);
		expect(files[1].content).toContain("## Acceptance Criteria");
		expect(files[1].content).not.toContain('{"constraints"');
		expect(files[2].content).toContain("# Professional Role");
		expect(files[2].content).toMatch(/^<professional_role>[\s\S]*<\/professional_role>$/);
		expect(files[3].content).toContain("# Execution Protocol");

		const reviewNode = compiled.baseline.nodes.find((item) => item.definition.kind === "review");
		if (!reviewNode) throw new Error("Review node is missing");
		const reviewFiles = renderNodeContextFiles({
			stamp: createExecutionStamp("review-produce:round:1"),
			runId: "run-1",
			roundId: "review-produce:round:1",
			inputSubmissions: [],
			inputBindings: [],
			taskContext: {
				rawTask: fixture.taskInput.raw_task,
				materials: fixture.taskInput.materials,
				unresolvedFacts: fixture.taskInput.unresolved_facts,
			},
			node: reviewNode,
			forbiddenMutableReadPaths: [],
			feedback: [],
		});
		expect(reviewFiles.map((file) => file.path.split("/").at(-1))).toEqual([
			"TASK_SCOPE.md",
			"REVIEW_CONTRACT.md",
			"PROFESSIONAL_ROLE.md",
			"REVIEW_PROTOCOL.md",
		]);
		expect(reviewFiles[1].content).toContain("## Review Targets");
		expect(reviewFiles[1].content).toMatch(/^<review_contract>[\s\S]*<\/review_contract>$/);
		expect(reviewFiles[1].content).toContain("## Allowed Rework Targets");
	});

	it("keeps current-round context limited to versioned inputs and structured feedback", () => {
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const node = compiled.baseline.nodes.find((item) => item.definition.kind === "review");
		if (!node) throw new Error("Review node is missing");
		const submission: SubmissionRecord = {
			submissionId: "submission-1",
			contentHash: "a".repeat(64),
			nodeId: "produce",
			roundId: "produce:round:1",
			attemptId: "produce:round:1:attempt:1:term:1:scope:1",
			status: "candidate",
			inputSubmissionIds: [],
			outputs: [
				{
					outputId: "content-output",
					sealedRoot: "/sealed/submission-1",
					manifest: {
						id: "manifest-1",
						runId: "run-1",
						nodeId: "produce",
						attemptId: "produce:round:1",
						contractId: "content-output",
						createdAt: 1,
						inputs: [],
						files: [
							{
								path: "outputs/produce/result.txt",
								mimeType: "text/plain",
								sha256: "b".repeat(64),
								size: 6,
							},
						],
						metadata: {},
					},
				},
			],
			evidence: { private_detail: "load on demand" },
			createdAt: 1,
		};
		const context = renderCurrentRoundContext({
			stamp: createExecutionStamp("review-produce:round:1"),
			runId: "run-1",
			roundId: "review-produce:round:1",
			node,
			inputSubmissions: [submission],
			inputBindings: [
				{
					inputId: "candidate",
					submissionId: submission.submissionId,
					outputId: "content-output",
					approvalReviewNodeIds: [],
				},
			],
			taskContext: { materials: [], unresolvedFacts: [] },
			forbiddenMutableReadPaths: [],
			feedback: [
				{
					type: "quality_rework",
					criterionId: "quality",
					outputId: "content-output",
					issue: "Correct the unsupported claim",
				},
			],
		});
		expect(context).toContain('"submission_record":"/ipd/inputs/candidate/submission.json"');
		expect(JSON.parse(context)).toMatchObject({
			run_id: "run-1",
			round_id: "review-produce:round:1",
			generation: 0,
			dispatch: "quality_rework",
		});
		expect(context).toContain('"type":"quality_rework"');
		expect(context).not.toContain("task_context");
		expect(context).not.toContain("private_detail");
		expect(context).not.toContain("sha256");
	});
});
