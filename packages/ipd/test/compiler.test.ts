import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/index.ts";
import {
	cardRef,
	compileCard,
	createCompileContext,
	createTestCards,
	createValidWorkflow,
	TEST_SKILL,
} from "./fixtures.ts";

describe("compileWorkflow", () => {
	it("compiles, freezes, hashes, and orders a valid workflow", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.topologicalOrder).toEqual(["produce"]);
		expect(result.value.hash).toMatch(/^[a-f0-9]{64}$/);
		expect(Object.isFrozen(result.value.definition)).toBe(true);
		expect(Object.isFrozen(result.value.definition.nodes[0])).toBe(true);
	});

	it("compiles a valid fan-out and fan-in Artifact graph", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		const research = structuredClone(workflow.nodes[0]);
		research.id = "research";
		research.output.id = "research-output";
		research.output.artifactType = "research";
		research.gate.id = "research-gate";
		research.gate.mechanicalCriteria[0].id = "research-mechanical";
		research.gate.semanticCriteria[0].id = "research-semantic";
		research.gate.reviewers[0].id = "research-reviewer";
		research.gate.routes.rework = "research";
		research.rework.targetNodeId = "research";

		const assemble = structuredClone(workflow.nodes[0]);
		assemble.id = "assemble";
		assemble.dependsOn = ["produce", "research"];
		assemble.inputs = [
			{ name: "content", fromNodeId: "produce", artifactType: "content", required: true },
			{ name: "research", fromNodeId: "research", artifactType: "research", required: true },
		];
		assemble.output.id = "assembled-output";
		assemble.gate.id = "assemble-gate";
		assemble.gate.mechanicalCriteria[0].id = "assemble-mechanical";
		assemble.gate.semanticCriteria[0].id = "assemble-semantic";
		assemble.gate.reviewers[0].id = "assemble-reviewer";
		assemble.gate.routes.rework = "assemble";
		assemble.rework.targetNodeId = "assemble";
		workflow.nodes.push(research, assemble);
		workflow.finalArtifactNodeIds = ["assemble"];

		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.topologicalOrder).toEqual(["produce", "research", "assemble"]);
	});

	it("rejects a successful Artifact dependency cycle", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		const second = structuredClone(workflow.nodes[0]);
		second.id = "assemble";
		second.dependsOn = ["produce"];
		second.inputs = [{ name: "content", fromNodeId: "produce", artifactType: "content", required: true }];
		second.output.id = "assembled-output";
		second.gate.id = "assemble-gate";
		second.gate.mechanicalCriteria[0].id = "assemble-mechanical";
		second.gate.semanticCriteria[0].id = "assemble-semantic";
		second.gate.reviewers[0].id = "assemble-reviewer";
		second.gate.routes.rework = "assemble";
		second.rework.targetNodeId = "assemble";
		workflow.nodes[0].dependsOn = ["assemble"];
		workflow.nodes.push(second);
		workflow.finalArtifactNodeIds = ["assemble"];

		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("success_graph_cycle");
	});

	it("rejects nodes without both mechanical and semantic Gate criteria", () => {
		const mechanicalOnly = createValidWorkflow();
		mechanicalOnly.nodes[0].gate.semanticCriteria = [];
		const result = compileWorkflow(mechanicalOnly, createCompileContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("schema_invalid");
	});

	it("rejects execution nodes without reviewable business artifacts", () => {
		const workflow = createValidWorkflow();
		workflow.nodes[0].output.requiredRoles = ["primary", "evidence"];
		const result = compileWorkflow(workflow, createCompileContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("mechanical_only_node");
	});

	it("rejects unavailable and self-review-only reviewers", () => {
		const cards = createTestCards();
		cards.executor = compileCard({
			id: "executor",
			name: "Executor",
			description: "Produces and can review business artifacts",
			responsibilities: ["Produce the assigned artifact"],
			nonResponsibilities: [],
			capabilities: ["content", "review"],
			tools: ["read", "write"],
			permissions: {
				workspace: "write",
				readScopes: ["."],
				writeScopes: ["outputs"],
				externalActions: false,
			},
		});
		const workflow = createValidWorkflow(cards);
		const context = createCompileContext(cards);
		context.agentCards = [cards.executor, cards.staff];
		const result = compileWorkflow(workflow, context);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("reviewer_not_independent");
	});

	it("rejects unknown checks and invalid check parameters", () => {
		const missing = createValidWorkflow();
		missing.nodes[0].gate.mechanicalCriteria[0].checkId = "missing-check";
		const missingResult = compileWorkflow(missing, createCompileContext());
		expect(missingResult.ok).toBe(false);
		if (!missingResult.ok) {
			expect(missingResult.diagnostics.map((item) => item.code)).toContain("unknown_check");
		}

		const invalid = createValidWorkflow();
		invalid.nodes[0].gate.mechanicalCriteria[0].parameters = { wrong: true };
		const invalidResult = compileWorkflow(invalid, createCompileContext());
		expect(invalidResult.ok).toBe(false);
		if (!invalidResult.ok) {
			expect(invalidResult.diagnostics.map((item) => item.code)).toContain("check_parameters_invalid");
		}
	});

	it("rejects permission, tool, and Skill escalation beyond the selected AgentCard", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		workflow.nodes[0].permissions.writeScopes = ["private"];
		workflow.nodes[0].tools.push("bash");
		workflow.nodes[0].skills = ["other-skill"];
		const context = createCompileContext(cards);
		context.skillNames = new Set([TEST_SKILL, "other-skill"]);
		const result = compileWorkflow(workflow, context);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("permission_exceeded");
	});

	it("requires the frozen Workflow Skill to match the Run Skill", () => {
		const workflow = createValidWorkflow();
		workflow.skill.hash = "2".repeat(64);
		const result = compileWorkflow(workflow, createCompileContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("skill_mismatch");
	});

	it("rejects incompatible Artifact bindings", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		const second = structuredClone(workflow.nodes[0]);
		second.id = "assemble";
		second.dependsOn = ["produce"];
		second.inputs = [{ name: "input", fromNodeId: "produce", artifactType: "different", required: true }];
		second.output.id = "assembled-output";
		second.gate.id = "assemble-gate";
		second.gate.mechanicalCriteria[0].id = "assemble-mechanical";
		second.gate.semanticCriteria[0].id = "assemble-semantic";
		second.gate.reviewers[0].id = "assemble-reviewer";
		second.gate.routes.rework = "assemble";
		second.rework.targetNodeId = "assemble";
		workflow.nodes.push(second);
		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("artifact_type_mismatch");
	});

	it("rejects incomplete final coverage and invalid budgets", () => {
		const workflow = createValidWorkflow();
		workflow.finalGate.objectiveCoverage = [];
		workflow.globalBudget.tokens = 1;
		const result = compileWorkflow(workflow, createCompileContext());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toEqual(
			expect.arrayContaining(["final_coverage_incomplete", "budget_invalid"]),
		);
	});

	it("rejects stale AgentCard references", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		workflow.nodes[0].agentCardRef = { ...cardRef(cards.executor), hash: "0".repeat(64) };
		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("unknown_agent_card");
	});

	it("rejects nodes that do not contribute to a final Artifact", () => {
		const cards = createTestCards();
		const workflow = createValidWorkflow(cards);
		const orphan = structuredClone(workflow.nodes[0]);
		orphan.id = "orphan";
		orphan.output.id = "orphan-output";
		orphan.gate.id = "orphan-gate";
		orphan.gate.mechanicalCriteria[0].id = "orphan-mechanical";
		orphan.gate.semanticCriteria[0].id = "orphan-semantic";
		orphan.gate.reviewers[0].id = "orphan-reviewer";
		orphan.gate.routes.rework = "orphan";
		orphan.rework.targetNodeId = "orphan";
		workflow.nodes.push(orphan);
		const result = compileWorkflow(workflow, createCompileContext(cards));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("unreachable_node");
	});
});
