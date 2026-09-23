// Reuse only the rejected payload owned by this native Session and work scope.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import { JsonValueSchema } from "../contracts/primitives.ts";
import { validateSchema } from "../ir/validation.ts";
import type { SubmissionCapture, SubmissionTool } from "./structured-submissions.ts";
import { patchSubmission } from "./submission-patch.ts";

const CorrectionSchema = Type.Object(
	{
		base_hash: Type.String({ pattern: "^[a-f0-9]{64}$" }),
		patches: Type.Array(
			Type.Union([
				Type.Object(
					{
						op: Type.Literal("set"),
						path: Type.String({ minLength: 2, maxLength: 1024 }),
						value: JsonValueSchema,
					},
					{ additionalProperties: false },
				),
				Type.Object(
					{ op: Type.Literal("remove"), path: Type.String({ minLength: 2, maxLength: 1024 }) },
					{ additionalProperties: false },
				),
			]),
			{ minItems: 1, maxItems: 32 },
		),
	},
	{ additionalProperties: false },
);

export function createSubmissionCorrectionTool<T extends TSchema>(
	submitTool: SubmissionTool<T>,
	capture: SubmissionCapture<Static<T>>,
	isActive: () => boolean,
): ToolDefinition {
	return defineTool({
		name: "correct_submission",
		label: "Correct Submission Fields",
		description: `Correct a rejected ${submitTool.name} payload without regenerating unchanged text. Obtain its base_hash and exact fields from submission_context (mode=correction). Patches are ordered JSON Pointers into that payload only: set a field or remove it; arrays use existing indices. The complete candidate is revalidated by the original submission tool and Runtime. Call alone as the final tool. No previous-round reuse, filesystem edit, automatic approval, or standards change.`,
		parameters: CorrectionSchema,
		executionMode: "sequential",
		async execute(callId, params, signal, _update, context) {
			signal?.throwIfAborted();
			let value: Static<T>;
			try {
				if (!isActive()) throw new Error("No active work scope for submission correction.");
				const base = capture.correction;
				if (!base || base.contentHash !== params.base_hash)
					throw new Error(
						"No matching rejected payload in this work scope. Read submission_context or submit a complete candidate.",
					);
				const parsed = validateSchema<Static<T>>(
					submitTool.parameters,
					patchSubmission(base.value, params.patches),
				);
				if (!parsed.ok)
					throw new Error(parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
				value = parsed.value;
			} catch (error) {
				const diagnostics = [error instanceof Error ? error.message : String(error)];
				return {
					content: [{ type: "text", text: JSON.stringify({ captured: false, diagnostics }) }],
					details: { captured: false, diagnostics },
				};
			}
			// Preserve normal prevalidation, single capture, termination and Runtime adoption.
			return submitTool.execute(callId, value, signal, undefined, context);
		},
	});
}
