import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("Skill required tools", () => {
	it("rejects a bound Skill when its required tool is not bound to the node", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer || producer.kind !== "execution") throw new Error("Missing producer node");
		producer.agents[0].skills = [{ id: "presentation-method" }];
		producer.agents[0].tools = [{ id: "read" }];
		fixture.assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((card) =>
				card.id === "producer" ? { ...structuredClone(card), tools: ["read", "bash"] } : card,
			),
			tools: [
				{ id: "read", hash: "c".repeat(64), source: "pi-builtin" },
				{ id: "bash", hash: "d".repeat(64), source: "pi-builtin" },
			],
			skills: [
				{
					id: "presentation-method",
					hash: "b".repeat(64),
					source: "test",
					filePath: "/skills/presentation-method/SKILL.md",
					baseDir: "/skills/presentation-method",
					description: "Presentation production method",
					allowedTools: ["read", "bash"],
					requiredTools: ["bash"],
				},
			],
		};
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.report.diagnostics.map((item) => item.code)).toContain("skill_required_tool_missing");
	});

	it("accepts a bound Skill when every required tool is explicitly bound and authorized", () => {
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes.find((node) => node.kind === "execution");
		if (!producer || producer.kind !== "execution") throw new Error("Missing producer node");
		producer.agents[0].skills = [{ id: "presentation-method" }];
		producer.agents[0].tools = [{ id: "read" }, { id: "bash" }];
		fixture.assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((card) =>
				card.id === "producer" ? { ...structuredClone(card), tools: ["read", "bash"] } : card,
			),
			tools: [
				{ id: "read", hash: "c".repeat(64), source: "pi-builtin" },
				{ id: "bash", hash: "d".repeat(64), source: "pi-builtin" },
			],
			skills: [
				{
					id: "presentation-method",
					hash: "b".repeat(64),
					source: "test",
					filePath: "/skills/presentation-method/SKILL.md",
					baseDir: "/skills/presentation-method",
					description: "Presentation production method",
					allowedTools: ["read", "bash"],
					requiredTools: ["bash"],
				},
			],
		};
		const result = compileWorkflow(fixture);
		expect(result.ok).toBe(true);
	});
});
