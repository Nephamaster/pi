// Register immutable output identities, typed provenance, and current adoption prerequisites.
import type { ArtifactRef, ArtifactRevisionRecord, ConsumptionView, InputPurpose } from "../contracts/governance.ts";
import type {
	RoundInputBindingRecord,
	RunState,
	SubmissionOutputRecord,
	SubmissionRecord,
} from "../contracts/runtime.ts";
import type { NodeRoundWork } from "./node-worker.ts";

export function artifactRef(submission: SubmissionRecord, output: SubmissionOutputRecord): ArtifactRef {
	return {
		submissionId: submission.submissionId,
		nodeId: submission.nodeId,
		outputId: output.outputId,
		revisionId: output.revisionId ?? `${submission.submissionId}:output:${output.outputId}`,
	};
}

export function boundArtifact(state: RunState, binding: RoundInputBindingRecord): ArtifactRef | undefined {
	const submission = state.submissions.find((item) => item.submissionId === binding.submissionId);
	const output = submission?.outputs.find((item) => item.outputId === binding.outputId);
	return submission && output ? artifactRef(submission, output) : undefined;
}

export function outputUsable(state: RunState, submission: SubmissionRecord, outputId: string): boolean {
	const output = submission.outputs.find((item) => item.outputId === outputId);
	if (!output) return false;
	const artifact = state.governance.artifacts.find(
		(item) => item.revisionId === artifactRef(submission, output).revisionId,
	);
	return artifact?.status === "current";
}

export function registerArtifacts(
	state: RunState,
	work: NodeRoundWork,
	submission: SubmissionRecord,
	valid: boolean,
): void {
	const definition = work.node.definition;
	if (definition.kind !== "execution") throw new Error("Artifact production requires an execution contract");
	const bases = work.inputBindings.flatMap((binding) => {
		const ref = boundArtifact(state, binding);
		const input = definition.inputs.find((item) => item.input_id === binding.inputId);
		const purpose: InputPurpose =
			input?.kind === "node_output" ? (input.purpose ?? "content_basis") : "content_basis";
		return ref ? [{ revisionId: ref.revisionId, purpose }] : [];
	});
	for (const output of submission.outputs) {
		const ref = artifactRef(submission, output);
		if (output.preservedFrom) continue;
		if (!output.manifestHash || !output.contractHash)
			throw new Error("Sealed output has no trusted Manifest or contract digest");
		const artifact: ArtifactRevisionRecord = {
			...ref,
			manifestHash: output.manifestHash,
			contractHash: output.contractHash,
			attemptId: work.stamp.attemptId,
			participantId: work.node.agents[0].participantId,
			status: valid ? "current" : "invalidated",
			bases: structuredClone(bases),
			createdAt: submission.createdAt,
		};
		state.governance.artifacts.push(artifact);
		state.governance.contributions.push({
			contributionId: `${artifact.revisionId}:production`,
			participantId: artifact.participantId,
			nodeId: submission.nodeId,
			attemptId: artifact.attemptId,
			revisionId: artifact.revisionId,
			kind: "production",
			sessionId: state.activeResources.find(
				(resource) => resource.nodeId === submission.nodeId && resource.participantId === artifact.participantId,
			)?.sessionId,
		});
	}
	state.governance.adoptions.push({
		adoptionId: `${submission.submissionId}:adoption`,
		submissionId: submission.submissionId,
		attemptId: work.stamp.attemptId,
		inputRevisionIds: bases.filter((basis) => basis.purpose === "content_basis").map((basis) => basis.revisionId),
		releaseIds: [...new Set(work.inputBindings.flatMap((binding) => binding.releaseIds ?? []))],
		status: valid ? "active" : "held",
		createdAt: Date.now(),
	});
}

export function adoptionUsable(state: RunState, submissionId: string): boolean {
	const adoption = state.governance.adoptions.filter((item) => item.submissionId === submissionId).at(-1);
	if (!adoption) return false;
	return adoption.status === "active" && adoption.releaseIds.every((id) => releaseIsCurrent(state, id));
}

export function preservationStillValid(state: RunState, submission: SubmissionRecord): boolean {
	return submission.outputs.every(
		(output) =>
			!output.preservedFrom ||
			state.governance.artifacts.some(
				(artifact) => artifact.revisionId === output.preservedFrom!.revisionId && artifact.status === "current",
			),
	);
}

export function releaseIsCurrent(state: RunState, releaseId: string): boolean {
	const release = state.governance.releases.find((item) => item.releaseId === releaseId);
	if (!release || release.status !== "active") return false;
	const decision = state.governance.decisions.find((item) => item.decisionId === release.decisionId);
	if (
		!decision ||
		decision.status !== "active" ||
		decision.result !== "PASS" ||
		decision.bundleId !== release.bundleId
	)
		return false;
	return (
		release.subjectRevisionIds.every((id) =>
			state.governance.artifacts.some((artifact) => artifact.revisionId === id && artifact.status === "current"),
		) &&
		decision.assessmentIds.every((id) =>
			state.governance.assessments.some(
				(assessment) =>
					assessment.assessmentId === id &&
					assessment.status === "active" &&
					assessment.bundleId === release.bundleId,
			),
		)
	);
}

export function versionRelationsSatisfied(state: RunState, bindings: readonly RoundInputBindingRecord[]): boolean {
	const refs = bindings.flatMap((binding) => {
		const ref = boundArtifact(state, binding);
		return ref ? [ref] : [];
	});
	const byOutput = new Map(refs.map((ref) => [`${ref.nodeId}/${ref.outputId}`, ref.revisionId]));
	for (const ref of refs) {
		const pending = [ref.revisionId];
		const seen = new Set<string>();
		while (pending.length) {
			const id = pending.pop()!;
			if (seen.has(id)) continue;
			seen.add(id);
			for (const basis of state.governance.artifacts.find((artifact) => artifact.revisionId === id)?.bases ?? []) {
				if (basis.purpose !== "content_basis") continue;
				const source = state.governance.artifacts.find((artifact) => artifact.revisionId === basis.revisionId);
				if (!source) return false;
				const selected = byOutput.get(`${source.nodeId}/${source.outputId}`);
				if (selected && selected !== source.revisionId) return false;
				pending.push(source.revisionId);
			}
		}
	}
	return true;
}

export function consumptionView(output: SubmissionOutputRecord): ConsumptionView | undefined {
	if (!output.handoff) return undefined;
	return {
		...structuredClone(output.handoff),
		navigation: output.manifest.files.map((file) => file.path),
		provenance: "producer_authored_summary",
	};
}
