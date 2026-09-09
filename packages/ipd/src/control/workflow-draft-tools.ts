import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { IdentifierSchema, NonEmptyStringSchema, VersionSchema } from "../contracts/primitives.ts";
import {
	CriterionDefinitionSchema,
	RequirementCoverageSchema,
	WorkflowCompletionSchema,
	type WorkflowDefinition,
	WorkflowNodeSchema,
} from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import type { WorkflowDraftManager, WorkflowDraftOperation } from "./workflow-draft.ts";

const HeaderSchema = Type.Object(
	{
		schema_version: Type.Literal(2),
		workflow_id: IdentifierSchema,
		workflow_version: VersionSchema,
		name: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

const DraftOperationSchema = Type.Union(
	[
		Type.Object({ kind: Type.Literal("set_header"), header: HeaderSchema }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("upsert_node"), node: WorkflowNodeSchema }, { additionalProperties: false }),
		Type.Object({ kind: Type.Literal("remove_node"), node_id: IdentifierSchema }, { additionalProperties: false }),
		Type.Object(
			{ kind: Type.Literal("upsert_criterion"), criterion: CriterionDefinitionSchema },
			{ additionalProperties: false },
		),
		Type.Object(
			{ kind: Type.Literal("set_requirement_coverage"), coverage: Type.Array(RequirementCoverageSchema) },
			{ additionalProperties: false },
		),
		Type.Object(
			{ kind: Type.Literal("set_completion"), completion: WorkflowCompletionSchema },
			{ additionalProperties: false },
		),
	],
	{ discriminator: "kind" },
);

export interface WorkflowDraftToolset {
	tools: ToolDefinition[];
	getSubmitted(): WorkflowDefinition | undefined;
	resetSubmitted(): void;
}

export function createWorkflowDraftTools(manager: WorkflowDraftManager, runId: string): WorkflowDraftToolset {
	let submitted: WorkflowDefinition | undefined;
	const tools: ToolDefinition[] = [
		defineTool({
			name: "workflow_draft_open",
			label: "Open Workflow Draft",
			description: "Open or obtain the single Workflow Draft for this Run.",
			parameters: Type.Object({}, { additionalProperties: false }),
			executionMode: "sequential",
			async execute() {
				const state = await manager.open(runId);
				return { content: [{ type: "text", text: JSON.stringify(state) }], details: state };
			},
		}),
		defineTool({
			name: "workflow_draft_read",
			label: "Read Workflow Draft",
			description: "Read the current structured draft and revision.",
			parameters: Type.Object({}, { additionalProperties: false }),
			executionMode: "sequential",
			async execute() {
				const state = await manager.read();
				return { content: [{ type: "text", text: JSON.stringify(state) }], details: state };
			},
		}),
		defineTool({
			name: "workflow_draft_apply",
			label: "Apply Workflow Draft Operations",
			description: "Atomically apply domain operations to the expected draft revision.",
			parameters: Type.Object(
				{
					draft_id: NonEmptyStringSchema,
					expected_revision: Type.Integer({ minimum: 0 }),
					operation_id: NonEmptyStringSchema,
					operations: Type.Array(DraftOperationSchema, { minItems: 1 }),
				},
				{ additionalProperties: false },
			),
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const state = await manager.apply(
					input.draft_id,
					input.expected_revision,
					input.operation_id,
					input.operations as WorkflowDraftOperation[],
				);
				return {
					content: [{ type: "text", text: `Draft revision ${state.revision} saved.` }],
					details: { draftId: state.draftId, revision: state.revision },
				};
			},
		}),
		defineTool({
			name: "workflow_draft_validate",
			label: "Validate Workflow Draft",
			description: "Validate the exact current draft revision without modifying it.",
			parameters: Type.Object({ expected_revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				const result = await manager.validate(input.expected_revision);
				return { content: [{ type: "text", text: JSON.stringify(result) }], details: result };
			},
		}),
		defineTool({
			name: "workflow_draft_submit",
			label: "Submit Workflow Draft",
			description: "Submit a valid draft revision as the Workflow candidate for independent compilation.",
			parameters: Type.Object({ expected_revision: Type.Integer({ minimum: 0 }) }, { additionalProperties: false }),
			executionMode: "sequential",
			async execute(_toolCallId, input) {
				submitted = await manager.submit(input.expected_revision);
				return {
					content: [{ type: "text", text: "Workflow Draft captured for independent Compiler validation." }],
					details: { workflowHash: hashJson(submitted), revision: input.expected_revision },
					terminate: true,
				};
			},
		}),
	];
	return {
		tools,
		getSubmitted: () => submitted,
		resetSubmitted: () => {
			submitted = undefined;
		},
	};
}
