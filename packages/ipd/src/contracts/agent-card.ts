import Type, { type Static } from "typebox";
import {
	IdentifierSchema,
	NonEmptyStringSchema,
	Sha256Schema,
	ThinkingLevelSchema,
	VersionSchema,
} from "./primitives.ts";

export const AgentCardModelAssetSchema = Type.Object(
	{
		selection: Type.Optional(Type.Union([Type.Literal("run_default"), Type.Literal("explicit")])),
		provider: Type.Optional(IdentifierSchema),
		id: Type.Optional(NonEmptyStringSchema),
		thinkingLevel: Type.Optional(Type.Union([ThinkingLevelSchema, Type.Literal("inherit")])),
	},
	{ additionalProperties: false },
);

export const AgentCardPermissionsAssetSchema = Type.Object(
	{
		workspace: Type.Optional(Type.Union([Type.Literal("read"), Type.Literal("write")])),
		readScopes: Type.Optional(Type.Array(NonEmptyStringSchema)),
		writeScopes: Type.Optional(Type.Array(NonEmptyStringSchema)),
		externalActions: Type.Optional(Type.Boolean()),
	},
	{ additionalProperties: false },
);

export const AgentCardPromptProfileAssetSchema = Type.Object(
	{
		approach: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		communication: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		verification: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const AgentCardKnowledgeBaseAssetSchema = Type.Object(
	{
		id: IdentifierSchema,
		description: NonEmptyStringSchema,
		paths: Type.Optional(Type.Array(NonEmptyStringSchema, { uniqueItems: true })),
	},
	{ additionalProperties: false },
);

export const AgentCardAssetSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: Type.Optional(VersionSchema),
		name: NonEmptyStringSchema,
		description: NonEmptyStringSchema,
		responsibilities: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
		nonResponsibilities: Type.Array(NonEmptyStringSchema),
		capabilities: Type.Array(IdentifierSchema, { minItems: 1 }),
		applicableScenarios: Type.Optional(Type.Array(NonEmptyStringSchema)),
		principles: Type.Optional(Type.Array(NonEmptyStringSchema)),
		deliverables: Type.Optional(Type.Array(NonEmptyStringSchema)),
		promptProfile: Type.Optional(AgentCardPromptProfileAssetSchema),
		knowledgeBases: Type.Optional(Type.Array(AgentCardKnowledgeBaseAssetSchema)),
		model: Type.Optional(AgentCardModelAssetSchema),
		skills: Type.Optional(Type.Array(IdentifierSchema)),
		tools: Type.Optional(Type.Array(IdentifierSchema)),
		permissions: Type.Optional(AgentCardPermissionsAssetSchema),
	},
	{ additionalProperties: false },
);

export type AgentCardAsset = Static<typeof AgentCardAssetSchema>;

export interface CompiledAgentCard {
	id: string;
	version: string;
	name: string;
	description: string;
	responsibilities: string[];
	nonResponsibilities: string[];
	capabilities: string[];
	applicableScenarios: string[];
	principles: string[];
	deliverables: string[];
	promptProfile: {
		approach: string[];
		communication: string[];
		verification: string[];
	};
	knowledgeBases: Array<{ id: string; description: string; paths: string[] }>;
	model:
		| { selection: "run_default"; thinkingLevel: Static<typeof ThinkingLevelSchema> | "inherit" }
		| {
				selection: "explicit";
				provider: string;
				id: string;
				thinkingLevel: Static<typeof ThinkingLevelSchema> | "inherit";
		  };
	skills: string[];
	tools: string[];
	permissions: {
		workspace: "read" | "write";
		readScopes: string[];
		writeScopes: string[];
		externalActions: boolean;
	};
	hash: string;
	source: string;
}

export const AgentCardRefSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: VersionSchema,
		hash: Sha256Schema,
	},
	{ additionalProperties: false },
);

export type AgentCardRef = Static<typeof AgentCardRefSchema>;
