import { type AssistantMessage, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import Type from "typebox";
import {
	type AgentCardAsset,
	type AgentCardCompileContext,
	type AgentCardRef,
	type CompiledAgentCard,
	compileAgentCard,
	WORKFLOW_ACCEPTANCE_TOOL_NAME,
	WORKFLOW_FINAL_TOOL_NAME,
	WORKFLOW_FINALIZE_TOOL_NAME,
	WORKFLOW_HEADER_TOOL_NAME,
	WORKFLOW_NODE_GATE_TOOL_NAME,
	WORKFLOW_NODE_TOOL_NAME,
	type WorkflowCompileContext,
	type WorkflowDefinition,
} from "../src/index.ts";

export const TEST_SKILL = "task-skill";
export const TEST_SKILL_HASH = "1".repeat(64);
export const TEST_TOOLS = new Set(["read", "write", "bash"]);

const cardCompileContext: AgentCardCompileContext = {
	skillNames: new Set([TEST_SKILL]),
	toolNames: TEST_TOOLS,
	hasModel: () => true,
};

export function compileCard(asset: AgentCardAsset, source = `${asset.id}.yaml`): CompiledAgentCard {
	const result = compileAgentCard(asset, source, cardCompileContext);
	if (!result.value) {
		throw new Error(result.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));
	}
	return result.value;
}

export function cardRef(card: CompiledAgentCard): AgentCardRef {
	return { id: card.id, version: card.version, hash: card.hash };
}

export function createTestCards(): {
	executor: CompiledAgentCard;
	reviewer: CompiledAgentCard;
	staff: CompiledAgentCard;
} {
	const executor = compileCard({
		id: "executor",
		name: "Executor",
		description: "Produces business artifacts",
		responsibilities: ["Produce the assigned artifact"],
		nonResponsibilities: ["Approve its own artifact"],
		capabilities: ["content"],
		applicableScenarios: ["A bounded business Artifact needs implementation"],
		principles: ["Submit evidence, not completion claims"],
		deliverables: ["Primary Artifact", "Reviewable derivative"],
		promptProfile: {
			approach: ["Work only from accepted inputs"],
			communication: ["State assumptions and file paths"],
			verification: ["Check the output contract before submission"],
		},
		knowledgeBases: [{ id: "workspace-inputs", description: "Run Skill and accepted inputs", paths: ["."] }],
		tools: ["read", "write"],
		permissions: {
			workspace: "write",
			readScopes: ["."],
			writeScopes: ["outputs"],
			externalActions: false,
		},
	});
	const reviewer = compileCard({
		id: "reviewer",
		name: "Reviewer",
		description: "Reviews artifact semantics",
		responsibilities: ["Review evidence"],
		nonResponsibilities: ["Produce the artifact"],
		capabilities: ["review"],
	});
	const staff = compileCard({
		id: "staff",
		name: "Staff Core",
		description: "Coordinates workflow decisions",
		responsibilities: ["Coordinate the workflow"],
		nonResponsibilities: ["Produce business artifacts"],
		capabilities: [
			"staff",
			"staff-core",
			"workflow-planning",
			"delivery-governance",
			"budget-governance",
			"quality-governance",
		],
	});
	return { executor, reviewer, staff };
}

function createGate(id: string, rework: string, pass: string, objectiveCoverage: string[]) {
	return {
		id,
		mechanicalCriteria: [
			{
				id: `${id}-mechanical`,
				description: "Required Artifact files exist",
				checkId: "artifact-exists",
				parameters: { path: "outputs/primary.txt" },
				requiredEvidence: ["Artifact manifest"],
			},
		],
		semanticCriteria: [
			{
				id: `${id}-semantic`,
				description: "Artifact satisfies its business objective",
				required: true as const,
				reviewerCapabilities: ["review"],
				evidenceRequirements: ["Reviewable Artifact content"],
			},
		],
		reviewers: [{ id: `${id}-reviewer`, capabilities: ["review"], minCount: 1 }],
		objectiveCoverage,
		aggregation: {
			requiredMechanical: "all" as const,
			requiredSemantic: "all" as const,
			conflict: "staff_arbitration" as const,
		},
		routes: {
			pass,
			rework,
			blocked: "staff" as const,
			escalate: "staff" as const,
		},
	};
}

export function createValidWorkflow(cards = createTestCards()): WorkflowDefinition {
	return {
		schemaVersion: 1,
		id: "test-workflow",
		version: "1.0.0",
		name: "Test Workflow",
		objective: "Produce a reviewed business artifact",
		skill: { name: TEST_SKILL, hash: TEST_SKILL_HASH },
		acceptanceCriteria: [{ id: "goal", description: "The final artifact meets the user goal" }],
		source: "generated",
		globalBudget: {
			mode: "bounded",
			tokens: 100_000,
			timeLimitMs: 3_600_000,
			staffTokens: 10_000,
			reviewerTokens: 10_000,
			reworkTokens: 10_000,
		},
		staff: { core: [cardRef(cards.staff)] },
		nodes: [
			{
				kind: "execution",
				id: "produce",
				objective: "Produce content for the requested business outcome",
				agentCardRef: cardRef(cards.executor),
				requiredCapabilities: ["content"],
				knowledgeBaseRefs: cards.executor.knowledgeBases.map((knowledgeBase) => knowledgeBase.id),
				dependsOn: [],
				inputs: [],
				output: {
					id: "content-output",
					artifactType: "content",
					description: "Produced content and its review representation",
					businessPurpose: "Satisfy the requested business outcome",
				},
				skills: [TEST_SKILL],
				tools: ["read", "write"],
				permissions: {
					workspace: "write",
					readScopes: ["."],
					writeScopes: ["outputs"],
					externalActions: false,
				},
				budget: { mode: "bounded", tokens: 20_000, timeLimitMs: 900_000 },
				gate: createGate("produce-gate", "produce", "continue", []),
				rework: { maxAttempts: 10, targetNodeId: "produce" },
				routes: { blocked: "staff", exhausted: "fail" },
			},
		],
		finalArtifactNodeIds: ["produce"],
		finalGate: createGate("final-gate", "produce", "final", ["goal"]),
	};
}

function authoringGate(gate: WorkflowDefinition["finalGate"]) {
	return {
		...gate,
		mechanicalCriteria: gate.mechanicalCriteria.map(({ parameters, ...criterion }) => ({
			...criterion,
			parametersJson: JSON.stringify(parameters),
		})),
	};
}

function authoringNode(node: WorkflowDefinition["nodes"][number]) {
	return {
		id: node.id,
		objective: node.objective,
		agentCardRef: node.agentCardRef,
		requiredCapabilities: node.requiredCapabilities,
		knowledgeBaseRefs: node.knowledgeBaseRefs,
		dependsOn: node.dependsOn,
		inputs: node.inputs,
		output: node.output,
		tools: node.tools,
		permissions: node.permissions,
		budget: node.budget,
		rework: { targetNodeId: node.rework.targetNodeId },
		routes: node.routes,
	};
}

export function createWorkflowSubmissionMessages(workflow: WorkflowDefinition): AssistantMessage[] {
	const header = {
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
	return [
		fauxAssistantMessage(fauxToolCall(WORKFLOW_HEADER_TOOL_NAME, header), { stopReason: "toolUse" }),
		...workflow.acceptanceCriteria.map((criterion) =>
			fauxAssistantMessage(fauxToolCall(WORKFLOW_ACCEPTANCE_TOOL_NAME, criterion), { stopReason: "toolUse" }),
		),
		...workflow.nodes.flatMap((node) => [
			fauxAssistantMessage(fauxToolCall(WORKFLOW_NODE_TOOL_NAME, authoringNode(node)), { stopReason: "toolUse" }),
			fauxAssistantMessage(
				fauxToolCall(WORKFLOW_NODE_GATE_TOOL_NAME, { nodeId: node.id, gate: authoringGate(node.gate) }),
				{ stopReason: "toolUse" },
			),
		]),
		fauxAssistantMessage(
			fauxToolCall(WORKFLOW_FINAL_TOOL_NAME, {
				finalArtifactNodeIds: workflow.finalArtifactNodeIds,
				finalGate: authoringGate(workflow.finalGate),
			}),
			{ stopReason: "toolUse" },
		),
		fauxAssistantMessage(fauxToolCall(WORKFLOW_FINALIZE_TOOL_NAME, { confirmation: "finalize" }), {
			stopReason: "toolUse",
		}),
	];
}

export function createCompileContext(cards = createTestCards()): WorkflowCompileContext {
	return {
		agentCards: [cards.executor, cards.reviewer, cards.staff],
		fixedStaffCore: [cardRef(cards.staff)],
		runSkill: { name: TEST_SKILL, hash: TEST_SKILL_HASH },
		skillNames: new Set([TEST_SKILL]),
		toolNames: TEST_TOOLS,
		workflowAssetIds: new Set(),
		workflowAssetRefs: new Set(),
		checks: [
			{
				id: "artifact-exists",
				parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
			},
		],
	};
}
