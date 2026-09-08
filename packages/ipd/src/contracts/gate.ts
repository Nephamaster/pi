import Type, { type Static } from "typebox";
import { IdentifierSchema, JsonValueSchema, NonEmptyStringSchema } from "./primitives.ts";

export const MechanicalCriterionSchema = Type.Object(
	{
		id: IdentifierSchema,
		description: NonEmptyStringSchema,
		checkId: IdentifierSchema,
		parameters: JsonValueSchema,
		requiredEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type MechanicalCriterion = Static<typeof MechanicalCriterionSchema>;

export const SemanticCriterionSchema = Type.Object(
	{
		id: IdentifierSchema,
		description: NonEmptyStringSchema,
		required: Type.Literal(true),
		reviewerCapabilities: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		evidenceRequirements: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type SemanticCriterion = Static<typeof SemanticCriterionSchema>;

export const GateDefinitionSchema = Type.Object(
	{
		id: IdentifierSchema,
		mechanicalCriteria: Type.Array(MechanicalCriterionSchema, { minItems: 1 }),
		semanticCriteria: Type.Array(SemanticCriterionSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export type GateDefinition = Static<typeof GateDefinitionSchema>;
