import Type, { type Static } from "typebox";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);

export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const IdentifierSchema = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z][A-Za-z0-9._-]*$",
});

export const OpaqueIdSchema = Type.String({
	minLength: 1,
	maxLength: 256,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const VersionSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$",
});

export const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;

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

export const AgentCardBudgetAssetSchema = Type.Object(
	{
		tokens: Type.Optional(Type.Integer({ minimum: 1 })),
		timeoutMs: Type.Optional(Type.Integer({ minimum: 1 })),
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
		defaultBudget: Type.Optional(AgentCardBudgetAssetSchema),
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
	knowledgeBases: Array<{
		id: string;
		description: string;
		paths: string[];
	}>;
	model:
		| { selection: "run_default"; thinkingLevel: ThinkingLevel | "inherit" }
		| { selection: "explicit"; provider: string; id: string; thinkingLevel: ThinkingLevel | "inherit" };
	skills: string[];
	tools: string[];
	permissions: {
		workspace: "read" | "write";
		readScopes: string[];
		writeScopes: string[];
		externalActions: boolean;
	};
	defaultBudget: {
		tokens: number;
		timeoutMs: number;
	};
	hash: string;
	source: string;
}

export const AgentCardRefSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: VersionSchema,
		hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);

export type AgentCardRef = Static<typeof AgentCardRefSchema>;

export const SkillRefSchema = Type.Object(
	{
		name: IdentifierSchema,
		hash: Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" }),
	},
	{ additionalProperties: false },
);

export type SkillRef = Static<typeof SkillRefSchema>;

export const AcceptanceCriterionSchema = Type.Object(
	{
		id: IdentifierSchema,
		description: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const BudgetDefinitionSchema = Type.Object(
	{
		tokens: Type.Integer({ minimum: 1 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
		staffTokens: Type.Integer({ minimum: 1 }),
		reviewerTokens: Type.Integer({ minimum: 1 }),
		reworkTokens: Type.Integer({ minimum: 1 }),
		hardTokenLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

export const NodeBudgetDefinitionSchema = Type.Object(
	{
		tokens: Type.Integer({ minimum: 1 }),
		timeoutMs: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const ArtifactBindingSchema = Type.Object(
	{
		name: IdentifierSchema,
		fromNodeId: IdentifierSchema,
		artifactType: IdentifierSchema,
		required: Type.Boolean(),
	},
	{ additionalProperties: false },
);

export const ArtifactContractSchema = Type.Object(
	{
		id: IdentifierSchema,
		artifactType: IdentifierSchema,
		description: NonEmptyStringSchema,
		businessPurpose: NonEmptyStringSchema,
		requiredRoles: Type.Array(
			Type.Union([Type.Literal("primary"), Type.Literal("evidence"), Type.Literal("review")]),
			{
				minItems: 2,
				uniqueItems: true,
			},
		),
	},
	{ additionalProperties: false },
);

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

export const ReviewerRequirementSchema = Type.Object(
	{
		id: IdentifierSchema,
		capabilities: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		minCount: Type.Integer({ minimum: 1 }),
	},
	{ additionalProperties: false },
);

export const GateDefinitionSchema = Type.Object(
	{
		id: IdentifierSchema,
		mechanicalCriteria: Type.Array(MechanicalCriterionSchema, { minItems: 1 }),
		semanticCriteria: Type.Array(SemanticCriterionSchema, { minItems: 1 }),
		reviewers: Type.Array(ReviewerRequirementSchema, { minItems: 1 }),
		objectiveCoverage: Type.Array(IdentifierSchema, { uniqueItems: true }),
		aggregation: Type.Object(
			{
				requiredMechanical: Type.Literal("all"),
				requiredSemantic: Type.Literal("all"),
				conflict: Type.Literal("staff_arbitration"),
			},
			{ additionalProperties: false },
		),
		routes: Type.Object(
			{
				pass: NonEmptyStringSchema,
				rework: IdentifierSchema,
				blocked: Type.Union([Type.Literal("staff"), Type.Literal("user"), Type.Literal("fail")]),
				escalate: Type.Union([Type.Literal("staff"), Type.Literal("user")]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type GateDefinition = Static<typeof GateDefinitionSchema>;

export const ExecutionNodeDefinitionSchema = Type.Object(
	{
		kind: Type.Literal("execution"),
		id: IdentifierSchema,
		objective: NonEmptyStringSchema,
		agentCardRef: AgentCardRefSchema,
		requiredCapabilities: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		knowledgeBaseRefs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		dependsOn: Type.Array(IdentifierSchema, { uniqueItems: true }),
		inputs: Type.Array(ArtifactBindingSchema),
		output: ArtifactContractSchema,
		skills: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		tools: Type.Array(IdentifierSchema, { uniqueItems: true }),
		permissions: Type.Object(
			{
				workspace: Type.Union([Type.Literal("read"), Type.Literal("write")]),
				readScopes: Type.Array(NonEmptyStringSchema, { minItems: 1, uniqueItems: true }),
				writeScopes: Type.Array(NonEmptyStringSchema, { uniqueItems: true }),
				externalActions: Type.Boolean(),
			},
			{ additionalProperties: false },
		),
		budget: NodeBudgetDefinitionSchema,
		gate: GateDefinitionSchema,
		rework: Type.Object(
			{
				maxAttempts: Type.Integer({ minimum: 1 }),
				targetNodeId: IdentifierSchema,
			},
			{ additionalProperties: false },
		),
		routes: Type.Object(
			{
				blocked: Type.Union([Type.Literal("staff"), Type.Literal("user"), Type.Literal("fail")]),
				exhausted: Type.Union([Type.Literal("staff"), Type.Literal("user"), Type.Literal("fail")]),
			},
			{ additionalProperties: false },
		),
	},
	{ additionalProperties: false },
);

export type ExecutionNodeDefinition = Static<typeof ExecutionNodeDefinitionSchema>;

export const StaffDefinitionSchema = Type.Object(
	{
		core: Type.Array(AgentCardRefSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

export const WorkflowDefinitionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: IdentifierSchema,
		version: VersionSchema,
		name: NonEmptyStringSchema,
		objective: NonEmptyStringSchema,
		skill: SkillRefSchema,
		acceptanceCriteria: Type.Array(AcceptanceCriterionSchema, { minItems: 1 }),
		source: Type.Union([Type.Literal("generated"), Type.Literal("template")]),
		sourceTemplateId: Type.Optional(IdentifierSchema),
		globalBudget: BudgetDefinitionSchema,
		staff: StaffDefinitionSchema,
		nodes: Type.Array(ExecutionNodeDefinitionSchema, { minItems: 1 }),
		finalArtifactNodeIds: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		finalGate: GateDefinitionSchema,
	},
	{ additionalProperties: false },
);

export type WorkflowDefinition = Static<typeof WorkflowDefinitionSchema>;
