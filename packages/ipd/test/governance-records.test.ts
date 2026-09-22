import { describe, expect, it } from "vitest";
import type { AssessmentRecord, FindingRecord } from "../src/contracts/governance.ts";
import { compileWorkflow, type NodeRoundWork, type RunState, type SubmissionRecord } from "../src/index.ts";
import { reconcileHeldAdoptions } from "../src/runtime/adoption-reconciliation.ts";
import { artifactRef, versionRelationsSatisfied } from "../src/runtime/artifact-governance.ts";
import {
	applyFindingResolutions,
	registerRepairClaims,
	validateFindingResolutions,
} from "../src/runtime/quality-findings.ts";
import { invalidateOutputRevisions } from "../src/runtime/quality-impact.ts";
import { buildReviewBundle } from "../src/runtime/review-bundle.ts";
import { registerReviewGovernance } from "../src/runtime/review-governance.ts";
import { preservedOutputsFor } from "../src/runtime/submission-governance.ts";
import { createCompilerFixture, createEmptyRuntimeRecords, createExecutionStamp } from "./fixtures.ts";
import { passReport } from "./governance-fixtures.ts";
import { seedGovernanceFacts } from "./governance-state-fixtures.ts";

function fixture() {
	const input = createCompilerFixture();
	const compiled = compileWorkflow(input);
	if (!compiled.ok) throw new Error("Fixture does not compile");
	const submission: SubmissionRecord = {
		submissionId: "submission-2",
		contentHash: "hash",
		nodeId: "produce",
		roundId: "produce:round:2",
		attemptId: "produce:attempt:2",
		status: "candidate",
		inputSubmissionIds: [],
		outputs: [
			{
				outputId: "content-output",
				sealedRoot: "/sealed",
				manifest: {
					id: "artifact",
					runId: "run-1",
					nodeId: "produce",
					attemptId: "produce:attempt:2",
					contractId: "content-output",
					createdAt: 1,
					inputs: [],
					files: [{ path: "outputs/produce/result.txt", mimeType: "text/plain", size: 2, sha256: "a".repeat(64) }],
					metadata: {},
				},
			},
		],
		evidence: [],
		createdAt: 1,
	};
	const state: RunState = {
		...createEmptyRuntimeRecords(),
		runId: "run-1",
		revision: 1,
		status: "running",
		phase: "execute",
		baseline: compiled.baseline,
		taskInput: input.taskInput,
		nodes: compiled.baseline.nodes.map((node) => ({
			nodeId: node.definition.node_id,
			kind: node.definition.kind,
			status: "waiting",
			scopeEpoch: 1,
			nextRound: 1,
		})),
		submissions: [submission],
		rounds: [],
		reviews: [],
		approvals: [],
		mechanicalChecks: [],
		events: [],
		operations: {},
	};
	seedGovernanceFacts(state);
	const node = compiled.baseline.nodes.find((item) => item.definition.kind === "review")!;
	const binding = {
		inputId: "candidate",
		submissionId: submission.submissionId,
		outputId: "content-output",
		approvalReviewNodeIds: [],
	};
	const stamp = createExecutionStamp("review:round:2");
	const bundle = buildReviewBundle(state, node, stamp.attemptId, [binding]);
	state.governance.reviewBundles.push(bundle);
	const findings = ["F1", "F2"].map(
		(id): FindingRecord => ({
			findingId: id,
			assessmentId: `original:${id}`,
			reviewNodeId: node.definition.node_id,
			criterionId: "quality",
			observedRevisionIds: ["old-revision"],
			observation: id,
			rootCause: { status: "supported", explanation: "Exact cause" },
			owner: { node_id: "produce", output_id: "content-output" },
			affectedRevisionId: "old-revision",
			expectedCondition: id,
			blocking: true,
			status: "open",
			claims: [],
			createdAt: 0,
		}),
	);
	state.governance.findings.push(...findings);
	const work: NodeRoundWork = {
		stamp,
		runId: state.runId,
		roundId: "review:round:2",
		node,
		inputSubmissions: [submission],
		inputBindings: [binding],
		taskContext: { materials: [], unresolvedFacts: [] },
		forbiddenMutableReadPaths: [],
		feedback: [],
		findings,
		reviewBundle: bundle,
	};
	return { state, submission, work, findings, bundle };
}

describe("precise governance records", () => {
	it("rejects a reviewer that actually participated in production even with a different role label", () => {
		const { state, work, bundle } = fixture();
		state.governance.findings = [];
		work.findings = [];
		state.activeResources.push({
			nodeId: work.node.definition.node_id,
			participantId: work.node.agents[0].participantId,
			sessionId: "same-real-session",
		});
		state.governance.contributions.push({
			contributionId: "production",
			participantId: "different-label",
			nodeId: "produce",
			attemptId: "producer",
			revisionId: bundle.targets[0].revisionId,
			kind: "production",
			sessionId: "same-real-session",
		});
		expect(() => registerReviewGovernance(state, work, passReport(work), [], "review")).toThrow(
			"materially contributed",
		);
	});
	it("rejects cross-owner and invalidated output preservation", () => {
		const { state, submission, work } = fixture();
		work.node = state.baseline!.nodes.find((node) => node.definition.kind === "execution")!;
		const ref = artifactRef(submission, submission.outputs[0]);
		work.preservableOutputs = [
			{ outputId: ref.outputId, submissionId: ref.submissionId, revisionId: ref.revisionId },
		];
		const candidate = {
			summary: "retained",
			outputs: [],
			preserved_outputs: [{ output_id: ref.outputId, submission_id: "another-owner", revision_id: ref.revisionId }],
			evidence: [],
			metadata: {},
		};
		expect(() => preservedOutputsFor(state, work, candidate)).toThrow("outside this contract");
		candidate.preserved_outputs[0].submission_id = ref.submissionId;
		state.governance.artifacts[0].status = "invalidated";
		expect(() => preservedOutputsFor(state, work, candidate)).toThrow("invalidated");
	});

	it("a repair claim and re-verification of F1 cannot close or hide F2 on the same output", () => {
		const { state, submission, work, findings, bundle } = fixture();
		submission.resolutionClaims = [
			{
				findingId: "F1",
				outputId: "content-output",
				explanation: "Fixed only F1",
				evidence: ["outputs/produce/result.txt"],
			},
		];
		registerRepairClaims(state, submission);
		expect(findings.map((finding) => finding.status)).toEqual(["addressed", "open"]);
		const report = passReport(work);
		report.criteria[0].finding_resolutions = [{ finding_id: "F1", result: "resolved", reason: "F1 is verified" }];
		expect(() => validateFindingResolutions(state, work, report)).toThrow("F2");
		const assessment: AssessmentRecord = {
			assessmentId: "verification-F1",
			reviewId: "review",
			bundleId: bundle.bundleId,
			criterionId: "quality",
			participantId: "reviewer",
			subjectRevisionIds: bundle.targets.map((item) => item.revisionId),
			result: "PASS",
			evidenceIds: [],
			rationale: "F1 fixed",
			status: "active",
			independence: { productionContributors: [], sameModel: null },
		};
		applyFindingResolutions(state, report, [assessment], bundle);
		expect(findings.map((finding) => finding.status)).toEqual(["resolved", "open"]);
		expect(findings[0].resolution?.revisionId).toBe(artifactRef(submission, submission.outputs[0]).revisionId);
	});

	it("does not let a different Reviewer close another Gate's Finding or accept a claim without verification", () => {
		const { state, submission, work, findings } = fixture();
		const report = passReport(work);
		expect(() => validateFindingResolutions(state, work, report)).toThrow("repair claim");
		submission.resolutionClaims = findings.map((finding) => ({
			findingId: finding.findingId,
			outputId: finding.owner.output_id,
			explanation: "Repair",
			evidence: ["result.txt"],
		}));
		registerRepairClaims(state, submission);
		findings[1].reviewNodeId = "other-gate";
		expect(() => validateFindingResolutions(state, work, report)).toThrow("not authorized");
	});

	it("preserves a test report's content when its defective test subject is invalidated", () => {
		const { state } = fixture();
		state.governance.findings = [];
		const first = state.governance.artifacts[0];
		state.governance.artifacts.push({
			...structuredClone(first),
			revisionId: "test-report",
			nodeId: "test",
			bases: [{ revisionId: first.revisionId, purpose: "test_subject" }],
		});
		const impact = invalidateOutputRevisions(state, [first.revisionId]);
		expect(impact.revisionIds).toEqual([first.revisionId]);
		expect(state.governance.artifacts.find((item) => item.revisionId === "test-report")?.status).toBe("current");
	});

	it("rejects a bundle combining A2 with B1 produced from A1", () => {
		const { state, submission } = fixture();
		const a1 = state.governance.artifacts[0];
		state.governance.artifacts.push({ ...a1, revisionId: "A2" });
		const a2 = structuredClone(submission);
		a2.submissionId = "new-a";
		a2.outputs[0].revisionId = "A2";
		state.submissions.push(a2);
		const b = structuredClone(submission);
		b.submissionId = "B1";
		b.nodeId = "B";
		b.outputs[0].revisionId = "B1-output";
		state.submissions.push(b);
		state.governance.artifacts.push({
			...a1,
			...artifactRef(b, b.outputs[0]),
			bases: [{ revisionId: a1.revisionId, purpose: "content_basis" }],
		});
		expect(
			versionRelationsSatisfied(
				state,
				[a2, b].map((item) => ({
					inputId: item.nodeId,
					submissionId: item.submissionId,
					outputId: item.outputs[0].outputId,
					approvalReviewNodeIds: [],
				})),
			),
		).toBe(false);
	});

	it("renews only release credentials, preserving the original Attempt input history", () => {
		const { state, submission } = fixture();
		state.governance.findings = [];
		const inputId = state.governance.artifacts[0].revisionId;
		const consumer = structuredClone(submission);
		consumer.submissionId = "consumer";
		consumer.nodeId = "consumer";
		consumer.roundId = "consumer:1";
		consumer.outputs[0].revisionId = "consumer-output";
		state.submissions.push(consumer);
		state.governance.artifacts.push({
			...state.governance.artifacts[0],
			...artifactRef(consumer, consumer.outputs[0]),
			bases: [{ revisionId: inputId, purpose: "content_basis" }],
		});
		state.rounds.push({
			roundId: "consumer:1",
			nodeId: "consumer",
			index: 1,
			status: "submitted",
			inputSubmissionIds: [submission.submissionId],
			inputBindings: [
				{
					inputId: "source",
					submissionId: submission.submissionId,
					outputId: "content-output",
					approvalReviewNodeIds: ["gate"],
					releaseIds: ["old-release"],
				},
			],
			startedAt: 1,
		});
		state.governance.adoptions.push({
			adoptionId: "old-adoption",
			submissionId: "consumer",
			attemptId: "original-attempt",
			inputRevisionIds: [inputId],
			releaseIds: ["old-release"],
			status: "held",
			createdAt: 1,
		});
		state.governance.assessments.push({
			assessmentId: "new-assessment",
			reviewId: "gate-review",
			bundleId: "new-bundle",
			criterionId: "quality",
			participantId: "reviewer",
			subjectRevisionIds: [inputId],
			result: "PASS",
			evidenceIds: [],
			rationale: "Reverified source",
			status: "active",
			independence: { productionContributors: [], sameModel: null },
		});
		state.governance.decisions.push({
			decisionId: "new-decision",
			reviewId: "gate-review",
			bundleId: "new-bundle",
			assessmentIds: ["new-assessment"],
			result: "PASS",
			blockingFindingIds: [],
			status: "active",
		});
		state.governance.releases.push({
			releaseId: "new-release",
			decisionId: "new-decision",
			reviewNodeId: "gate",
			bundleId: "new-bundle",
			subjectRevisionIds: [inputId],
			criterionIds: ["quality"],
			stageIds: [],
			status: "active",
		});
		expect(reconcileHeldAdoptions(state)).toHaveLength(1);
		expect(state.governance.adoptions.at(-1)).toMatchObject({
			replaces: "old-adoption",
			releaseIds: ["new-release"],
			attemptId: "original-attempt",
			status: "active",
		});
		expect(state.rounds[0].inputBindings[0].releaseIds).toEqual(["old-release"]);
	});
});
