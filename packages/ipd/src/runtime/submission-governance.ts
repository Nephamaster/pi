// Validate preservation and exact Finding repair claims against the authoritative output registry.
import type { SubmitArtifact } from "../adapter/structured-submissions.ts";
import type { RunState, SubmissionOutputRecord } from "../contracts/runtime.ts";
import { hashJson } from "../ir/hash.ts";
import { artifactRef, outputUsable } from "./artifact-governance.ts";
import type { NodeRoundWork } from "./node-worker.ts";
import { SubmissionValidationError } from "./submission-store.ts";

export function preservedOutputsFor(
	state: RunState,
	work: NodeRoundWork,
	submission: SubmitArtifact,
): SubmissionOutputRecord[] {
	const node = work.node.definition;
	if (node.kind !== "execution") throw new SubmissionValidationError("Only execution nodes preserve outputs");
	const ids = [
		...submission.outputs.map((output) => output.output_id),
		...(submission.preserved_outputs ?? []).map((output) => output.output_id),
	];
	if (
		ids.length !== node.outputs.length ||
		new Set(ids).size !== ids.length ||
		ids.some((id) => !node.outputs.some((output) => output.output_id === id))
	)
		throw new SubmissionValidationError("Provide each declared output exactly once as changed or preserved");
	const preserved = (submission.preserved_outputs ?? []).map((ref) => {
		const prior = state.submissions.find(
			(item) => item.submissionId === ref.submission_id && item.nodeId === node.node_id,
		);
		const output = prior?.outputs.find((item) => item.outputId === ref.output_id);
		const artifact = state.governance.artifacts.find((item) => item.revisionId === ref.revision_id);
		const contract = node.outputs.find((item) => item.output_id === ref.output_id)!;
		if (
			!prior ||
			!output ||
			!artifact ||
			artifactRef(prior, output).revisionId !== ref.revision_id ||
			!outputUsable(state, prior, ref.output_id) ||
			artifact.contractHash !== hashJson(contract) ||
			artifact.manifestHash !== hashJson(output.manifest)
		)
			throw new SubmissionValidationError(
				`Preserved output is unavailable, invalidated, or outside this contract: ${ref.output_id}`,
			);
		if (
			!work.preservableOutputs?.some(
				(item) => item.revisionId === ref.revision_id && item.outputId === ref.output_id,
			)
		)
			throw new SubmissionValidationError(
				`Output preservation was not authorized for this dispatch: ${ref.output_id}`,
			);
		return {
			...structuredClone(output),
			preservedFrom: { submissionId: prior.submissionId, revisionId: ref.revision_id },
		};
	});
	const claimed = new Set<string>();
	for (const claim of submission.resolution_claims ?? []) {
		const finding = work.findings?.find((item) => item.findingId === claim.finding_id);
		if (
			!finding ||
			claimed.has(claim.finding_id) ||
			finding.owner.node_id !== node.node_id ||
			finding.owner.output_id !== claim.output_id ||
			!["open", "addressed"].includes(finding.status)
		)
			throw new SubmissionValidationError(
				`Finding repair claim is not assigned to this output: ${claim.finding_id}`,
			);
		if (!submission.outputs.some((output) => output.output_id === claim.output_id))
			throw new SubmissionValidationError("Finding repairs require a changed output");
		claimed.add(claim.finding_id);
	}
	return preserved;
}

export function preservableOutputs(state: RunState, nodeId: string): NonNullable<NodeRoundWork["preservableOutputs"]> {
	const latest = state.submissions.filter((item) => item.nodeId === nodeId).at(-1);
	if (!latest) return [];
	return latest.outputs
		.filter((output) => outputUsable(state, latest, output.outputId))
		.map((output) => ({
			outputId: output.outputId,
			submissionId: latest.submissionId,
			revisionId: artifactRef(latest, output).revisionId,
		}));
}
