// 定义并捕获执行、评审和控制角色的结构化提交。
import { posix } from "node:path";
import { defineTool, type ExtensionFactory, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static, type TSchema } from "typebox";
import { IdentifierSchema, JsonValueSchema, NonEmptyStringSchema } from "../contracts/primitives.ts";
import { NodeOutputRefSchema } from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import { NodeSubmissionProtocolError, NodeWorkerError } from "../runtime/node-worker.ts";

const SubmittedFileSchema = Type.Object(
	{
		path: Type.String({
			minLength: 1,
			description:
				"File path relative to the workspace, or an absolute path inside the current workspace. Must remain within the declared output root.",
		}),
		media_type: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

const SubmittedOutputSchema = Type.Object(
	{
		output_id: IdentifierSchema,
		files: Type.Array(SubmittedFileSchema, { minItems: 1 }),
		summary: Type.Optional(NonEmptyStringSchema),
		limitations: Type.Optional(Type.Array(NonEmptyStringSchema)),
	},
	{ additionalProperties: false },
);

const SubmittedEvidenceSchema = Type.Object(
	{
		description: NonEmptyStringSchema,
		reference: NonEmptyStringSchema,
		output_id: Type.Optional(IdentifierSchema),
		criterion_id: Type.Optional(IdentifierSchema),
		method: Type.Optional(NonEmptyStringSchema),
		locator: Type.Optional(NonEmptyStringSchema),
		limitations: Type.Optional(Type.Array(NonEmptyStringSchema)),
	},
	{ additionalProperties: false },
);

export const SubmitArtifactSchema = Type.Object(
	{
		summary: NonEmptyStringSchema,
		outputs: Type.Array(SubmittedOutputSchema),
		preserved_outputs: Type.Optional(
			Type.Array(
				Type.Object(
					{ output_id: IdentifierSchema, submission_id: NonEmptyStringSchema, revision_id: NonEmptyStringSchema },
					{ additionalProperties: false },
				),
			),
		),
		resolution_claims: Type.Optional(
			Type.Array(
				Type.Object(
					{
						finding_id: NonEmptyStringSchema,
						output_id: IdentifierSchema,
						explanation: NonEmptyStringSchema,
						evidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
					},
					{ additionalProperties: false },
				),
			),
		),
		limitations: Type.Optional(Type.Array(NonEmptyStringSchema)),
		evidence: Type.Array(SubmittedEvidenceSchema),
		metadata: JsonValueSchema,
	},
	{ additionalProperties: false },
);

export type SubmitArtifact = Static<typeof SubmitArtifactSchema>;

export function normalizeArtifactPaths(submission: SubmitArtifact, workspace: string): SubmitArtifact {
	return {
		...submission,
		outputs: submission.outputs.map((output) => ({
			...output,
			files: output.files.map((file) => {
				const path = file.path.replaceAll("\\", "/");
				if (path.split("/").includes("..") || /^[a-z]:/i.test(path) || path.includes("\0"))
					throw new NodeWorkerError("policy_denied", `Invalid submitted output path: ${file.path}`);
				const relative = posix.isAbsolute(path) ? posix.relative(workspace, path) : posix.normalize(path);
				if (relative === ".." || relative.startsWith("../"))
					throw new NodeWorkerError("policy_denied", `Submitted output escapes the workspace: ${file.path}`);
				if (!relative || relative === ".")
					throw new NodeSubmissionProtocolError(
						"Submit a file inside the declared output root, not the workspace directory.",
					);
				return { ...file, path: relative };
			}),
		})),
	};
}

export const ReportNodeBlockedSchema = Type.Object(
	{
		reason: NonEmptyStringSchema,
		missing_conditions: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		attempted_actions: Type.Array(NonEmptyStringSchema),
		evidence: Type.Array(SubmittedEvidenceSchema),
		needed_to_resume: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type ReportNodeBlocked = Static<typeof ReportNodeBlockedSchema>;

const ReviewDecisionSchema = Type.Union([Type.Literal("PASS"), Type.Literal("REWORK"), Type.Literal("BLOCKED")]);
const CriterionDecisionSchema = Type.Union([Type.Literal("PASS"), Type.Literal("FAIL"), Type.Literal("BLOCKED")]);

const ReviewEvidenceSchema = Type.Object(
	{
		description: NonEmptyStringSchema,
		reference: NonEmptyStringSchema,
		submission_id: NonEmptyStringSchema,
		node_id: IdentifierSchema,
		output_id: IdentifierSchema,
		criterion_id: IdentifierSchema,
		verification_path: Type.Optional(
			Type.String({
				minLength: 1,
				description:
					"Optional reviewer-generated verification file under outputs/review-evidence/, relative to the private workspace.",
			}),
		),
		method: Type.Optional(NonEmptyStringSchema),
		locator: Type.Optional(NonEmptyStringSchema),
		limitations: Type.Optional(Type.Array(NonEmptyStringSchema)),
	},
	{ additionalProperties: false },
);

export const SubmitReviewSchema = Type.Object(
	{
		decision: ReviewDecisionSchema,
		criteria: Type.Array(
			Type.Object(
				{
					criterion_id: IdentifierSchema,
					result: CriterionDecisionSchema,
					evidence: Type.Array(ReviewEvidenceSchema),
					rationale: NonEmptyStringSchema,
					required_rework: Type.Array(NonEmptyStringSchema),
					rework_targets: Type.Array(NodeOutputRefSchema, { uniqueItems: true }),
					root_cause: Type.Optional(
						Type.Object(
							{
								status: Type.Union([Type.Literal("unknown"), Type.Literal("supported")]),
								explanation: NonEmptyStringSchema,
							},
							{ additionalProperties: false },
						),
					),
					finding_resolutions: Type.Optional(
						Type.Array(
							Type.Object(
								{
									finding_id: NonEmptyStringSchema,
									result: Type.Union([
										Type.Literal("resolved"),
										Type.Literal("withdrawn"),
										Type.Literal("superseded"),
									]),
									reason: NonEmptyStringSchema,
									replacement_finding_id: Type.Optional(NonEmptyStringSchema),
								},
								{ additionalProperties: false },
							),
						),
					),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
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
	private correctionBase?: { contentHash: string; value: T };
	private scope?: string;

	beginRound(scope?: string, allowCorrection = false): void {
		if (scope && scope === this.scope && allowCorrection) {
			if (this.receipt)
				this.correctionBase = { contentHash: this.receipt.contentHash, value: structuredClone(this.receipt.value) };
		} else this.correctionBase = undefined;
		this.receipt = undefined;
		this.scope = scope;
	}

	rememberRejected(value: T): void {
		if (!this.receipt) this.correctionBase = { contentHash: hashJson(value), value: structuredClone(value) };
	}

	get correction(): { contentHash: string; value: T } | undefined {
		return this.correctionBase ? structuredClone(this.correctionBase) : undefined;
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

/** Map IPD control receipts through Pi's supported result hook, retaining diagnostics. */
export function createSubmissionResultExtension(controlTools: readonly ToolDefinition[]): ExtensionFactory {
	const names = new Set(controlTools.map((tool) => tool.name));
	return (pi) => {
		pi.on("tool_result", (event) => {
			const details = event.details;
			if (
				names.has(event.toolName) &&
				details !== null &&
				typeof details === "object" &&
				"captured" in details &&
				details.captured === false &&
				"diagnostics" in details &&
				Array.isArray(details.diagnostics)
			)
				return { isError: true };
			return undefined;
		});
	};
}

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
			if (diagnostics.length > 0) {
				options.capture.rememberRejected(params);
				return {
					content: [
						{
							type: "text",
							text: wrapPromptBlock(
								"submission_validation_result",
								`Submission rejected. Correct these issues and submit again:\n${diagnostics.map((item) => `- ${item}`).join("\n")}\nIf correct_submission is available, read submission_context (mode=correction) and change only the rejected fields; the complete candidate is still revalidated.`,
							),
						},
					],
					details: { captured: false, diagnostics },
				};
			}
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
