import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import {
	compileWorkflow,
	omitConsumedImages,
	renderCurrentRoundContext,
	renderNodeContextFiles,
	type SubmissionRecord,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const imageResult = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [
		{ type: "text", text: `Read ${id}` },
		{ type: "image", data: id, mimeType: "image/png" },
	],
	isError: false,
	timestamp: 1,
});

describe("node context image retention", () => {
	it("omits only images already consumed by a successful assistant response", () => {
		const messages: AgentMessage[] = [
			imageResult("old-image"),
			fauxAssistantMessage("old image reviewed"),
			imageResult("pending-image"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "request too large" }),
		];
		const filtered = omitConsumedImages(messages);
		expect(filtered[0]).toMatchObject({
			role: "toolResult",
			content: [
				{ type: "text", text: "Read old-image" },
				{
					type: "text",
					text: expect.stringMatching(
						/^<omitted_historical_image>\n\n.*already consumed.*\n\n<\/omitted_historical_image>$/,
					),
				},
			],
		});
		expect(filtered[2]).toEqual(messages[2]);
		expect(messages[0]).toEqual(imageResult("old-image"));
	});
});

describe("node prompt projections", () => {
	it("orders stable context by task, contract, role, and protocol", () => {
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const node = compiled.baseline.nodes.find((item) => item.definition.kind === "execution");
		if (!node) throw new Error("Execution node is missing");
		const files = renderNodeContextFiles({
			runId: "run-1",
			roundId: "produce:round:1",
			node,
			inputSubmissions: [],
			inputBindings: [],
			taskContext: {
				rawTask: fixture.taskInput.raw_task,
				objectives: fixture.taskInput.objectives,
				requirements: fixture.taskInput.requirements,
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
			runId: "run-1",
			roundId: "review-produce:round:1",
			inputSubmissions: [],
			inputBindings: [],
			taskContext: {
				rawTask: fixture.taskInput.raw_task,
				objectives: fixture.taskInput.objectives,
				requirements: fixture.taskInput.requirements,
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
			taskContext: { objectives: [], requirements: [], materials: [], unresolvedFacts: [] },
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
		expect(context).toContain('"submission_record":"/sealed/submission-1/submission.json"');
		expect(context).toMatch(/^<ipd_current_round source="runtime">[\s\S]*<\/ipd_current_round>$/);
		expect(context).toContain('"type":"quality_rework"');
		expect(context).not.toContain("task_context");
		expect(context).not.toContain("private_detail");
		expect(context).not.toContain("sha256");
	});
});
