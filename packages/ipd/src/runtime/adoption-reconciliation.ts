// Re-adopt unchanged production under new release credentials without rewriting its original Attempt.
import type { RunState } from "../contracts/runtime.ts";
import { artifactRef, outputUsable, releaseIsCurrent } from "./artifact-governance.ts";

export function reconcileHeldAdoptions(state: RunState): string[] {
	const renewed: string[] = [];
	for (const prior of [...state.governance.adoptions]) {
		if (prior.status !== "held") continue;
		const submission = state.submissions.find((item) => item.submissionId === prior.submissionId);
		if (!submission || !submission.outputs.every((output) => outputUsable(state, submission, output.outputId)))
			continue;
		if (
			!prior.inputRevisionIds.every((id) =>
				state.governance.artifacts.some((artifact) => artifact.revisionId === id && artifact.status === "current"),
			)
		)
			continue;
		const round = state.rounds.find((item) => item.roundId === submission.roundId);
		if (!round) continue;
		const releaseIds: string[] = [];
		let complete = true;
		for (const binding of round.inputBindings) {
			const source = state.submissions.find((item) => item.submissionId === binding.submissionId);
			const output = source?.outputs.find((item) => item.outputId === binding.outputId);
			if (!source || !output) {
				complete = false;
				break;
			}
			const id = artifactRef(source, output).revisionId;
			for (const reviewer of binding.approvalReviewNodeIds) {
				const release = state.governance.releases
					.filter(
						(item) =>
							item.reviewNodeId === reviewer &&
							releaseIsCurrent(state, item.releaseId) &&
							item.subjectRevisionIds.includes(id),
					)
					.at(-1);
				if (!release) {
					complete = false;
					break;
				}
				releaseIds.push(release.releaseId);
			}
		}
		if (!complete) continue;
		prior.status = "superseded";
		const adoptionId = `${submission.submissionId}:adoption:${state.governance.adoptions.length + 1}`;
		state.governance.adoptions.push({
			...structuredClone(prior),
			adoptionId,
			status: "active",
			releaseIds: [...new Set(releaseIds)],
			replaces: prior.adoptionId,
			createdAt: Date.now(),
		});
		renewed.push(adoptionId);
	}
	return renewed;
}
