import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import {
	AcceptanceCriterionSchema,
	AgentCardRefSchema,
	ArtifactBindingSchema,
	ArtifactContractSchema,
	DEFAULT_NODE_MAX_ATTEMPTS,
	type ExecutionNodeDefinition,
	ExecutionNodeDefinitionSchema,
	type GateDefinition,
	GateDefinitionSchema,
	IdentifierSchema,
	type JsonValue,
	NodeBudgetDefinitionSchema,
	NonEmptyStringSchema,
	ReviewerRequirementSchema,
	SemanticCriterionSchema,
	VersionSchema,
	type WorkflowDefinition,
	WorkflowDefinitionSchema,
} from "../ir/schemas.ts";
import type { CheckDefinition, IpdDiagnostic } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";

export const WORKFLOW_HEADER_TOOL_NAME = "submit_workflow_header";
export const WORKFLOW_ACCEPTANCE_TOOL_NAME = "submit_workflow_acceptance";
export const WORKFLOW_NODE_TOOL_NAME = "submit_workflow_node";
export const WORKFLOW_NODE_REMOVE_TOOL_NAME = "remove_workflow_node";
export const WORKFLOW_NODE_GATE_TOOL_NAME = "submit_workflow_node_gate";
export const WORKFLOW_FINAL_TOOL_NAME = "submit_workflow_final";
export const WORKFLOW_FINALIZE_TOOL_NAME = "finalize_workflow";

const PREFER_STRICT_SAMPLING = { type: "json_schema", strict: "prefer" } as const;
const STRUCTURED_JSON_FIELDS = new Set([
	"agentCardRef",
	"requiredCapabilities",
	"knowledgeBaseRefs",
	"dependsOn",
	"inputs",
	"output",
	"tools",
	"permissions",
	"budget",
	"rework",
	"routes",
	"gate",
	"finalArtifactNodeIds",
	"finalGate",
]);

function normalizeValue(value: unknown, field?: string): unknown {
	if (typeof value === "string" && field && STRUCTURED_JSON_FIELDS.has(field)) {
		try {
			return normalizeValue(JSON.parse(value));
		} catch {
			return value;
		}
	}
	if (Array.isArray(value)) return value.map((item) => normalizeValue(item));
	if (typeof value !== "object" || value === null) return value;
	const normalized: Record<string, unknown> = {};
	for (const [rawKey, child] of Object.entries(value)) {
		const key = rawKey.trim();
		if (key in normalized) return value;
		normalized[key] = normalizeValue(child, key);
	}
	return normalized;
}

function normalizeArguments<T>(value: unknown, omittedRootKeys: readonly string[] = []): T {
	const normalized = normalizeValue(value);
	if (typeof normalized === "object" && normalized !== null && !Array.isArray(normalized)) {
		const record = normalized as Record<string, unknown>;
		for (const key of omittedRootKeys) delete record[key];
	}
	return normalized as T;
}

const MechanicalCriterionAuthoringSchema = Type.Object(
	{
		id: IdentifierSchema,
		description: NonEmptyStringSchema,
		checkId: IdentifierSchema,
		parametersJson: Type.String({
			minLength: 1,
			description: "A JSON-encoded value matching the selected mechanical Check parameter schema.",
		}),
		requiredEvidence: Type.Array(NonEmptyStringSchema, { minItems: 1 }),
	},
	{ additionalProperties: false },
);

const GateAuthoringSchema = Type.Object(
	{
		id: IdentifierSchema,
		mechanicalCriteria: Type.Array(MechanicalCriterionAuthoringSchema, { minItems: 1 }),
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

export const WorkflowHeaderSubmissionSchema = Type.Object(
	{
		schemaVersion: Type.Literal(1),
		id: IdentifierSchema,
		version: VersionSchema,
		name: NonEmptyStringSchema,
		objective: NonEmptyStringSchema,
		source: Type.Union([Type.Literal("generated"), Type.Literal("template")]),
		sourceTemplateId: Type.Optional(IdentifierSchema),
		sourceTemplateVersion: Type.Optional(VersionSchema),
		sourceTemplateHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
	},
	{ additionalProperties: false },
);

export const WorkflowAcceptanceSubmissionSchema = AcceptanceCriterionSchema;

export const WorkflowNodeSubmissionSchema = Type.Object(
	{
		id: IdentifierSchema,
		objective: NonEmptyStringSchema,
		agentCardRef: AgentCardRefSchema,
		requiredCapabilities: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		knowledgeBaseRefs: Type.Array(IdentifierSchema, { uniqueItems: true }),
		dependsOn: Type.Array(IdentifierSchema, { uniqueItems: true }),
		inputs: Type.Array(ArtifactBindingSchema),
		output: ArtifactContractSchema,
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
		budget: Type.Optional(NodeBudgetDefinitionSchema),
		rework: Type.Object({ targetNodeId: IdentifierSchema }, { additionalProperties: false }),
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

export const WorkflowNodeRemovalSchema = Type.Object({ nodeId: IdentifierSchema }, { additionalProperties: false });

export const WorkflowNodeGateSubmissionSchema = Type.Object(
	{
		nodeId: IdentifierSchema,
		gate: GateAuthoringSchema,
	},
	{ additionalProperties: false },
);

export const WorkflowFinalSubmissionSchema = Type.Object(
	{
		finalArtifactNodeIds: Type.Array(IdentifierSchema, { minItems: 1, uniqueItems: true }),
		finalGate: GateAuthoringSchema,
	},
	{ additionalProperties: false },
);

export const FinalizeWorkflowSchema = Type.Object(
	{ confirmation: Type.Literal("finalize") },
	{ additionalProperties: false },
);

type WorkflowHeaderSubmission = Static<typeof WorkflowHeaderSubmissionSchema>;
type WorkflowAcceptanceSubmission = Static<typeof WorkflowAcceptanceSubmissionSchema>;
type WorkflowNodeSubmission = Static<typeof WorkflowNodeSubmissionSchema>;
type WorkflowNodeGateSubmission = Static<typeof WorkflowNodeGateSubmissionSchema>;
type WorkflowFinalSubmission = Static<typeof WorkflowFinalSubmissionSchema>;
type GateAuthoringSubmission = Static<typeof GateAuthoringSchema>;

function diagnosticMessage(diagnostics: readonly IpdDiagnostic[]): string {
	return diagnostics.map((diagnostic) => `${diagnostic.path}: ${diagnostic.message}`).join("; ");
}

function parseJsonValue(value: string, path: string): JsonValue {
	try {
		return JSON.parse(value) as JsonValue;
	} catch (error) {
		throw new Error(`${path} must contain valid JSON: ${error instanceof Error ? error.message : String(error)}`);
	}
}

export class WorkflowSubmissionBuilder {
	private readonly checks: ReadonlyMap<string, CheckDefinition>;
	private readonly constraints: Pick<WorkflowDefinition, "skill" | "globalBudget" | "staff">;
	private header?: WorkflowHeaderSubmission;
	private readonly acceptanceCriteria = new Map<string, WorkflowAcceptanceSubmission>();
	private readonly nodes = new Map<string, WorkflowNodeSubmission>();
	private readonly nodeGates = new Map<string, GateDefinition>();
	private finalSection?: { finalArtifactNodeIds: string[]; finalGate: GateDefinition };
	private finalized?: WorkflowDefinition;
	private finalizeAttempts = 0;

	constructor(
		checks: readonly CheckDefinition[],
		constraints: Pick<WorkflowDefinition, "skill" | "globalBudget" | "staff">,
		initialWorkflow?: WorkflowDefinition,
	) {
		this.checks = new Map(checks.map((check) => [check.id, check]));
		this.constraints = structuredClone(constraints);
		if (initialWorkflow) this.load(initialWorkflow);
	}

	submitHeader(header: WorkflowHeaderSubmission): void {
		this.header = structuredClone(header);
		this.finalized = undefined;
	}

	submitAcceptance(criterion: WorkflowAcceptanceSubmission): void {
		this.acceptanceCriteria.set(criterion.id, structuredClone(criterion));
		this.finalized = undefined;
	}

	submitNode(submission: WorkflowNodeSubmission): void {
		if (this.constraints.globalBudget.mode === "bounded" && submission.budget?.mode !== "bounded") {
			throw new Error("Bounded Workflow Nodes require a bounded budget");
		}
		this.nodes.set(submission.id, structuredClone(submission));
		this.finalized = undefined;
	}

	removeNode(nodeId: string): void {
		if (!this.nodes.delete(nodeId)) throw new Error(`Workflow Node does not exist: ${nodeId}`);
		this.nodeGates.delete(nodeId);
		this.finalized = undefined;
	}

	submitNodeGate(submission: WorkflowNodeGateSubmission): void {
		this.nodeGates.set(submission.nodeId, this.convertGate(submission.gate, `/nodes/${submission.nodeId}/gate`));
		this.finalized = undefined;
	}

	submitFinal(section: WorkflowFinalSubmission): void {
		this.finalSection = {
			finalArtifactNodeIds: [...section.finalArtifactNodeIds],
			finalGate: this.convertGate(section.finalGate, "/finalGate"),
		};
		this.finalized = undefined;
	}

	finalize(): WorkflowDefinition {
		this.finalizeAttempts++;
		if (!this.header) throw new Error(`Call ${WORKFLOW_HEADER_TOOL_NAME} before finalizing`);
		if (this.acceptanceCriteria.size === 0)
			throw new Error(`Call ${WORKFLOW_ACCEPTANCE_TOOL_NAME} at least once before finalizing`);
		if (this.nodes.size === 0) throw new Error(`Call ${WORKFLOW_NODE_TOOL_NAME} at least once before finalizing`);
		const missingGateNodeIds = Array.from(this.nodes.keys()).filter((nodeId) => !this.nodeGates.has(nodeId));
		if (missingGateNodeIds.length > 0) {
			throw new Error(
				`Call ${WORKFLOW_NODE_GATE_TOOL_NAME} for Nodes before finalizing: ${missingGateNodeIds.join(", ")}`,
			);
		}
		if (!this.finalSection) throw new Error(`Call ${WORKFLOW_FINAL_TOOL_NAME} before finalizing`);
		const nodes = Array.from(this.nodes.values()).map((node) => {
			const candidate = {
				...node,
				kind: "execution" as const,
				skills: [this.constraints.skill.name],
				budget: this.constraints.globalBudget.mode === "unbounded" ? { mode: "unbounded" as const } : node.budget,
				rework: { ...node.rework, maxAttempts: DEFAULT_NODE_MAX_ATTEMPTS },
				gate: this.nodeGates.get(node.id),
			};
			const validated = validateSchema<ExecutionNodeDefinition>(ExecutionNodeDefinitionSchema, candidate);
			if (!validated.ok) {
				throw new Error(`Workflow Node ${node.id} is invalid: ${diagnosticMessage(validated.diagnostics)}`);
			}
			return validated.value;
		});
		const candidate = {
			...this.header,
			...this.constraints,
			acceptanceCriteria: Array.from(this.acceptanceCriteria.values()),
			nodes,
			...this.finalSection,
		};
		const validated = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, candidate);
		if (!validated.ok) throw new Error(`Assembled Workflow is invalid: ${diagnosticMessage(validated.diagnostics)}`);
		this.finalized = structuredClone(validated.value);
		return this.finalized;
	}

	get value(): WorkflowDefinition | undefined {
		return this.finalized;
	}

	get attempts(): number {
		return this.finalizeAttempts;
	}

	get valid(): boolean {
		return this.finalized !== undefined;
	}

	private convertGate(gate: GateAuthoringSubmission, path: string): GateDefinition {
		const mechanicalCriteria = gate.mechanicalCriteria.map(({ parametersJson, ...criterion }, index) => {
			const parameters = parseJsonValue(parametersJson, `${path}/mechanicalCriteria/${index}/parametersJson`);
			const check = this.checks.get(criterion.checkId);
			if (!check)
				throw new Error(
					`${path}/mechanicalCriteria/${index}/checkId: Unknown mechanical Check ${criterion.checkId}`,
				);
			const validated = validateSchema(check.parameters, parameters);
			if (!validated.ok) {
				throw new Error(
					`${path}/mechanicalCriteria/${index}/parametersJson: ${diagnosticMessage(validated.diagnostics)}`,
				);
			}
			return { ...criterion, parameters };
		});
		const candidate = { ...gate, mechanicalCriteria };
		const validated = validateSchema<GateDefinition>(GateDefinitionSchema, candidate);
		if (!validated.ok) throw new Error(`Workflow Gate is invalid: ${diagnosticMessage(validated.diagnostics)}`);
		return validated.value;
	}

	private load(workflow: WorkflowDefinition): void {
		this.header = {
			schemaVersion: workflow.schemaVersion,
			id: workflow.id,
			version: workflow.version,
			name: workflow.name,
			objective: workflow.objective,
			source: workflow.source,
			...(workflow.sourceTemplateId ? { sourceTemplateId: workflow.sourceTemplateId } : {}),
			...(workflow.sourceTemplateVersion ? { sourceTemplateVersion: workflow.sourceTemplateVersion } : {}),
			...(workflow.sourceTemplateHash ? { sourceTemplateHash: workflow.sourceTemplateHash } : {}),
		};
		for (const criterion of workflow.acceptanceCriteria) {
			this.acceptanceCriteria.set(criterion.id, structuredClone(criterion));
		}
		for (const node of workflow.nodes) {
			this.nodes.set(node.id, {
				id: node.id,
				objective: node.objective,
				agentCardRef: structuredClone(node.agentCardRef),
				requiredCapabilities: [...node.requiredCapabilities],
				knowledgeBaseRefs: [...node.knowledgeBaseRefs],
				dependsOn: [...node.dependsOn],
				inputs: structuredClone(node.inputs),
				output: structuredClone(node.output),
				tools: [...node.tools],
				permissions: structuredClone(node.permissions),
				budget: this.constraints.globalBudget.mode === "unbounded" ? undefined : structuredClone(node.budget),
				rework: { targetNodeId: node.rework.targetNodeId },
				routes: structuredClone(node.routes),
			});
			this.nodeGates.set(node.id, structuredClone(node.gate));
		}
		this.finalSection = {
			finalArtifactNodeIds: [...workflow.finalArtifactNodeIds],
			finalGate: structuredClone(workflow.finalGate),
		};
	}
}

export function createWorkflowSubmissionTools(builder: WorkflowSubmissionBuilder): ToolDefinition[] {
	return [
		defineTool({
			name: WORKFLOW_HEADER_TOOL_NAME,
			label: "Submit Workflow Header",
			description:
				"Create or replace the Workflow identity, objective, version, and asset source metadata. A changed Workflow must use a new SemVer when the same ID/version already exists.",
			parameters: WorkflowHeaderSubmissionSchema,
			prepareArguments: (value) => normalizeArguments<WorkflowHeaderSubmission>(value),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.submitHeader(parameters);
				return { content: [{ type: "text", text: "Workflow header accepted." }], details: {} };
			},
		}),
		defineTool({
			name: WORKFLOW_NODE_GATE_TOOL_NAME,
			label: "Submit Workflow Node Gate",
			description: "Create or replace the complete Gate for one previously identified Execution Node.",
			parameters: WorkflowNodeGateSubmissionSchema,
			prepareArguments: (value) => normalizeArguments<WorkflowNodeGateSubmission>(value),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.submitNodeGate(parameters);
				return {
					content: [{ type: "text", text: `Workflow Node Gate accepted: ${parameters.nodeId}.` }],
					details: {},
				};
			},
		}),
		defineTool({
			name: WORKFLOW_ACCEPTANCE_TOOL_NAME,
			label: "Submit Workflow Acceptance Criterion",
			description: "Create or replace one final acceptance Criterion. Submit one Criterion per call.",
			parameters: WorkflowAcceptanceSubmissionSchema,
			prepareArguments: (value) => normalizeArguments<WorkflowAcceptanceSubmission>(value),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.submitAcceptance(parameters);
				return {
					content: [{ type: "text", text: `Workflow acceptance Criterion accepted: ${parameters.id}.` }],
					details: {},
				};
			},
		}),
		defineTool({
			name: WORKFLOW_NODE_TOOL_NAME,
			label: "Submit Workflow Node",
			description: "Create or replace one complete Execution Node. Submit one business Artifact Node per call.",
			parameters: WorkflowNodeSubmissionSchema,
			prepareArguments: (value) => normalizeArguments<WorkflowNodeSubmission>(value, ["skills"]),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.submitNode(parameters);
				return { content: [{ type: "text", text: `Workflow Node accepted: ${parameters.id}.` }], details: {} };
			},
		}),
		defineTool({
			name: WORKFLOW_NODE_REMOVE_TOOL_NAME,
			label: "Remove Workflow Node",
			description:
				"Remove one obsolete Execution Node and its Gate from a preloaded template or Compiler revision candidate.",
			parameters: WorkflowNodeRemovalSchema,
			prepareArguments: (value) => normalizeArguments<Static<typeof WorkflowNodeRemovalSchema>>(value),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.removeNode(parameters.nodeId);
				return { content: [{ type: "text", text: `Workflow Node removed: ${parameters.nodeId}.` }], details: {} };
			},
		}),
		defineTool({
			name: WORKFLOW_FINAL_TOOL_NAME,
			label: "Submit Workflow Final Gate",
			description: "Create or replace the final Artifact selection and complete Final Gate.",
			parameters: WorkflowFinalSubmissionSchema,
			prepareArguments: (value) => normalizeArguments<WorkflowFinalSubmission>(value),
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute(_toolCallId, parameters) {
				builder.submitFinal(parameters);
				return { content: [{ type: "text", text: "Workflow final section accepted." }], details: {} };
			},
		}),
		defineTool({
			name: WORKFLOW_FINALIZE_TOOL_NAME,
			label: "Finalize Workflow",
			description:
				"Assemble and validate the submitted sections. Call only after header, every Node, and final section are accepted.",
			parameters: FinalizeWorkflowSchema,
			constrainedSampling: PREFER_STRICT_SAMPLING,
			executionMode: "sequential",
			async execute() {
				builder.finalize();
				return {
					content: [{ type: "text", text: "Workflow assembled and accepted for deterministic compilation." }],
					details: { submitted: true },
					terminate: true,
				};
			},
		}),
	];
}
