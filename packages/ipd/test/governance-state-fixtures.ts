// Build explicit output/bundle/release facts for state-only invalidation fixtures.

import { emptyGovernanceState } from "../src/contracts/governance.ts";
import type { RunState } from "../src/contracts/runtime.ts";
import { artifactRef, boundArtifact } from "../src/runtime/artifact-governance.ts";

export function seedGovernanceFacts(state: RunState): void {
	state.governance = emptyGovernanceState();
	for (const submission of state.submissions)
		for (const output of submission.outputs) {
			const ref = artifactRef(submission, output);
			const round = state.rounds.find((item) => item.roundId === submission.roundId);
			state.governance.artifacts.push({
				...ref,
				manifestHash: "fixture-manifest",
				contractHash: "fixture-contract",
				attemptId: submission.attemptId,
				participantId: `${submission.nodeId}-worker`,
				status: "current",
				bases: (round?.inputBindings ?? []).flatMap((binding) => {
					const source = boundArtifact(state, binding);
					return source ? [{ revisionId: source.revisionId, purpose: binding.purpose ?? "content_basis" }] : [];
				}),
				createdAt: 1,
			});
		}
	for (const review of state.reviews) {
		const targets = review.submissionIds.flatMap((id) => {
			const submission = state.submissions.find((item) => item.submissionId === id)!;
			return submission.outputs.map((output) => artifactRef(submission, output));
		});
		const bundleId = `${review.reviewId}:bundle`;
		const decisionId = `${review.reviewId}:decision`;
		const assessments = review.criteria.map((criterion) => ({
			assessmentId: `${review.reviewId}:${criterion.criterionId}`,
			reviewId: review.reviewId,
			bundleId,
			criterionId: criterion.criterionId,
			participantId: review.reviewNodeId,
			subjectRevisionIds: targets.map((target) => target.revisionId),
			result: criterion.result,
			evidenceIds: [],
			rationale: criterion.rationale,
			status: "active" as const,
			independence: { productionContributors: [], sameModel: null },
		}));
		state.governance.reviewBundles.push({
			bundleId,
			digest: "fixture",
			baselineId: state.baseline!.baselineId,
			reviewNodeId: review.reviewNodeId,
			attemptId: review.attemptId,
			targets,
			inputs: targets,
			criteria: assessments.map((assessment) => ({
				criterionId: assessment.criterionId,
				blocking: true,
				subjectRevisionIds: assessment.subjectRevisionIds,
				requiredParticipantIds: [assessment.participantId],
			})),
			requiredRelations: [],
			policy: { aggregation: "all_required", independentProduction: true },
			backgroundHash: "fixture",
			createdAt: 1,
		});
		state.governance.assessments.push(...assessments);
		state.governance.decisions.push({
			decisionId,
			reviewId: review.reviewId,
			bundleId,
			assessmentIds: assessments.map((item) => item.assessmentId),
			result: "PASS",
			blockingFindingIds: [],
			status: "active",
		});
		state.governance.releases.push({
			releaseId: `${decisionId}:release`,
			decisionId,
			reviewNodeId: review.reviewNodeId,
			bundleId,
			subjectRevisionIds: targets.map((target) => target.revisionId),
			criterionIds: review.criteria.map((criterion) => criterion.criterionId),
			stageIds: [],
			status: "active",
		});
	}
	for (const round of state.rounds)
		for (const binding of round.inputBindings) {
			const ref = boundArtifact(state, binding)!;
			binding.revisionId = ref.revisionId;
			binding.releaseIds = state.governance.releases
				.filter(
					(release) =>
						release.subjectRevisionIds.includes(ref.revisionId) &&
						binding.approvalReviewNodeIds.includes(release.reviewNodeId),
				)
				.map((release) => release.releaseId);
		}
	for (const submission of state.submissions) {
		const round = state.rounds.find((item) => item.roundId === submission.roundId);
		state.governance.adoptions.push({
			adoptionId: `${submission.submissionId}:adoption`,
			submissionId: submission.submissionId,
			attemptId: submission.attemptId,
			inputRevisionIds: (round?.inputBindings ?? []).flatMap((binding) =>
				binding.revisionId ? [binding.revisionId] : [],
			),
			releaseIds: (round?.inputBindings ?? []).flatMap((binding) => binding.releaseIds ?? []),
			status: "active",
			createdAt: 1,
		});
	}
}
