// 原子事务内应用候选提交和评审决定；不执行 I/O 或调用 Agent。
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { EvidenceRecord } from "../contracts/governance.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { MechanicalCheckRecord, RunState, SubmissionRecord } from "../contracts/runtime.ts";
import { reconcileHeldAdoptions } from "./adoption-reconciliation.ts";
import { preservationStillValid, registerArtifacts } from "./artifact-governance.ts";
import { executionIsCurrent, finishExecution } from "./execution-control.ts";
import type { NodeRoundWork } from "./node-worker.ts";
import { registerRepairClaims } from "./quality-findings.ts";
import { invalidateOutputRevisions } from "./quality-impact.ts";
import { registerReviewGovernance } from "./review-governance.ts";
import type { RunMutationContext } from "./run-store.ts";
import { addApprovals, type InvalidatedRound, refreshSubmissionStatus, roundInputsAreValid } from "./runtime-state.ts";

export function applyCandidateSubmission(
	draft: RunState,
	event: RunMutationContext,
	work: NodeRoundWork,
	record: SubmissionRecord,
	mechanicalChecks: MechanicalCheckRecord[],
	result: "PASS" | "FAIL" | "ERROR",
	evidence: readonly EvidenceRecord[] = [],
): boolean {
	const node = work.node.definition;
	if (node.kind !== "execution") throw new Error("Invalid node kind for applyCandidateSubmission");

	const current = draft.nodes.find((item) => item.nodeId === node.node_id)!;
	const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
	if (
		!executionIsCurrent(draft, node.node_id, work.roundId, work.stamp) ||
		!roundInputsAreValid(work.node, round, draft) ||
		!preservationStillValid(draft, record)
	) {
		event.emit("late_submission_ignored", { submissionId: record.submissionId }, node.node_id, work.roundId);
		return false;
	}
	record.status = result === "PASS" ? "candidate" : "rejected";
	draft.submissions.push(record);
	draft.mechanicalChecks.push(...mechanicalChecks);
	registerArtifacts(draft, work, record, result === "PASS");
	draft.governance.evidence.push(...evidence.map((item) => structuredClone(item)));
	if (result === "PASS") registerRepairClaims(draft, record);
	finishExecution(draft, node.node_id, work.roundId, work.stamp, "completed", "completed");
	current.activeRoundId = undefined;
	current.status = result === "PASS" ? "waiting_review" : result === "FAIL" ? "waiting_rework" : "blocked";
	round.status = "submitted";
	round.finishedAt = Date.now();
	event.emit("submission_recorded", { result }, node.node_id, work.roundId);
	return true;
}

export function applyReviewDecision(
	draft: RunState,
	event: RunMutationContext,
	work: NodeRoundWork,
	report: SubmitReview,
	evidence: readonly EvidenceRecord[] = [],
): InvalidatedRound[] {
	const node = work.node.definition;
	if (node.kind !== "review") throw new Error("Invalid node kind for applyReviewDecision");
	const invalidatedRounds: InvalidatedRound[] = [];
	const current = draft.nodes.find((item) => item.nodeId === node.node_id)!;
	const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
	if (
		!executionIsCurrent(draft, node.node_id, work.roundId, work.stamp) ||
		!roundInputsAreValid(work.node, round, draft)
	) {
		event.emit("late_review_ignored", { decision: report.decision }, node.node_id, work.roundId);
		return [];
	}
	const reviewId = `${work.stamp.attemptId}:review`;
	const submissionIds = [...new Set(work.inputSubmissions.map((item) => item.submissionId))];
	const governance = registerReviewGovernance(draft, work, report, evidence, reviewId);
	draft.reviews.push({
		reviewId,
		reviewNodeId: node.node_id,
		roundId: work.roundId,
		attemptId: work.stamp.attemptId,
		submissionIds,
		decision: report.decision,
		criteria: report.criteria.map((item) => ({
			criterionId: item.criterion_id,
			result: item.result,
			evidence: item.evidence as JsonValue,
			rationale: item.rationale,
			requiredRework: item.required_rework,
			reworkTargets: item.rework_targets.map((target) => ({
				nodeId: target.node_id,
				outputId: target.output_id,
			})),
			findingIds: draft.governance.findings
				.filter((finding) => finding.assessmentId === `${reviewId}:assessment:${item.criterion_id}`)
				.map((finding) => finding.findingId),
		})),
		status: "active",
		createdAt: Date.now(),
	});
	if (report.decision === "PASS") {
		addApprovals(
			draft,
			reviewId,
			node.node_id,
			node.targets.map((target) => {
				const binding = work.inputBindings.find((item) => {
					const submission = draft.submissions.find((candidate) => candidate.submissionId === item.submissionId);
					return submission?.nodeId === target.node_id && item.outputId === target.output_id;
				});
				if (!binding)
					throw new Error(`Review target has no bound Submission: ${target.node_id}:${target.output_id}`);
				return {
					submissionId: binding.submissionId,
					outputId: target.output_id,
					criterionIds: [...target.criterion_refs],
				};
			}),
		);
		for (const submissionId of submissionIds) refreshSubmissionStatus(draft, submissionId);
		const renewed = reconcileHeldAdoptions(draft);
		if (renewed.length) event.emit("adoptions_renewed", { adoptionIds: renewed });
	} else if (governance.failedRevisionIds.length > 0) {
		const impact = invalidateOutputRevisions(draft, governance.failedRevisionIds, work.roundId);
		invalidatedRounds.push(...impact.invalidatedRounds);
		event.emit(
			"quality_impact_recorded",
			{
				revisionIds: impact.revisionIds,
				reviewIds: impact.reviewIds,
				releaseIds: impact.releaseIds,
				adoptionIds: impact.adoptionIds,
			},
			node.node_id,
			work.roundId,
		);
	}
	finishExecution(draft, node.node_id, work.roundId, work.stamp, "completed", "completed");
	current.activeRoundId = undefined;
	current.status =
		report.decision === "PASS" ? "succeeded" : governance.failedRevisionIds.length > 0 ? "waiting" : "blocked";
	round.status = "completed";
	round.finishedAt = Date.now();
	event.emit("review_recorded", { decision: report.decision }, node.node_id, work.roundId);
	return invalidatedRounds;
}
