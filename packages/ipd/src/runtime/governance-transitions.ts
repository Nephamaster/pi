// 原子事务内应用候选提交和评审决定；不执行 I/O 或调用 Agent。
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { MechanicalCheckRecord, RunState, SubmissionRecord } from "../contracts/runtime.ts";
import { executionIsCurrent, finishExecution } from "./execution-control.ts";
import type { NodeRoundWork } from "./node-worker.ts";
import type { RunMutationContext } from "./run-store.ts";
import {
	addApprovals,
	type InvalidatedRound,
	invalidateFromNode,
	markReworkAddressed,
	refreshSubmissionStatus,
	resolveReworkForTargets,
	roundInputsAreValid,
	supersedePendingRework,
} from "./runtime-state.ts";

export function applyCandidateSubmission(
	draft: RunState,
	event: RunMutationContext,
	work: NodeRoundWork,
	record: SubmissionRecord,
	mechanicalChecks: MechanicalCheckRecord[],
	result: "PASS" | "FAIL" | "ERROR",
): boolean {
	const node = work.node.definition;
	if (node.kind !== "execution") throw new Error("Invalid node kind for applyCandidateSubmission");

	const current = draft.nodes.find((item) => item.nodeId === node.node_id)!;
	const round = draft.rounds.find((item) => item.roundId === work.roundId)!;
	if (
		!executionIsCurrent(draft, node.node_id, work.roundId, work.stamp) ||
		!roundInputsAreValid(work.node, round, draft)
	) {
		event.emit("late_submission_ignored", { submissionId: record.submissionId }, node.node_id, work.roundId);
		return false;
	}
	record.status = result === "PASS" ? "candidate" : "rejected";
	draft.submissions.push(record);
	draft.mechanicalChecks.push(...mechanicalChecks);
	if (result === "PASS") markReworkAddressed(draft, node.node_id);
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
	const reworkNodeIds = [
		...new Set(report.criteria.flatMap((criterion) => criterion.rework_targets.map((target) => target.node_id))),
	];
	if (report.decision === "REWORK") supersedePendingRework(draft, reworkNodeIds);
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
				status: "pending",
			})),
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
		resolveReworkForTargets(draft, node.targets);
		for (const submissionId of submissionIds) refreshSubmissionStatus(draft, submissionId);
	} else if (report.decision === "REWORK") {
		for (const targetId of reworkNodeIds)
			invalidatedRounds.push(...invalidateFromNode(draft, targetId, work.roundId));
	}
	finishExecution(draft, node.node_id, work.roundId, work.stamp, "completed", "completed");
	current.activeRoundId = undefined;
	current.status = report.decision === "PASS" ? "succeeded" : report.decision === "REWORK" ? "waiting" : "blocked";
	round.status = "completed";
	round.finishedAt = Date.now();
	event.emit("review_recorded", { decision: report.decision }, node.node_id, work.roundId);
	return invalidatedRounds;
}
