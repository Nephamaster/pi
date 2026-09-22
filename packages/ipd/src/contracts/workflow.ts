// 定义可编译的 execution/review 工作流与完成条件。
import Type, { type Static } from "typebox";
import {
	ContentRecordRefSchema,
	IdentifierSchema,
	JsonValueSchema,
	NonEmptyStringSchema,
	ResourceRefSchema,
	VersionedAssetRefSchema,
	VersionSchema,
} from "./primitives.ts";

export const NodeOutputRefSchema = Type.Object(
	{
		node_id: IdentifierSchema,
		output_id: IdentifierSchema,
	},
	{ additionalProperties: false },
);

export type NodeOutputRef = Static<typeof NodeOutputRefSchema>;

const TaskMaterialInputSchema = Type.Object(
	{
		kind: Type.Literal("task_material"),
		input_id: IdentifierSchema,
		material_id: IdentifierSchema,
		required: Type.Boolean(),
	},
	{ additionalProperties: false },
);

const NodeOutputInputSchema = Type.Object(
	{
		kind: Type.Literal("node_output"),
		input_id: IdentifierSchema,
		source: NodeOutputRefSchema,
		required: Type.Boolean(),
		availability: Type.Union([Type.Literal("submitted"), Type.Literal("approved")]),
		approval_review_node_ids: Type.Array(IdentifierSchema, { uniqueItems: true }),
		purpose: Type.Optional(
			Type.Union([
				Type.Literal("content_basis"),
				Type.Literal("test_subject"),
				Type.Literal("historical_reference"),
			]),
		),
	},
	{ additionalProperties: false },
);

export const NodeInputSchema = Type.Union([TaskMaterialInputSchema, NodeOutputInputSchema], {
	discriminator: "kind",
});

export type NodeInput = Static<typeof NodeInputSchema>;

export const NodePermissionsSchema = Type.Object(
	{
		read_paths: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
		write_paths: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
		external_actions: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const NodeAgentConfigSchema = Type.Object(
	{
		participant_id: IdentifierSchema,
		agent_ref: VersionedAssetRefSchema,
		required_capabilities: Type.Array(IdentifierSchema, { uniqueItems: true }),
		skills: Type.Array(ResourceRefSchema, { uniqueItems: true }),
		tools: Type.Array(ResourceRefSchema, { uniqueItems: true }),
		knowledge_bases: Type.Array(VersionedAssetRefSchema, { uniqueItems: true }),
		permissions: NodePermissionsSchema,
	},
	{ additionalProperties: false },
);

const NodeWorkContractSchema = Type.Object(
	{
		objective: NonEmptyStringSchema,
		responsibilities: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		non_responsibilities: Type.Array(NonEmptyStringSchema),
		work_requirements: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		constraints: Type.Array(NonEmptyStringSchema),
		requirement_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
		decision_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
	},
	{ additionalProperties: false },
);

export const OutputDefinitionSchema = Type.Object(
	{
		output_id: IdentifierSchema,
		artifact_type: IdentifierSchema,
		description: NonEmptyStringSchema,
		business_purpose: NonEmptyStringSchema,
		path_prefix: NonEmptyStringSchema,
		evidence_requirements: Type.Array(NonEmptyStringSchema),
		process_evidence_requirement_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		criterion_refs: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
	},
	{ additionalProperties: false },
);

const CommonNodeFields = {
	node_id: IdentifierSchema,
	name: NonEmptyStringSchema,
	environment_ref: Type.Optional(VersionedAssetRefSchema),
	agents: Type.Array(NodeAgentConfigSchema, { minItems: 1 }),
	contract: NodeWorkContractSchema,
	inputs: Type.Array(NodeInputSchema),
};

export const ExecutionNodeSchema = Type.Object(
	{
		kind: Type.Literal("execution"),
		...CommonNodeFields,
		outputs: Type.Array(OutputDefinitionSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type ExecutionNode = Static<typeof ExecutionNodeSchema>;

export const ReviewTargetSchema = Type.Object(
	{
		...NodeOutputRefSchema.properties,
		criterion_refs: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const ReviewNodeSchema = Type.Object(
	{
		kind: Type.Literal("review"),
		...CommonNodeFields,
		targets: Type.Array(ReviewTargetSchema, { minItems: 1 }),
		allowed_rework_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		criterion_subjects: Type.Optional(
			Type.Array(
				Type.Object(
					{
						criterion_id: IdentifierSchema,
						targets: Type.Array(NodeOutputRefSchema, { minItems: 1, uniqueItems: true }),
					},
					{ additionalProperties: false },
				),
			),
		),
		required_relations: Type.Optional(
			Type.Array(
				Type.Object(
					{
						consumer: NodeOutputRefSchema,
						basis: NodeOutputRefSchema,
					},
					{ additionalProperties: false },
				),
				{ uniqueItems: true },
			),
		),
		remediation_mappings: Type.Optional(
			Type.Array(
				Type.Object(
					{ criterion_id: IdentifierSchema, observed: NodeOutputRefSchema, owner: NodeOutputRefSchema },
					{ additionalProperties: false },
				),
				{ uniqueItems: true },
			),
		),
		decision_policy: Type.Optional(
			Type.Object(
				{
					aggregation: Type.Literal("all_required"),
					independent_production: Type.Boolean(),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

export type ReviewNode = Static<typeof ReviewNodeSchema>;

export const WorkflowNodeSchema = Type.Union([ExecutionNodeSchema, ReviewNodeSchema], { discriminator: "kind" });
export type WorkflowNode = Static<typeof WorkflowNodeSchema>;

export const MechanicalCriterionDefinitionSchema = Type.Object(
	{
		kind: Type.Literal("mechanical"),
		criterion_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		check_id: IdentifierSchema,
		parameters: JsonValueSchema,
		evidence_requirements: Type.Array(NonEmptyStringSchema),
		requirement_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
		blocking: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const SemanticCriterionDefinitionSchema = Type.Object(
	{
		kind: Type.Literal("semantic"),
		criterion_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		evidence_requirements: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		process_criterion_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		requirement_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
		blocking: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const CriterionDefinitionSchema = Type.Union(
	[MechanicalCriterionDefinitionSchema, SemanticCriterionDefinitionSchema],
	{ discriminator: "kind" },
);

export type CriterionDefinition = Static<typeof CriterionDefinitionSchema>;

export const RequirementCoverageSchema = Type.Object(
	{
		source: Type.Union([
			Type.Literal("process_activity"),
			Type.Literal("process_deliverable"),
			Type.Literal("process_review"),
			Type.Literal("process_rule"),
		]),
		requirement_id: IdentifierSchema,
		responsible_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		output_refs: Type.Array(NodeOutputRefSchema, { uniqueItems: true }),
		criterion_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const WorkflowCompletionSchema = Type.Object(
	{
		required_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		final_outputs: Type.Array(NodeOutputRefSchema, { minItems: 1, uniqueItems: true }),
		delivery_outputs: Type.Array(NodeOutputRefSchema, { minItems: 1, uniqueItems: true }),
		required_review_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const StageScopeSchema = Type.Object(
	{
		stage_id: IdentifierSchema,
		member_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		internal_uses: Type.Array(
			Type.Object(
				{ consumer_node_id: IdentifierSchema, input_id: IdentifierSchema },
				{ additionalProperties: false },
			),
			{ uniqueItems: true },
		),
		exits: Type.Array(
			Type.Object(
				{
					output: NodeOutputRefSchema,
					gate_node_ids: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
			{ minItems: 1 },
		),
	},
	{ additionalProperties: false },
);

export const RequirementDefinitionSchema = Type.Object(
	{
		requirement_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		authority: Type.Union([
			Type.Literal("user"),
			Type.Literal("process"),
			Type.Literal("design"),
			Type.Literal("recommendation"),
		]),
		strength: Type.Union([Type.Literal("required"), Type.Literal("advisory")]),
		source_ref: NonEmptyStringSchema,
		source_quote: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const DesignDecisionSchema = Type.Object(
	{
		decision_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		requirement_refs: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		rationale: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowDefinitionSchema = Type.Object(
	{
		schema_version: Type.Literal(3),
		workflow_id: IdentifierSchema,
		workflow_version: VersionSchema,
		name: NonEmptyStringSchema,
		task_input_ref: ContentRecordRefSchema,
		prerequisites: Type.Optional(
			Type.Object(
				{
					minimum_materials: Type.Integer({ minimum: 0 }),
					retrieval_tools: Type.Array(IdentifierSchema, { uniqueItems: true }),
				},
				{ additionalProperties: false },
			),
		),
		process_selection_ref: ContentRecordRefSchema,
		nodes: Type.Array(WorkflowNodeSchema, { minItems: 1 }),
		criteria: Type.Array(CriterionDefinitionSchema, { minItems: 1 }),
		requirement_coverage: Type.Array(RequirementCoverageSchema),
		completion: WorkflowCompletionSchema,
		stages: Type.Optional(Type.Array(StageScopeSchema)),
		requirements: Type.Optional(Type.Array(RequirementDefinitionSchema)),
		decisions: Type.Optional(Type.Array(DesignDecisionSchema)),
	},
	{ additionalProperties: false },
);

export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;
