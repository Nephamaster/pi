import { describe, expect, it } from "vitest";
import { type CompilerAssetCatalog, compileWorkflow, hashJson } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

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

	it("rejects native write tools on a read-only review node", () => {
		const fixture = createCompilerFixture();
		const review = fixture.workflow.nodes.find((node) => node.kind === "review");
		if (!review) throw new Error("Missing review node");
		review.agents[0].tools = [{ id: "write" }];
		const assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((card) =>
				card.id === "reviewer" ? { ...structuredClone(card), tools: ["write"] } : card,
			),
			tools: [{ id: "write", hash: "b".repeat(64), source: "pi-builtin" }],
		};
		const result = compileWorkflow({ ...fixture, assets });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("review_write_tool_forbidden");
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
