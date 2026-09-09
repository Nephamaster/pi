import { describe, expect, it } from "vitest";
import { type CompilerAssetCatalog, compileWorkflow, hashJson } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function addSecondaryReview(fixture: ReturnType<typeof createCompilerFixture>): void {
	const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
	const review = fixture.workflow.nodes.find((node) => node.kind === "review");
	if (!producer || producer.kind !== "execution" || !review || review.kind !== "review")
		throw new Error("Fixture nodes are missing");
	producer.outputs[0].criterion_refs.push("secondary-quality");
	fixture.workflow.criteria.push({
		kind: "semantic",
		criterion_id: "secondary-quality",
		description: "The result satisfies a second quality dimension",
		evidence_requirements: ["Independent findings"],
		process_criterion_refs: [],
	});
	const secondary = structuredClone(review);
	secondary.node_id = "review-secondary";
	secondary.name = "Review Secondary Quality";
	secondary.agents[0].participant_id = "secondary-reviewer";
	secondary.targets = [{ node_id: "produce", output_id: "content-output", criterion_refs: ["secondary-quality"] }];
	fixture.workflow.nodes.push(secondary);
	fixture.workflow.completion.required_node_ids.push("review-secondary");
}

describe("compileWorkflow", () => {
	it("compiles a valid execution and independent review workflow", () => {
		const fixture = createCompilerFixture();
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.baseline.graph.reverse["review-produce"]).toEqual(["produce"]);
		expect(Object.isFrozen(result.baseline)).toBe(true);
	});

	it("rejects a review that reuses an independently reviewed producer AgentCard", () => {
		const fixture = createCompilerFixture();
		const review = fixture.workflow.nodes.find((node) => node.kind === "review");
		if (!review) throw new Error("Missing review node");
		review.agents[0].agent_ref = { id: "producer", version: "1.0.0" };
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("reviewer_not_independent");
	});

	it("rejects overlapping execution output ownership", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer) throw new Error("Missing execution node");
		fixture.workflow.nodes.push({
			...structuredClone(producer),
			node_id: "conflicting-producer",
			name: "Conflicting Producer",
		});
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("output_ownership_conflict");
	});

	it("rejects non-normalized output and permission paths", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer) throw new Error("Missing execution node");
		producer.outputs[0].path_prefix = "outputs/produce/";
		producer.agents[0].permissions.write_paths = ["outputs/produce/"];
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.filter((item) => item.code === "path_not_normalized")).toHaveLength(2);
	});

	it("rejects missing requirement coverage", () => {
		const fixture = createCompilerFixture();
		fixture.workflow.requirement_coverage = fixture.workflow.requirement_coverage.filter(
			(item) => item.requirement_id !== "content-review",
		);
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("requirement_uncovered");
	});

	it("requires every user delivery output to be an approved final output", () => {
		const fixture = createCompilerFixture();
		fixture.workflow.completion.delivery_outputs = [{ node_id: "produce", output_id: "missing" }];
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("delivery_output_not_final");
	});

	it("requires completion Gates to cover every semantic output criterion", () => {
		const fixture = createCompilerFixture();
		addSecondaryReview(fixture);
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("final_output_review_incomplete");
	});

	it("requires downstream approval Gates to cover every semantic input criterion", () => {
		const fixture = createCompilerFixture();
		addSecondaryReview(fixture);
		fixture.assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((card) =>
				card.id === "producer"
					? { ...structuredClone(card), permissions: { ...card.permissions, writeScopes: ["outputs"] } }
					: card,
			),
		};
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer || producer.kind !== "execution") throw new Error("Missing execution node");
		const consumer = structuredClone(producer);
		consumer.node_id = "consumer";
		consumer.name = "Consumer";
		consumer.agents[0].participant_id = "consumer";
		consumer.agents[0].permissions.write_paths = ["outputs/consumer"];
		consumer.inputs = [
			{
				kind: "node_output",
				input_id: "upstream",
				source: { node_id: "produce", output_id: "content-output" },
				required: true,
				availability: "approved",
				approval_review_node_ids: ["review-produce"],
			},
		];
		consumer.outputs[0].output_id = "consumer-output";
		consumer.outputs[0].path_prefix = "outputs/consumer";
		consumer.outputs[0].criterion_refs = ["integrity", "quality"];
		consumer.outputs[0].process_evidence_requirement_refs = [];
		fixture.workflow.nodes.push(consumer);
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("approval_criteria_incomplete");
	});

	it("requires explicit ProcessSpec evidence and criterion mappings", () => {
		const missingEvidence = createCompilerFixture();
		const producer = missingEvidence.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer || producer.kind !== "execution") throw new Error("Missing execution node");
		producer.outputs[0].process_evidence_requirement_refs = [];
		const evidenceResult = compileWorkflow(missingEvidence);
		expect(evidenceResult.ok).toBe(false);
		if (!evidenceResult.ok)
			expect(evidenceResult.report.diagnostics.map((item) => item.code)).toContain("process_evidence_unmapped");

		const missingCriterion = createCompilerFixture();
		const criterion = missingCriterion.workflow.criteria.find((item) => item.kind === "semantic");
		if (!criterion || criterion.kind !== "semantic") throw new Error("Missing semantic criterion");
		criterion.process_criterion_refs = [];
		const criterionResult = compileWorkflow(missingCriterion);
		expect(criterionResult.ok).toBe(false);
		if (!criterionResult.ok)
			expect(criterionResult.report.diagnostics.map((item) => item.code)).toContain("process_criterion_unmapped");
	});

	it("rejects an execution node that consumes an unapproved submission", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer) throw new Error("Missing execution node");
		fixture.workflow.nodes.push({
			...structuredClone(producer),
			node_id: "consumer",
			name: "Consumer",
			inputs: [
				{
					kind: "node_output",
					input_id: "upstream",
					source: { node_id: "produce", output_id: "content-output" },
					required: true,
					availability: "submitted",
					approval_review_node_ids: [],
				},
			],
			outputs: producer.outputs.map((output) => ({
				...output,
				output_id: "consumer-output",
				path_prefix: "outputs/consumer",
			})),
			agents: [
				{
					...structuredClone(producer.agents[0]),
					permissions: {
						...structuredClone(producer.agents[0].permissions),
						write_paths: ["outputs/consumer"],
					},
				},
			],
		});
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("unapproved_execution_input");
	});

	it("rejects mutation and general-purpose Shell tools on review nodes", () => {
		for (const toolId of ["write", "bash"]) {
			const fixture = createCompilerFixture();
			const review = fixture.workflow.nodes.find((node) => node.kind === "review");
			if (!review) throw new Error("Missing review node");
			review.agents[0].tools = [{ id: toolId }];
			const assets = {
				...fixture.assets,
				agentCards: fixture.assets.agentCards.map((card) =>
					card.id === "reviewer" ? { ...structuredClone(card), tools: [toolId] } : card,
				),
				tools: [{ id: toolId, hash: "b".repeat(64), source: "pi-builtin" }],
			};
			const result = compileWorkflow({ ...fixture, assets });
			expect(result.ok).toBe(false);
			if (result.ok) continue;
			expect(result.report.diagnostics.map((item) => item.code)).toContain("review_mutation_tool_forbidden");
		}
	});

	it("allows a registered node Skill independently of AgentCard defaults", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer) throw new Error("Missing execution node");
		producer.agents[0].skills = [{ id: "delivery-method" }];
		producer.agents[0].tools = [{ id: "read" }];
		const assets = {
			...fixture.assets,
			tools: [{ id: "read", hash: "c".repeat(64), source: "pi-builtin" }],
			skills: [
				{
					id: "delivery-method",
					hash: "b".repeat(64),
					source: "test",
					filePath: "/skills/delivery-method/SKILL.md",
					baseDir: "/skills/delivery-method",
					description: "Delivery method",
					allowedTools: [],
				},
			],
		} satisfies CompilerAssetCatalog;
		const result = compileWorkflow({ ...fixture, assets });
		expect(result.ok).toBe(true);
	});

	it("fails closed for an unimplemented runtime ProcessSpec rule", () => {
		const fixture = createCompilerFixture();
		fixture.processSpec.workflow_rules.push({
			rule_id: "runtime-rule",
			description: "A runtime invariant",
			enforced_by: "runtime",
		});
		fixture.processSelection.process_spec_ref.hash = hashJson(fixture.processSpec);
		fixture.processSelection.process_requirement_refs.push("runtime-rule");
		fixture.workflow.process_selection_ref.hash = hashJson(fixture.processSelection);
		fixture.workflow.requirement_coverage.push({
			source: "process_rule",
			requirement_id: "runtime-rule",
			responsible_node_ids: ["produce"],
			output_refs: [{ node_id: "produce", output_id: "content-output" }],
			criterion_refs: ["integrity"],
		});
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("process_rule_unsupported");
	});

	it("includes resolved resource content in the Baseline identity", () => {
		const first = createCompilerFixture();
		const firstResult = compileWorkflow(first);
		if (!firstResult.ok) throw new Error("First fixture did not compile");
		const second = createCompilerFixture();
		second.assets = {
			...second.assets,
			agentCards: second.assets.agentCards.map((card) =>
				card.id === "producer" ? { ...structuredClone(card), hash: "b".repeat(64) } : card,
			),
		};
		const secondResult = compileWorkflow(second);
		if (!secondResult.ok) throw new Error("Second fixture did not compile");
		expect(secondResult.baseline.baselineId).not.toBe(firstResult.baseline.baselineId);
	});
});
