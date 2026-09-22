// Resolve model evidence to authorized immutable files and preserve its actual provenance.
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import { hashFile } from "../artifact/hash-file.ts";
import type { EvidenceRecord } from "../contracts/governance.ts";
import type { SubmissionRecord } from "../contracts/runtime.ts";
import { artifactRef } from "./artifact-governance.ts";
import type { NodeRoundWork } from "./node-worker.ts";
import { SubmissionValidationError } from "./submission-store.ts";

export async function verifyEvidenceFile(
	submission: SubmissionRecord,
	outputId: string,
	reference: string,
	work?: NodeRoundWork,
): Promise<string> {
	const output = submission.outputs.find((item) => item.outputId === outputId);
	if (!output) throw new SubmissionValidationError(`Evidence output is unavailable: ${outputId}`);
	let path = reference.split("#")[0];
	if (work)
		for (const binding of work.inputBindings) {
			if (binding.submissionId !== submission.submissionId || binding.outputId !== outputId) continue;
			const prefix = `${work.environmentBinding?.paths.inputs ?? "/ipd/inputs"}/${binding.inputId}/`;
			if (path.startsWith(prefix)) path = path.slice(prefix.length);
		}
	const basenameMatches = output.manifest.files.filter((item) => item.path.split("/").at(-1) === path);
	if (!path.includes("/") && basenameMatches.length === 1) path = basenameMatches[0].path;
	const file = output.manifest.files.find((item) => item.path === path);
	if (!file && path !== "submission.json")
		throw new SubmissionValidationError(`Evidence must point to a sealed file of the exact output: ${reference}`);
	const root = await realpath(output.sealedRoot);
	const target = await realpath(resolve(root, path));
	const child = relative(root, target);
	if (child.startsWith("..") || isAbsolute(child))
		throw new SubmissionValidationError("Evidence resolves outside the authorized output");
	if (file && (await hashFile(target)) !== file.sha256)
		throw new SubmissionValidationError(`Evidence content no longer matches its Manifest: ${reference}`);
	return path;
}

export async function validateReviewEvidence(
	work: NodeRoundWork,
	report: SubmitReview,
	verification = new Map<string, { rawRef: string; rawDigest: string }>(),
): Promise<EvidenceRecord[]> {
	const records: EvidenceRecord[] = [];
	for (const criterion of report.criteria)
		for (const evidence of criterion.evidence) {
			const submission = work.inputSubmissions.find((item) => item.submissionId === evidence.submission_id)!;
			const output = submission?.outputs.find((item) => item.outputId === evidence.output_id);
			if (!output) throw new Error("Review evidence does not resolve to a bound output");
			const path = await verifyEvidenceFile(submission, output.outputId, evidence.reference, work);
			const receipt = evidence.verification_path ? verification.get(evidence.verification_path) : undefined;
			if (evidence.verification_path && !receipt) throw new Error("Reviewer verification evidence is not sealed");
			records.push({
				evidenceId: `${work.stamp.attemptId}:evidence:${records.length + 1}`,
				attemptId: work.stamp.attemptId,
				participantId: work.node.agents[0].participantId,
				criterionId: criterion.criterion_id,
				subjects: [artifactRef(submission, output).revisionId],
				provenance: "reviewer_observation",
				method: evidence.method ?? "reviewer_inspection",
				observation: evidence.description,
				rawRef: receipt?.rawRef ?? `${submission.submissionId}/${output.outputId}/${path}`,
				rawDigest: receipt?.rawDigest,
				subjectFileRef: `${submission.submissionId}/${output.outputId}/${path}`,
				locator: evidence.locator,
				limitations: evidence.limitations ?? [
					"This is a reviewer observation, not an independently captured tool execution receipt.",
				],
				environmentRef: work.environmentBinding?.bindingId,
				createdAt: Date.now(),
			});
		}
	return records;
}

export async function validateCandidateEvidence(
	submission: SubmissionRecord,
	work: NodeRoundWork,
): Promise<EvidenceRecord[]> {
	const records: EvidenceRecord[] = [];
	const claims = submission.resolutionClaims ?? [];
	for (const claim of claims)
		for (const reference of claim.evidence) await verifyEvidenceFile(submission, claim.outputId, reference);
	if (!Array.isArray(submission.evidence)) return records;
	for (const value of submission.evidence) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const outputId =
			typeof value.output_id === "string"
				? value.output_id
				: submission.outputs.length === 1
					? submission.outputs[0].outputId
					: undefined;
		if (!outputId || typeof value.reference !== "string")
			throw new SubmissionValidationError(
				"Multi-output evidence must declare output_id and a sealed file reference",
			);
		const path = await verifyEvidenceFile(submission, outputId, value.reference);
		const output = submission.outputs.find((item) => item.outputId === outputId)!;
		records.push({
			evidenceId: `${work.stamp.attemptId}:producer-evidence:${records.length + 1}`,
			attemptId: work.stamp.attemptId,
			participantId: work.node.agents[0].participantId,
			subjects: [artifactRef(submission, output).revisionId],
			provenance: "producer_statement",
			method: typeof value.method === "string" ? value.method : "producer_statement",
			observation: value.description ?? "",
			rawRef: `${submission.submissionId}/${outputId}/${path}`,
			limitations: ["Producer-supplied evidence is not an independent approval."],
			createdAt: Date.now(),
		});
	}
	return records;
}
