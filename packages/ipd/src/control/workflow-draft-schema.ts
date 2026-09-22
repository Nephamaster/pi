// Narrow authoring schemas reuse execution fields; only completeness is deferred.
import Type, { type TObject, type TSchema } from "typebox";
import { IdentifierSchema as Id, NonEmptyStringSchema, VersionedAssetRefSchema } from "../contracts/primitives.ts";
import {
	CriterionDefinitionSchema,
	DesignDecisionSchema,
	ExecutionNodeSchema,
	MechanicalCriterionDefinitionSchema,
	NodeAgentConfigSchema,
	NodePermissionsSchema,
	OutputDefinitionSchema,
	NodeOutputRefSchema as OutputRef,
	RequirementCoverageSchema,
	RequirementDefinitionSchema,
	ReviewNodeSchema,
	SemanticCriterionDefinitionSchema,
	StageScopeSchema,
	WorkflowCompletionSchema,
	WorkflowDefinitionSchema,
	WorkflowNodeSchema,
} from "../contracts/workflow.ts";
import type { DraftCommand, DraftDomain } from "./workflow-draft-model.ts";

const object = <P extends Record<string, TSchema>>(properties: P) =>
	Type.Object(properties, { additionalProperties: false });
const list = <T extends TSchema>(items: T) => Type.Array(items, { maxItems: 64 });
const ids = Type.Array(Id, { uniqueItems: true, maxItems: 128 });
// Clearing a required list is a draft edit, but remains incomplete at compilation.
// TypeBox keeps kind/optional metadata in non-enumerable descriptors. Spreading
// a schema loses that metadata and can turn projected properties into false schemas.
const partial = <T extends TObject>(schema: T) => {
	const properties: Record<string, TSchema> = {};
	for (const [key, field] of Object.entries(schema.properties as Record<string, TSchema>)) {
		const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(field);
		if (descriptors.type?.value === "array") delete descriptors.minItems;
		properties[key] = Object.create(Object.getPrototypeOf(field), descriptors) as TSchema;
	}
	const descriptors: PropertyDescriptorMap = Object.getOwnPropertyDescriptors(schema);
	descriptors.properties = { ...descriptors.properties, value: properties };
	const copy = Object.create(Object.getPrototypeOf(schema), descriptors) as T;
	return Type.Partial(copy, { additionalProperties: false });
};
export const DraftContractSchema = partial(ExecutionNodeSchema.properties.contract);
export const DraftAgentSchema = object({
	...partial(Type.Omit(NodeAgentConfigSchema, ["permissions"])).properties,
	permissions: Type.Optional(partial(NodePermissionsSchema)),
});
const SourceSchema = Type.Union([
	object({ kind: Type.Literal("task_material"), material_id: Id }),
	object({ kind: Type.Literal("node_output"), ...OutputRef.properties }),
]);
export const AccessSchema = Type.Union([
	object({ mode: Type.Literal("approved"), review_node_ids: Type.Array(Id, { minItems: 1, uniqueItems: true }) }),
	object({ mode: Type.Literal("stage_candidate"), stage_id: Id }),
	object({ mode: Type.Literal("review_candidate") }),
]);
const PurposeSchema = Type.Union([
	Type.Literal("content_basis"),
	Type.Literal("test_subject"),
	Type.Literal("historical_reference"),
]);
const InputEditSchema = object({
	consumer_node_id: Id,
	input_id: Id,
	source: Type.Optional(SourceSchema),
	required: Type.Optional(Type.Boolean()),
	purpose: Type.Optional(PurposeSchema),
	access: Type.Optional(AccessSchema),
});
export const AssignmentSchema = object({
	criterion_id: Id,
	mode: Type.Union([Type.Literal("single"), Type.Literal("composite")]),
	subjects: Type.Array(OutputRef, { minItems: 1, uniqueItems: true, maxItems: 64 }),
});
export const ReviewPlanSchema = object({
	assignments: Type.Optional(list(AssignmentSchema)),
	allowed_rework_node_ids: Type.Optional(ids),
	required_relations: ReviewNodeSchema.properties.required_relations,
	remediation_mappings: ReviewNodeSchema.properties.remediation_mappings,
	decision_policy: ReviewNodeSchema.properties.decision_policy,
});
export const DraftOutputSchema = object({
	...partial(Type.Omit(OutputDefinitionSchema, ["criterion_refs"])).properties,
	output_id: Id,
});
export const DraftCriterionDefinitionSchema = Type.Union([
	partial(Type.Omit(MechanicalCriterionDefinitionSchema, ["criterion_id"])),
	partial(Type.Omit(SemanticCriterionDefinitionSchema, ["criterion_id"])),
]);
export const DraftStageSchema = object({
	stage_id: Id,
	member_node_ids: Type.Optional(ids),
	exits: Type.Optional(list(StageScopeSchema.properties.exits.items)),
});
const MetadataSchema = partial(Type.Pick(WorkflowDefinitionSchema, ["workflow_id", "workflow_version", "name"]));
const nullable = <T extends TSchema>(schema: T) => Type.Optional(Type.Union([schema, Type.Null()]));
const edits = <T extends TSchema>(schema: T) =>
	object({ upsert: Type.Optional(list(schema)), remove_ids: Type.Optional(ids) });

export const DraftCommandSchemas: Record<DraftDomain, TObject> = {
	topology: object({
		nodes: Type.Optional(
			list(
				object({
					node_id: Id,
					kind: Type.Union([Type.Literal("execution"), Type.Literal("review")]),
					name: NonEmptyStringSchema,
					output_ids: Type.Optional(ids),
				}),
			),
		),
		connections: Type.Optional(list(object({ consumer_node_id: Id, input_id: Id, source: SourceSchema }))),
		remove_node_ids: Type.Optional(ids),
	}),
	configure_nodes: object({
		nodes: Type.Array(
			object({
				node_id: Id,
				name: Type.Optional(NonEmptyStringSchema),
				contract: Type.Optional(DraftContractSchema),
				employee: Type.Optional(partial(Type.Pick(NodeAgentConfigSchema, ["agent_ref", "participant_id"]))),
				resources: Type.Optional(
					object({
						...partial(Type.Omit(NodeAgentConfigSchema, ["agent_ref", "participant_id", "permissions"]))
							.properties,
						permissions: Type.Optional(partial(NodePermissionsSchema)),
					}),
				),
				environment_ref: nullable(VersionedAssetRefSchema),
			}),
			{ minItems: 1, maxItems: 32 },
		),
	}),
	outputs: object({
		upsert: Type.Optional(list(object({ node_id: Id, ...DraftOutputSchema.properties }))),
		remove: Type.Optional(list(OutputRef)),
	}),
	criteria: object({
		upsert: Type.Optional(
			list(
				object({
					criterion_id: Id,
					definition: Type.Optional(DraftCriterionDefinitionSchema),
					output_bindings: Type.Optional(Type.Array(OutputRef, { uniqueItems: true })),
				}),
			),
		),
		remove_ids: Type.Optional(ids),
	}),
	inputs: object({
		upsert: Type.Optional(list(InputEditSchema)),
		remove: Type.Optional(list(object({ consumer_node_id: Id, input_id: Id }))),
	}),
	reviews: object({
		upsert: Type.Array(
			object({
				review_node_id: Id,
				...ReviewPlanSchema.properties,
				decision_policy: nullable(ReviewNodeSchema.properties.decision_policy),
			}),
			{ minItems: 1, maxItems: 32 },
		),
	}),
	stages: edits(DraftStageSchema),
	governance: object({
		metadata: Type.Optional(MetadataSchema),
		prerequisites: nullable(WorkflowDefinitionSchema.properties.prerequisites),
		requirements: Type.Optional(edits(RequirementDefinitionSchema)),
		decisions: Type.Optional(edits(DesignDecisionSchema)),
	}),
	coverage: object({
		upsert: Type.Optional(list(RequirementCoverageSchema)),
		remove: Type.Optional(list(Type.Pick(RequirementCoverageSchema, ["source", "requirement_id"]))),
	}),
	completion: partial(WorkflowCompletionSchema),
};
export const DraftCommandSchema = Type.Unsafe<DraftCommand>(
	Type.Union(
		Object.entries(DraftCommandSchemas).map(([domain, data]) => object({ domain: Type.Literal(domain), data })),
	),
);
export const MutationEnvelopeSchema = object({
	expected_revision: Type.Integer({ minimum: 0 }),
	operation_id: NonEmptyStringSchema,
});

const DiagnosticSchema = object({
	code: Type.Optional(NonEmptyStringSchema),
	path: Type.String(),
	message: Type.String(),
	nodeId: Type.Optional(Type.String()),
	processRequirementId: Type.Optional(Type.String()),
	category: Type.Optional(Type.String()),
	authoringPath: Type.Optional(Type.String()),
	suggestedTool: Type.Optional(Type.String()),
});
const ReceiptSchema = object({
	operation_id: NonEmptyStringSchema,
	applied_revision: Type.Integer({ minimum: 0 }),
	changed: Type.Array(Type.String()),
	defaults_applied: Type.Array(Type.String()),
	candidate_hash: Type.Optional(Type.String()),
	candidate_file: Type.Optional(Type.String()),
});
const OperationSchema = object({ requestHash: Type.String(), protocol: Type.String(), receipt: ReceiptSchema });
export const LegacyDraftSchema = object({
	draftId: NonEmptyStringSchema,
	runId: NonEmptyStringSchema,
	revision: Type.Integer({ minimum: 0 }),
	trustedReferences: Type.Pick(WorkflowDefinitionSchema, ["task_input_ref", "process_selection_ref"]),
	header: Type.Optional(
		Type.Pick(WorkflowDefinitionSchema, [
			"schema_version",
			"workflow_id",
			"workflow_version",
			"name",
			"prerequisites",
			"stages",
			"requirements",
			"decisions",
		]),
	),
	nodes: Type.Array(WorkflowNodeSchema),
	criteria: Type.Array(CriterionDefinitionSchema),
	requirementCoverage: Type.Array(RequirementCoverageSchema),
	completion: Type.Optional(WorkflowCompletionSchema),
	operations: Type.Record(
		Type.String(),
		object({ requestHash: Type.String(), revision: Type.Integer({ minimum: 0 }) }),
	),
	lastValidation: Type.Optional(
		object({
			revision: Type.Integer({ minimum: 0 }),
			valid: Type.Boolean(),
			diagnostics: Type.Array(DiagnosticSchema),
		}),
	),
});

export const AuthoringDraftSchema = object({
	draft_schema_version: Type.Literal(2),
	authoringPolicy: Type.Literal("workflow-authoring-v2.1"),
	draftId: NonEmptyStringSchema,
	runId: NonEmptyStringSchema,
	revision: Type.Integer({ minimum: 0 }),
	trustedReferences: Type.Pick(WorkflowDefinitionSchema, ["task_input_ref", "process_selection_ref"]),
	metadata: MetadataSchema,
	nodes: Type.Array(
		object({
			node_id: Id,
			kind: Type.Union([Type.Literal("execution"), Type.Literal("review")]),
			name: NonEmptyStringSchema,
			contract: Type.Optional(DraftContractSchema),
			agent: Type.Optional(DraftAgentSchema),
			environment_ref: Type.Optional(VersionedAssetRefSchema),
			outputs: Type.Array(DraftOutputSchema),
			review_plan: Type.Optional(
				object({ ...ReviewPlanSchema.properties, explicit_subject_criteria: Type.Optional(ids) }),
			),
			inputs: Type.Array(
				Type.Union([
					object({
						kind: Type.Literal("task_material"),
						input_id: Id,
						material_id: Id,
						required: Type.Optional(Type.Boolean()),
					}),
					object({
						kind: Type.Literal("node_output"),
						input_id: Id,
						source: OutputRef,
						required: Type.Optional(Type.Boolean()),
						purpose: Type.Optional(PurposeSchema),
						access: Type.Optional(AccessSchema),
						omit_default_purpose: Type.Optional(Type.Literal(true)),
					}),
				]),
			),
		}),
	),
	criteria: Type.Array(
		object({ criterion_id: Id, definition: DraftCriterionDefinitionSchema, output_bindings: Type.Array(OutputRef) }),
	),
	stage_plans: Type.Array(DraftStageSchema),
	prerequisites: WorkflowDefinitionSchema.properties.prerequisites,
	requirements: Type.Array(RequirementDefinitionSchema),
	decisions: Type.Array(DesignDecisionSchema),
	process_coverage: Type.Array(RequirementCoverageSchema),
	completion: Type.Optional(partial(WorkflowCompletionSchema)),
	editing: Type.Boolean(),
	closureReason: Type.Optional(Type.Union([Type.Literal("captured"), Type.Literal("control_closed")])),
	emptyOptionalSections: Type.Optional(
		Type.Array(Type.Union([Type.Literal("stages"), Type.Literal("requirements"), Type.Literal("decisions")])),
	),
	migration: Type.Optional(
		object({
			sourceHash: NonEmptyStringSchema,
			sourceRevision: Type.Integer({ minimum: 0 }),
			backupFile: NonEmptyStringSchema,
		}),
	),
	// Internal records are never writable through the designer tools.
	lastValidation: Type.Optional(
		object({
			revision: Type.Integer({ minimum: 0 }),
			valid: Type.Boolean(),
			mode: Type.Union([Type.Literal("draft"), Type.Literal("compile")]),
			diagnostics: Type.Array(DiagnosticSchema),
		}),
	),
	lastSubmission: Type.Optional(ReceiptSchema),
	operations: Type.Record(Type.String(), OperationSchema),
	legacyOperations: Type.Optional(
		Type.Record(Type.String(), object({ requestHash: Type.String(), revision: Type.Integer({ minimum: 0 }) })),
	),
});
