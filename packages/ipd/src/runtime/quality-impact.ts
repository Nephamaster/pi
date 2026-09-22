// Revoke content, judgment, and release prerequisites along exact output-version dependencies.
import type { RunState } from "../contracts/runtime.ts";
import { artifactRef, boundArtifact } from "./artifact-governance.ts";
import { incrementScopeEpoch, interruptActiveExecution } from "./execution-control.ts";

export interface QualityImpact {
	revisionIds: string[];
	reviewIds: string[];
	releaseIds: string[];
	adoptionIds: string[];
	invalidatedRounds: Array<{ nodeId: string; roundId: string }>;
}

export function invalidateOutputRevisions(
	state: RunState,
	roots: readonly string[],
	excludeRoundId?: string,
): QualityImpact {
	const affected = new Set(roots);
	let expanded = true;
	while (expanded) {
		expanded = false;
		for (const artifact of state.governance.artifacts) {
			if (
				affected.has(artifact.revisionId) ||
				!artifact.bases.some((basis) => basis.purpose === "content_basis" && affected.has(basis.revisionId))
			)
				continue;
			affected.add(artifact.revisionId);
			expanded = true;
		}
	}
	for (const artifact of state.governance.artifacts)
		if (affected.has(artifact.revisionId)) artifact.status = "invalidated";
	const reviews = new Set<string>();
	const releases = new Set<string>();
	const held = new Set<string>();
	let propagation = true;
	while (propagation) {
		propagation = false;
		for (const bundle of state.governance.reviewBundles) {
			if (
				!bundle.inputs.some(
					(input) =>
						affected.has(input.revisionId) ||
						state.governance.adoptions.some(
							(adoption) => adoption.submissionId === input.submissionId && held.has(adoption.adoptionId),
						),
				)
			)
				continue;
			for (const assessment of state.governance.assessments.filter((item) => item.bundleId === bundle.bundleId)) {
				assessment.status = "stale";
				if (!reviews.has(assessment.reviewId)) {
					reviews.add(assessment.reviewId);
					propagation = true;
				}
			}
		}
		for (const review of state.reviews) if (reviews.has(review.reviewId)) review.status = "stale";
		for (const decision of state.governance.decisions) if (reviews.has(decision.reviewId)) decision.status = "stale";
		for (const release of state.governance.releases) {
			if (
				!state.governance.decisions.some(
					(decision) => decision.decisionId === release.decisionId && decision.status === "stale",
				)
			)
				continue;
			release.status = "revoked";
			if (!releases.has(release.releaseId)) {
				releases.add(release.releaseId);
				propagation = true;
			}
		}
		for (const approval of state.approvals) if (reviews.has(approval.reviewId)) approval.status = "stale";
		for (const adoption of state.governance.adoptions) {
			if (
				adoption.status !== "active" ||
				(!adoption.inputRevisionIds.some((id) => affected.has(id)) &&
					!adoption.releaseIds.some((id) => releases.has(id)))
			)
				continue;
			adoption.status = "held";
			held.add(adoption.adoptionId);
			propagation = true;
		}
	}
	for (const submission of state.submissions) {
		const impacted = submission.outputs.filter((output) => affected.has(artifactRef(submission, output).revisionId));
		const runtime = state.nodes.find((node) => node.nodeId === submission.nodeId);
		const latest = state.submissions.filter((item) => item.nodeId === submission.nodeId).at(-1);
		if (impacted.length) {
			submission.status =
				impacted.length === submission.outputs.length
					? impacted.some((output) => roots.includes(artifactRef(submission, output).revisionId))
						? "rejected"
						: "stale"
					: "candidate";
			if (runtime && latest === submission && runtime.status !== "active") runtime.status = "waiting_rework";
		} else if (
			submission.status === "approved" &&
			(state.approvals.some(
				(approval) => approval.submissionId === submission.submissionId && reviews.has(approval.reviewId),
			) ||
				state.governance.adoptions.some(
					(adoption) => adoption.submissionId === submission.submissionId && held.has(adoption.adoptionId),
				))
		) {
			submission.status = "candidate";
			if (runtime && latest === submission && !["active", "waiting_rework"].includes(runtime.status))
				runtime.status = "waiting_review";
		}
	}
	for (const review of state.reviews.filter((item) => reviews.has(item.reviewId))) {
		const node = state.nodes.find((item) => item.nodeId === review.reviewNodeId);
		if (node && node.activeRoundId !== excludeRoundId && node.status !== "active") node.status = "waiting";
	}
	const invalidatedRounds: QualityImpact["invalidatedRounds"] = [];
	for (const round of state.rounds) {
		if (round.status !== "active" || round.roundId === excludeRoundId) continue;
		const touched =
			state.governance.artifacts.some(
				(artifact) => roots.includes(artifact.revisionId) && artifact.nodeId === round.nodeId,
			) ||
			round.inputBindings.some((binding) => {
				const ref = boundArtifact(state, binding);
				return (
					(ref &&
						affected.has(ref.revisionId) &&
						binding.purpose !== "test_subject" &&
						binding.purpose !== "historical_reference") ||
					(binding.releaseIds ?? []).some((id) => releases.has(id))
				);
			});
		if (!touched) continue;
		const node = state.nodes.find((item) => item.nodeId === round.nodeId)!;
		interruptActiveExecution(state, node.nodeId, "superseded", "cancelled");
		incrementScopeEpoch(state, node.nodeId);
		node.activeRoundId = undefined;
		node.status = node.kind === "execution" ? "waiting_rework" : "waiting";
		round.status = "invalidated";
		round.finishedAt = Date.now();
		invalidatedRounds.push({ nodeId: node.nodeId, roundId: round.roundId });
	}
	return {
		revisionIds: [...affected],
		reviewIds: [...reviews],
		releaseIds: [...releases],
		adoptionIds: [...held],
		invalidatedRounds,
	};
}
