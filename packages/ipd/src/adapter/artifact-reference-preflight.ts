// Cheap protocol checks, not file existence/integrity or quality approval.
import type { ExecutionNode } from "../contracts/workflow.ts";
import { normalizeArtifactPaths, type SubmitArtifact } from "./structured-submissions.ts";

export function artifactReferenceDiagnostics(value: SubmitArtifact, node: ExecutionNode, workspace: string): string[] {
	const normalized = normalizeArtifactPaths(value, workspace);
	const errors: string[] = [];
	const declared = new Set(node.outputs.map((output) => output.output_id));
	const check = (outputId: string | undefined, reference: string, path: string) => {
		if (!outputId || !declared.has(outputId)) {
			errors.push(`${path}: declare the exact output_id for this evidence; do not combine output scopes.`);
			return;
		}
		const output = normalized.outputs.find((item) => item.output_id === outputId);
		// Preserved outputs still require Runtime's immutable-manifest verification.
		if (!output && value.preserved_outputs?.some((item) => item.output_id === outputId)) return;
		const references = output?.files.map((file) => file.path) ?? [];
		const file = reference.split("#")[0];
		const basenameMatches = references.filter((item) => item.split("/").at(-1) === file);
		if (
			file === "submission.json" ||
			references.includes(file) ||
			(!file.includes("/") && basenameMatches.length === 1)
		)
			return;
		errors.push(
			`${path}: ${JSON.stringify(reference)} is not one file of output ${outputId}. Use an exact declared file path${references.length ? `, for example ${JSON.stringify(references.slice(0, 8))}` : ""}. Put section/page/comments in locator; separate files into separate evidence items. This preflight does not prove the file exists.`,
		);
	};
	for (const [index, evidence] of normalized.evidence.entries())
		check(
			evidence.output_id ?? (node.outputs.length === 1 ? node.outputs[0].output_id : undefined),
			evidence.reference,
			`/evidence/${index}/reference`,
		);
	for (const [index, claim] of (normalized.resolution_claims ?? []).entries())
		for (const [position, reference] of claim.evidence.entries())
			check(claim.output_id, reference, `/resolution_claims/${index}/evidence/${position}`);
	return errors;
}
