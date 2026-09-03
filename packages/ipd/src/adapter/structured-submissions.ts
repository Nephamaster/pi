import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import { JsonValueSchema, NonEmptyStringSchema, WorkflowDefinitionSchema } from "../ir/schemas.ts";

export const SubmitArtifactSchema = Type.Object(
	{
		summary: NonEmptyStringSchema,
		files: Type.Array(
			Type.Object(
				{
					path: NonEmptyStringSchema,
					mimeType: NonEmptyStringSchema,
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		metadata: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type SubmitArtifact = Static<typeof SubmitArtifactSchema>;

const CriterionDecisionSchema = Type.Union([
	Type.Literal("PASS"),
	Type.Literal("FAIL"),
	Type.Literal("INCONCLUSIVE"),
	Type.Literal("BLOCKED"),
]);

export const SubmitReviewSchema = Type.Object(
	{
		decision: CriterionDecisionSchema,
		criteria: Type.Array(
			Type.Object(
				{
					criterionId: NonEmptyStringSchema,
					result: CriterionDecisionSchema,
					evidence: JsonValueSchema,
					rationale: NonEmptyStringSchema,
					requiredRework: Type.Array(NonEmptyStringSchema),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		unresolvedRisks: Type.Array(NonEmptyStringSchema),
	},
	{ additionalProperties: false },
);

export type SubmitReview = Static<typeof SubmitReviewSchema>;

export const SubmitDecisionSchema = Type.Object(
	{
		action: NonEmptyStringSchema,
		rationale: NonEmptyStringSchema,
		evidence: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type SubmitDecision = Static<typeof SubmitDecisionSchema>;

export class SingleSubmission<T> {
	private submitted?: T;
	private submissionAttempts = 0;

	submit(value: T): void {
		this.submissionAttempts++;
		if (this.submitted !== undefined) throw new Error("Submission tool may only be called once");
		this.submitted = structuredClone(value);
	}

	get value(): T | undefined {
		return this.submitted;
	}

	get attempts(): number {
		return this.submissionAttempts;
	}

	get valid(): boolean {
		return this.submissionAttempts === 1 && this.submitted !== undefined;
	}
}

export type SubmissionTool<TParameters extends TSchema> = ToolDefinition<TParameters, { submitted: true }> &
	ToolDefinition;

export function createSubmissionTool<TParameters extends TSchema>(options: {
	name: string;
	label: string;
	description: string;
	parameters: TParameters;
	capture: SingleSubmission<Static<TParameters>>;
}): SubmissionTool<TParameters> {
	return defineTool({
		name: options.name,
		label: options.label,
		description: options.description,
		parameters: options.parameters,
		executionMode: "sequential",
		async execute(_toolCallId, params) {
			options.capture.submit(params);
			return {
				content: [{ type: "text", text: `${options.label} accepted.` }],
				details: { submitted: true },
				terminate: true,
			};
		},
	});
}

export const SubmitWorkflowSchema = WorkflowDefinitionSchema;
