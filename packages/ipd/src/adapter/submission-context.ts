// On-demand identifiers only: no unbound files, full reports or host sealed-root paths.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import type { NodeRoundWork } from "../runtime/node-worker.ts";
import { reviewEvidenceSubjects } from "../runtime/review-validation.ts";
import { normalizeArtifactPaths, type SubmitArtifact, type SubmitReview } from "./structured-submissions.ts";
import { readSubmissionField } from "./submission-patch.ts";

interface CorrectionBase {
	contentHash: string;
	value: SubmitArtifact | SubmitReview;
}
export function submissionEvidenceReferences(work: NodeRoundWork, criterionId?: string, outputId?: string) {
	const node = work.node.definition;
	if (node.kind !== "review") return [];
	const criteria = [...new Set(node.targets.flatMap((target) => target.criterion_refs))].filter(
		(id) => !criterionId || id === criterionId,
	);
	return criteria.flatMap((id) =>
		reviewEvidenceSubjects(node, id).flatMap((subject) => {
			if (outputId && subject.output_id !== outputId) return [];
			return work.inputSubmissions
				.filter((submission) => submission.nodeId === subject.node_id)
				.flatMap((submission) => {
					const bound = work.inputBindings.some(
						(binding) =>
							binding.submissionId === submission.submissionId && binding.outputId === subject.output_id,
					);
					if (!bound) return [];
					const output = submission.outputs.find((item) => item.outputId === subject.output_id);
					return (output?.manifest.files ?? []).map((file) => ({
						criterion_id: id,
						submission_id: submission.submissionId,
						node_id: subject.node_id,
						output_id: subject.output_id,
						reference: file.path,
						sha256: file.sha256,
					}));
				});
		}),
	);
}
export function createSubmissionContextTool(
	getWork: () => NodeRoundWork | undefined,
	getCorrection: () => CorrectionBase | undefined,
	workspace: string,
): ToolDefinition {
	return defineTool({
		name: "submission_context",
		label: "Inspect Submission Context",
		description:
			"Read exact evidence-reference tuples permitted for this round (optionally criterion/output filtered), or the retained rejected payload's base_hash and selected JSON Pointer fields for local correction. No unbound/background output is exposed as an authorized criterion subject. Identifiers are not evidence of quality. No filesystem reads or state changes.",
		parameters: Type.Object(
			{
				mode: Type.Optional(Type.Union([Type.Literal("evidence"), Type.Literal("correction")])),
				criterion_id: Type.Optional(Type.String({ minLength: 1 })),
				output_id: Type.Optional(Type.String({ minLength: 1 })),
				paths: Type.Optional(
					Type.Array(Type.String({ minLength: 2, maxLength: 1024 }), { minItems: 1, maxItems: 8 }),
				),
				limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 40 })),
				cursor: Type.Optional(Type.String({ maxLength: 256 })),
			},
			{ additionalProperties: false },
		),
		executionMode: "sequential",
		async execute(_callId, params, signal) {
			signal?.throwIfAborted();
			const respond = (value: unknown) => {
				const details = toJsonValue(value);
				return { content: [{ type: "text" as const, text: JSON.stringify(details) }], details };
			};
			const work = getWork();
			if (!work || work.signal?.aborted) return respond({ available: false, reason: "No active work scope." });
			const base = getCorrection();
			if (params.mode === "correction") {
				if (!base)
					return respond({
						available: false,
						reason:
							"No retained rejected candidate in this scope. Submit a complete candidate; do not reuse another round.",
					});
				const fields = (params.paths ?? []).map((path) => {
					try {
						const value = readSubmissionField(base.value, path);
						const encoded = JSON.stringify(value);
						return encoded.length <= 1200
							? { path, value }
							: {
									path,
									too_large: true,
									characters: encoded.length,
									child_keys:
										value !== null && typeof value === "object" ? Object.keys(value).slice(0, 16) : [],
									instruction:
										"Select a narrower field, or replace this field without repeating unchanged siblings.",
								};
					} catch (error) {
						return { path, error: error instanceof Error ? error.message : String(error) };
					}
				});
				return respond({
					available: true,
					base_hash: base.contentHash,
					fields,
					instruction:
						"Use correct_submission with this hash and only necessary field changes. Whole candidate validation and Runtime checks still apply.",
				});
			}
			if (work.node.definition.kind === "execution") {
				let candidate: SubmitArtifact | undefined;
				if (base && "outputs" in base.value) {
					try {
						candidate = normalizeArtifactPaths(base.value, work.environmentBinding?.paths.workspace ?? workspace);
					} catch {
						/* Invalid candidate paths remain subject to normal submission validation. */
					}
				}
				const definitions = work.node.definition.outputs.filter(
					(item) => !params.output_id || params.output_id === item.output_id,
				);
				const selected = definitions.slice(0, Math.min(params.limit ?? 12, 40));
				return respond({
					base_hash: base?.contentHash,
					outputs: selected.map((output) => {
						const declared = candidate?.outputs.find((item) => item.output_id === output.output_id)?.files ?? [];
						return {
							output_id: output.output_id,
							path_prefix: output.path_prefix,
							declared_candidate_files: declared.slice(0, 8).map((file) => file.path),
							file_count: declared.length,
							files_truncated: declared.length > 8,
						};
					}),
					total_outputs: definitions.length,
					truncated: selected.length < definitions.length,
					instruction:
						"Filter by output_id for another output. For more rejected-candidate files, use mode=correction and a narrow /outputs/index/files/index/path pointer. Producer evidence reference is ONE workspace-relative declared file path in that output; use locator for page/section details. Candidate paths are not a sealed Manifest or proof of existence. Preserved files are checked by Runtime.",
				});
			}
			const refs = submissionEvidenceReferences(work, params.criterion_id, params.output_id);
			const key = hashJson({
				stamp: work.stamp,
				round: work.roundId,
				criterion: params.criterion_id ?? null,
				output: params.output_id ?? null,
				refs,
			});
			let start = 0;
			if (params.cursor) {
				const [previousKey, position] = params.cursor.split(":");
				if (previousKey !== key || !/^(0|[1-9]\d*)$/u.test(position ?? "") || Number(position) > refs.length)
					return respond({ available: false, reason: "Stale or invalid reference cursor. Restart this view." });
				start = Number(position);
			}
			const count = params.limit ?? 12;
			const items = [];
			let size = 0;
			let end = start;
			for (; end < refs.length && items.length < count; end++) {
				const item = refs[end];
				const length = JSON.stringify(item).length;
				if (size + length > 12000) break;
				items.push(item);
				size += length;
			}
			if (end === start && start < refs.length)
				return respond({
					available: false,
					reason: "An identifier record exceeds the view limit; inspect the scoped input manifest directly.",
				});
			return respond({
				available: true,
				items,
				total: refs.length,
				truncated: end < refs.length,
				next_cursor: end < refs.length ? `${key}:${end}` : null,
				instruction:
					"Copy the exact tuple; fill your own truthful description/method/locator. Background material does not become this criterion's subject. Inspect real evidence; this list grants no approval.",
			});
		},
	});
}
