// Keep Finding identity and resolution independent from Review validity and node status.
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { AssessmentRecord, FindingRecord, ReviewBundleRecord } from "../contracts/governance.ts";
import type { RunState, SubmissionRecord } from "../contracts/runtime.ts";
import { artifactRef } from "./artifact-governance.ts";
import type { NodeRoundWork, RoundFeedback } from "./node-worker.ts";

export function assignedFindings(state: RunState, nodeId: string): FindingRecord[] {
	return state.governance.findings
		.filter(
			(finding) =>
				["open", "addressed"].includes(finding.status) &&
				(finding.owner.node_id === nodeId || finding.reviewNodeId === nodeId),
		)
		.map((finding) => structuredClone(finding));
}

export function findingFeedback(state: RunState, nodeId: string): RoundFeedback[] {
	return assignedFindings(state, nodeId)
		.filter((finding) => finding.owner.node_id === nodeId)
		.map((finding) => ({
			type: "quality_rework",
			findingId: finding.findingId,
			sourceId: finding.assessmentId,
			criterionId: finding.criterionId,
			outputId: finding.owner.output_id,
			issue: finding.expectedCondition,
			expectedCorrection: finding.expectedCondition,
			evidenceRef: finding.assessmentId,
		}));
}

export function registerRepairClaims(state: RunState, submission: SubmissionRecord): void {
	for (const claim of submission.resolutionClaims ?? []) {
		const finding = state.governance.findings.find((item) => item.findingId === claim.findingId);
		const output = submission.outputs.find((item) => item.outputId === claim.outputId);
		if (
			!finding ||
			!output ||
			finding.owner.node_id !== submission.nodeId ||
			finding.owner.output_id !== output.outputId ||
			!["open", "addressed"].includes(finding.status)
		)
			throw new Error(`Invalid Finding claim ${claim.findingId}`);
		finding.claims.push({
			submissionId: submission.submissionId,
			revisionId: artifactRef(submission, output).revisionId,
			evidence: [...claim.evidence],
			explanation: claim.explanation,
		});
		finding.status = "addressed";
	}
}

export function registerAssessmentFindings(
	state: RunState,
	assessment: AssessmentRecord,
	criterion: SubmitReview["criteria"][number],
	bundle: ReviewBundleRecord,
): FindingRecord[] {
	if (criterion.result !== "FAIL") return [];
	const blocking = bundle.criteria.find((item) => item.criterionId === criterion.criterion_id)!.blocking;
	const findings: FindingRecord[] = [];
	for (const target of criterion.rework_targets) {
		const subject = bundle.inputs.find(
			(item) => item.nodeId === target.node_id && item.outputId === target.output_id,
		);
		if (!subject) throw new Error("Finding target is outside the ReviewBundle");
		if (
			!assessment.subjectRevisionIds.includes(subject.revisionId) &&
			!assessment.subjectRevisionIds.some((id) =>
				state.governance.artifacts
					.find((artifact) => artifact.revisionId === id)
					?.bases.some((basis) => basis.purpose === "content_basis" && basis.revisionId === subject.revisionId),
			)
		)
			throw new Error("Remediation mapping has no actual version dependency");
		for (const issue of new Set(criterion.required_rework)) {
			const findingId = `${assessment.assessmentId}:finding:${findings.length + 1}`;
			const finding: FindingRecord = {
				findingId,
				assessmentId: assessment.assessmentId,
				reviewNodeId: bundle.reviewNodeId,
				criterionId: criterion.criterion_id,
				observedRevisionIds: [...assessment.subjectRevisionIds],
				observation: criterion.rationale,
				rootCause: criterion.root_cause
					? { ...criterion.root_cause }
					: {
							status: "unknown",
							explanation: "The reviewer assigned remediation; no separate root-cause proof was supplied.",
						},
				owner: { ...target },
				affectedRevisionId: subject.revisionId,
				expectedCondition: issue,
				blocking,
				status: "open",
				claims: [],
				createdAt: Date.now(),
			};
			state.governance.findings.push(finding);
			findings.push(finding);
		}
	}
	return findings;
}

export function validateFindingResolutions(state: RunState, work: NodeRoundWork, report: SubmitReview): void {
	const bundle = work.reviewBundle;
	if (!bundle) return;
	const resolved = new Set<string>();
	for (const criterion of report.criteria) {
		const subjects =
			bundle.criteria.find((item) => item.criterionId === criterion.criterion_id)?.subjectRevisionIds ?? [];
		for (const resolution of criterion.finding_resolutions ?? []) {
			const finding = state.governance.findings.find((item) => item.findingId === resolution.finding_id);
			if (
				!finding ||
				finding.reviewNodeId !== bundle.reviewNodeId ||
				finding.criterionId !== criterion.criterion_id ||
				!["open", "addressed"].includes(finding.status) ||
				resolved.has(finding.findingId)
			)
				throw new Error(`Finding resolution is not authorized: ${resolution.finding_id}`);
			const target = bundle.inputs.find(
				(item) => item.nodeId === finding.owner.node_id && item.outputId === finding.owner.output_id,
			);
			const mapped =
				work.node.definition.kind === "review" &&
				work.node.definition.remediation_mappings?.some(
					(mapping) =>
						mapping.criterion_id === criterion.criterion_id &&
						mapping.owner.node_id === finding.owner.node_id &&
						mapping.owner.output_id === finding.owner.output_id,
				);
			if (!target || (!subjects.includes(target.revisionId) && !mapped))
				throw new Error(`Finding resolution targets the wrong version: ${finding.findingId}`);
			if (
				mapped &&
				!criterion.evidence.some(
					(item) =>
						item.submission_id === target.submissionId &&
						item.output_id === target.outputId &&
						item.node_id === target.nodeId,
				)
			)
				throw new Error("Mapped Finding verification requires evidence for the exact upstream owner");
			if (
				resolution.result === "resolved" &&
				(criterion.result !== "PASS" ||
					!finding.claims.some(
						(claim) => claim.revisionId === target.revisionId && claim.submissionId === target.submissionId,
					))
			)
				throw new Error(
					`Finding ${finding.findingId} requires a repair claim and PASS for the exact revised output`,
				);
			if (resolution.result === "superseded") {
				const replacement = state.governance.findings.find(
					(item) => item.findingId === resolution.replacement_finding_id,
				);
				if (
					!replacement ||
					replacement.findingId === finding.findingId ||
					replacement.reviewNodeId !== finding.reviewNodeId ||
					replacement.criterionId !== finding.criterionId ||
					!["open", "addressed"].includes(replacement.status) ||
					replacement.owner.node_id !== finding.owner.node_id ||
					replacement.owner.output_id !== finding.owner.output_id
				)
					throw new Error("Finding replacement must be an existing related open issue");
			}
			resolved.add(finding.findingId);
		}
	}
	if (report.decision === "PASS") {
		const uncovered = state.governance.findings.filter(
			(finding) =>
				finding.reviewNodeId === bundle.reviewNodeId &&
				finding.blocking &&
				["open", "addressed"].includes(finding.status) &&
				!resolved.has(finding.findingId),
		);
		if (uncovered.length)
			throw new Error(`PASS omits unresolved Findings: ${uncovered.map((finding) => finding.findingId).join(", ")}`);
	}
}

export function applyFindingResolutions(
	state: RunState,
	report: SubmitReview,
	assessments: readonly AssessmentRecord[],
	bundle: ReviewBundleRecord,
): void {
	for (const criterion of report.criteria)
		for (const resolution of criterion.finding_resolutions ?? []) {
			const finding = state.governance.findings.find((item) => item.findingId === resolution.finding_id)!;
			const assessment = assessments.find((item) => item.criterionId === criterion.criterion_id)!;
			const target = bundle.inputs.find(
				(item) => item.nodeId === finding.owner.node_id && item.outputId === finding.owner.output_id,
			)!;
			finding.status = resolution.result;
			finding.resolution = {
				assessmentId: assessment.assessmentId,
				revisionId: target.revisionId,
				reason: resolution.reason,
				...(resolution.replacement_finding_id ? { replacementFindingId: resolution.replacement_finding_id } : {}),
			};
		}
}
