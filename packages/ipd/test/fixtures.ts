import Type from "typebox";
import {
	type AgentCardAsset,
	type AgentCardCompileContext,
	type AgentCardRef,
	type CompiledAgentCard,
	compileAgentCard,
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
		capabilities: ["staff"],
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
				parameters: { role: "primary" },
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
			tokens: 100_000,
			timeoutMs: 3_600_000,
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
				dependsOn: [],
				inputs: [],
				output: {
					id: "content-output",
					artifactType: "content",
					description: "Produced content and its review representation",
					businessPurpose: "Satisfy the requested business outcome",
					requiredRoles: ["primary", "review"],
				},
				skills: [TEST_SKILL],
				tools: ["read", "write"],
				permissions: {
					workspace: "write",
					readScopes: ["."],
					writeScopes: ["outputs"],
					externalActions: false,
				},
				budget: { tokens: 20_000, timeoutMs: 900_000 },
				gate: createGate("produce-gate", "produce", "continue", []),
				rework: { maxAttempts: 2, targetNodeId: "produce" },
				routes: { blocked: "staff", exhausted: "fail" },
			},
		],
		finalArtifactNodeIds: ["produce"],
		finalGate: createGate("final-gate", "produce", "final", ["goal"]),
	};
}

export function createCompileContext(cards = createTestCards()): WorkflowCompileContext {
	return {
		agentCards: [cards.executor, cards.reviewer, cards.staff],
		runSkill: { name: TEST_SKILL, hash: TEST_SKILL_HASH },
		skillNames: new Set([TEST_SKILL]),
		toolNames: TEST_TOOLS,
		workflowAssetIds: new Set(),
		checks: [
			{
				id: "artifact-exists",
				parameters: Type.Object({ role: Type.String() }, { additionalProperties: false }),
			},
		],
	};
}
