import Type, { type Static } from "typebox";
import {
	ContentRecordRefSchema,
	IdentifierSchema,
	LockedAssetRefSchema,
	NonEmptyStringSchema,
	OpaqueIdSchema,
	VersionSchema,
} from "./primitives.ts";

export const RequiredActivitySchema = Type.Object(
	{
		activity_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		required_capabilities: Type.Array(IdentifierSchema, { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export const ProcessEvidenceRequirementSchema = Type.Object(
	{
		evidence_requirement_id: IdentifierSchema,
		description: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const RequiredDeliverableSchema = Type.Object(
	{
		deliverable_id: IdentifierSchema,
		activity_id: IdentifierSchema,
		artifact_type: Type.Optional(IdentifierSchema),
		description: NonEmptyStringSchema,
		evidence_requirements: Type.Array(ProcessEvidenceRequirementSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ProcessCriterionSchema = Type.Object(
	{
		process_criterion_id: IdentifierSchema,
		description: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const RequiredReviewSchema = Type.Object(
	{
		review_id: IdentifierSchema,
		deliverable_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		reviewer_capabilities: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		independent_agent: Type.Boolean(),
		criteria: Type.Array(ProcessCriterionSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const ProcessRuleSchema = Type.Object(
	{
		rule_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		enforced_by: Type.Union([Type.Literal("compiler"), Type.Literal("runtime"), Type.Literal("review")]),
	},
	{ additionalProperties: false },
);

export const ProcessSpecSchema = Type.Object(
	{
		schema_version: Type.Literal(2),
		process_spec_id: IdentifierSchema,
		version: VersionSchema,
		name: NonEmptyStringSchema,
		description: NonEmptyStringSchema,
		source: NonEmptyStringSchema,
		default_executable: Type.Boolean(),
		applicable_when: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		not_applicable_when: Type.Array(NonEmptyStringSchema),
		required_activities: Type.Array(RequiredActivitySchema),
		required_deliverables: Type.Array(RequiredDeliverableSchema),
		required_reviews: Type.Array(RequiredReviewSchema),
		workflow_rules: Type.Array(ProcessRuleSchema),
	},
	{ additionalProperties: false },
);

export type ProcessSpec = Static<typeof ProcessSpecSchema>;

export const ProcessSelectionDecisionSchema = Type.Object(
	{
		status: Type.Union([Type.Literal("selected"), Type.Literal("blocked")]),
		process_spec_id: Type.Optional(IdentifierSchema),
		process_spec_version: Type.Optional(VersionSchema),
		rationale: Type.Optional(NonEmptyStringSchema),
		reason: Type.Optional(NonEmptyStringSchema),
		task_requirement_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
		process_requirement_refs: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
		unresolved_fact_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export type ProcessSelectionDecision = Static<typeof ProcessSelectionDecisionSchema>;

export const ProcessSelectionSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		process_selection_id: OpaqueIdSchema,
		run_id: OpaqueIdSchema,
		task_input_ref: ContentRecordRefSchema,
		process_spec_ref: LockedAssetRefSchema,
		rationale: NonEmptyStringSchema,
		task_requirement_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		process_requirement_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		unresolved_fact_refs: Type.Array(IdentifierSchema, { uniqueItems: true }),
	},
	{ additionalProperties: false },
);

export type ProcessSelection = Static<typeof ProcessSelectionSchema>;
