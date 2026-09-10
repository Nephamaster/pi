// 定义并捕获执行、评审和控制角色的结构化提交。
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import { IdentifierSchema, JsonValueSchema, NonEmptyStringSchema } from "../contracts/primitives.ts";
import { hashJson } from "../ir/hash.ts";
import { wrapPromptBlock } from "../prompt/block.ts";

const SubmittedFileSchema = Type.Object(
	{
		path: NonEmptyStringSchema,
		media_type: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

const SubmittedOutputSchema = Type.Object(
	{
		output_id: IdentifierSchema,
		files: Type.Array(SubmittedFileSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const SubmittedEvidenceSchema = Type.Object(
	{
		description: NonEmptyStringSchema,
		reference: NonEmptyStringSchema,
		output_id: Type.Optional(IdentifierSchema),
		criterion_id: Type.Optional(IdentifierSchema),
	},
	{ additionalProperties: false },
);

export const SubmitArtifactSchema = Type.Object(
	{
		summary: NonEmptyStringSchema,
		outputs: Type.Array(SubmittedOutputSchema, { minItems: 1 }),
		evidence: Type.Array(SubmittedEvidenceSchema),
		metadata: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type SubmitArtifact = Static<typeof SubmitArtifactSchema>;

export const ReportNodeBlockedSchema = Type.Object(
	{
		reason: NonEmptyStringSchema,
		missing_conditions: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		affected_requirement_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
		attempted_actions: Type.Array(NonEmptyStringSchema),
		evidence: Type.Array(SubmittedEvidenceSchema),
		needed_to_resume: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type ReportNodeBlocked = Static<typeof ReportNodeBlockedSchema>;

const ReviewDecisionSchema = Type.Union([Type.Literal("PASS"), Type.Literal("REWORK"), Type.Literal("BLOCKED")]);
const CriterionDecisionSchema = Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("BLOCKED")]);

export const SubmitReviewSchema = Type.Object(
	{
		decision: ReviewDecisionSchema,
		criteria: Type.Array(
			Type.Object(
				{
					criterion_id: IdentifierSchema,
					result: CriterionDecisionSchema,
					evidence: Type.Array(SubmittedEvidenceSchema),
					rationale: NonEmptyStringSchema,
					required_rework: Type.Array(NonEmptyStringSchema),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
		rework_node_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
		unresolved_issues: Type.Array(NonEmptyStringSchema),
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

export interface SubmissionReceipt<T> {
	operationId: string;
	contentHash: string;
	value: T;
	reused: boolean;
}

export class SubmissionCapture<T> {
	private receipt?: Omit<SubmissionReceipt<T>, "reused">;

	beginRound(): void {
		this.receipt = undefined;
	}

	capture(operationId: string, value: T): SubmissionReceipt<T> {
		const contentHash = hashJson(value);
		if (this.receipt) {
			if (this.receipt.operationId !== operationId || this.receipt.contentHash !== contentHash) {
				throw new Error("Submission round already captured a different operation or payload");
			}
			return { ...structuredClone(this.receipt), reused: true };
		}
		this.receipt = { operationId, contentHash, value: structuredClone(value) };
		return { ...structuredClone(this.receipt), reused: false };
	}

	get value(): T | undefined {
		return this.receipt ? structuredClone(this.receipt.value) : undefined;
	}
}

export type SubmissionTool<TParameters extends TSchema> = ToolDefinition<
	TParameters,
	{ captured: true; operationId: string; reused: boolean } | { captured: false; diagnostics: readonly string[] }
> &
	ToolDefinition;

export function createSubmissionTool<TParameters extends TSchema>(options: {
	name: string;
	label: string;
	description: string;
	parameters: TParameters;
	capture: SubmissionCapture<Static<TParameters>>;
	validate?: (value: Static<TParameters>) => readonly string[];
}): SubmissionTool<TParameters> {
	return defineTool<
		TParameters,
		{ captured: true; operationId: string; reused: boolean } | { captured: false; diagnostics: readonly string[] }
	>({
		name: options.name,
		label: options.label,
		description: options.description,
		parameters: options.parameters,
		executionMode: "sequential",
		async execute(toolCallId, params) {
			const diagnostics = options.validate?.(params) ?? [];
			if (diagnostics.length > 0)
				return {
					content: [
						{
							type: "text",
							text: wrapPromptBlock(
								"submission_validation_result",
								`Submission rejected. Correct these issues and submit again:\n${diagnostics.map((item) => `- ${item}`).join("\n")}`,
							),
						},
					],
					details: { captured: false, diagnostics },
					isError: true,
				};
			const receipt = options.capture.capture(toolCallId, params);
			return {
				content: [
					{
						type: "text",
						text: wrapPromptBlock(
							"submission_capture_result",
							`${options.label} captured for Runtime validation.`,
						),
					},
				],
				details: { captured: true, operationId: toolCallId, reused: receipt.reused },
				terminate: true,
			};
		},
	});
}
