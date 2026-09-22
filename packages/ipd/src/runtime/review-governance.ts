// Register expert assessments and apply the frozen all-required Gate policy without vote counting.
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { AssessmentRecord, EvidenceRecord, ReviewBundleRecord } from "../contracts/governance.ts";
import type { RunState } from "../contracts/runtime.ts";
import type { NodeRoundWork } from "./node-worker.ts";
import { applyFindingResolutions, registerAssessmentFindings, validateFindingResolutions } from "./quality-findings.ts";

export function aggregateAssessments(
	bundle: ReviewBundleRecord,
	assessments: readonly AssessmentRecord[],
): "PASS" | "REWORK" | "BLOCKED" {
	const identities = new Set<string>();
	for (const assessment of assessments) {
		const criterion = bundle.criteria.find((item) => item.criterionId === assessment.criterionId);
		const key = `${assessment.participantId}\0${assessment.criterionId}`;
		if (
			!criterion?.requiredParticipantIds.includes(assessment.participantId) ||
			assessment.bundleId !== bundle.bundleId ||
			assessment.status !== "active" ||
			identities.has(key)
		)
			throw new Error("Assessment is unassigned, duplicated, stale, or belongs to another Bundle");
		identities.add(key);
	}
	for (const criterion of bundle.criteria) {
		const matching = assessments.filter(
			(item) =>
				item.bundleId === bundle.bundleId && item.criterionId === criterion.criterionId && item.status === "active",
		);
		if (
			criterion.requiredParticipantIds.some((id) => !matching.some((item) => item.participantId === id)) ||
			matching.some(
				(item) =>
					item.subjectRevisionIds.slice().sort().join("\0") !==
					criterion.subjectRevisionIds.slice().sort().join("\0"),
			)
		)
			throw new Error(`Missing or incompatible Assessment: ${criterion.criterionId}`);
	}
	const required = assessments.filter((assessment) =>
		bundle.criteria.some((criterion) => criterion.criterionId === assessment.criterionId && criterion.blocking),
	);
	if (required.some((item) => item.result === "BLOCKED")) return "BLOCKED";
	if (required.some((item) => item.result === "FAIL")) return "REWORK";
	return "PASS";
}

export function registerReviewGovernance(
	state: RunState,
	work: NodeRoundWork,
	report: SubmitReview,
	evidence: readonly EvidenceRecord[],
	reviewId: string,
): { failedRevisionIds: string[]; decision: "PASS" | "REWORK" | "BLOCKED" } {
	const bundle = state.governance.reviewBundles.find((item) => item.bundleId === work.reviewBundle?.bundleId);
	if (!bundle || bundle.digest !== work.reviewBundle?.digest) throw new Error("The exact ReviewBundle is unavailable");
	validateFindingResolutions(state, work, report);
	const participantId = work.node.agents[0].participantId;
	const assessments = report.criteria.map((criterion): AssessmentRecord => {
		const subjectRevisionIds = bundle.criteria.find(
			(item) => item.criterionId === criterion.criterion_id,
		)!.subjectRevisionIds;
		const contributions = state.governance.contributions.filter((item) =>
			subjectRevisionIds.includes(item.revisionId),
		);
		const reviewerModel = state.providerRequests.filter((item) => item.attemptId === work.stamp.attemptId).at(-1);
		const producerModels = contributions.map((item) =>
			state.providerRequests.filter((request) => request.attemptId === item.attemptId).at(-1),
		);
		const sameModel =
			reviewerModel && producerModels.length > 0 && producerModels.every(Boolean)
				? producerModels.some(
						(item) => item?.provider === reviewerModel.provider && item.modelId === reviewerModel.modelId,
					)
				: null;
		const reviewerSessionId = state.activeResources.find(
			(resource) => resource.nodeId === bundle.reviewNodeId && resource.participantId === participantId,
		)?.sessionId;
		if (
			bundle.policy.independentProduction &&
			contributions.some(
				(item) =>
					(item.participantId === participantId && item.nodeId === bundle.reviewNodeId) ||
					(reviewerSessionId !== undefined && item.sessionId === reviewerSessionId),
			)
		)
			throw new Error("Reviewer materially contributed to the assessed production");
		return {
			assessmentId: `${reviewId}:assessment:${criterion.criterion_id}`,
			reviewId,
			bundleId: bundle.bundleId,
			criterionId: criterion.criterion_id,
			participantId,
			subjectRevisionIds: [...subjectRevisionIds],
			result: criterion.result,
			evidenceIds: evidence
				.filter((item) => item.criterionId === criterion.criterion_id)
				.map((item) => item.evidenceId),
			rationale: criterion.rationale,
			status: "active",
			independence: {
				productionContributors: contributions.map((item) => `${item.nodeId}/${item.participantId}`),
				sameModel,
			},
		};
	});
	const decision = aggregateAssessments(bundle, assessments);
	if (decision !== report.decision) throw new Error("GateDecision differs from the frozen aggregation policy");
	state.governance.evidence.push(...evidence.map((item) => structuredClone(item)));
	state.governance.assessments.push(...assessments);
	const findings = report.criteria.flatMap((criterion) =>
		registerAssessmentFindings(
			state,
			assessments.find((item) => item.criterionId === criterion.criterion_id)!,
			criterion,
			bundle,
		),
	);
	applyFindingResolutions(state, report, assessments, bundle);
	const blocking = state.governance.findings.filter(
		(finding) =>
			finding.reviewNodeId === bundle.reviewNodeId &&
			finding.blocking &&
			["open", "addressed"].includes(finding.status) &&
			bundle.targets.some(
				(target) => target.nodeId === finding.owner.node_id && target.outputId === finding.owner.output_id,
			),
	);
	if (decision === "PASS" && blocking.length) throw new Error("Unresolved Findings prevent this release");
	const decisionId = `${reviewId}:decision`;
	state.governance.decisions.push({
		decisionId,
		reviewId,
		bundleId: bundle.bundleId,
		assessmentIds: assessments.map((item) => item.assessmentId),
		result: decision,
		blockingFindingIds: blocking.map((item) => item.findingId),
		status: "active",
	});
	if (decision === "PASS")
		state.governance.releases.push({
			releaseId: `${decisionId}:release`,
			decisionId,
			reviewNodeId: bundle.reviewNodeId,
			bundleId: bundle.bundleId,
			subjectRevisionIds: bundle.targets.map((item) => item.revisionId),
			criterionIds: bundle.criteria.filter((item) => item.blocking).map((item) => item.criterionId),
			stageIds: (state.baseline?.workflow.stages ?? [])
				.filter((stage) => stage.exits.some((exit) => exit.gate_node_ids.includes(bundle.reviewNodeId)))
				.map((stage) => stage.stage_id),
			status: "active",
		});
	return {
		decision,
		failedRevisionIds: [
			...new Set(findings.filter((finding) => finding.blocking).map((finding) => finding.affectedRevisionId)),
		],
	};
}
