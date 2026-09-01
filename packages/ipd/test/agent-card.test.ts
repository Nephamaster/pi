import { describe, expect, it } from "vitest";
import { compileAgentCard } from "../src/index.ts";

const context = {
	skillNames: new Set(["analysis"]),
	toolNames: new Set(["read", "write"]),
	hasModel: (provider: string, modelId: string) => provider === "provider" && modelId === "model",
};

const baseAsset = {
	id: "analyst",
	name: "Analyst",
	description: "Analyzes business inputs",
	responsibilities: ["Analyze inputs"],
	nonResponsibilities: [],
	capabilities: ["analysis"],
};

describe("compileAgentCard", () => {
	it("applies conservative defaults", () => {
		const result = compileAgentCard(baseAsset, "analyst.yaml", context);
		expect(result.diagnostics).toEqual([]);
		expect(result.value).toMatchObject({
			version: "1.0.0",
			model: { selection: "run_default", thinkingLevel: "inherit" },
			skills: [],
			tools: ["read"],
			permissions: {
				workspace: "read",
				readScopes: ["."],
				writeScopes: [],
				externalActions: false,
			},
			defaultBudget: { tokens: 12_000, timeoutMs: 900_000 },
		});
		expect(Object.isFrozen(result.value)).toBe(true);
		expect(Object.isFrozen(result.value?.permissions)).toBe(true);
	});

	it("hashes normalized content independently of source path", () => {
		const first = compileAgentCard(baseAsset, "first/analyst.yaml", context);
		const second = compileAgentCard(baseAsset, "second/analyst.yaml", context);
		expect(first.value?.hash).toBe(second.value?.hash);
	});

	it("rejects incomplete explicit model configuration", () => {
		const result = compileAgentCard(
			{ ...baseAsset, model: { selection: "explicit", provider: "provider" } },
			"analyst.yaml",
			context,
		);
		expect(result.value).toBeUndefined();
		expect(result.diagnostics.map((item) => item.code)).toContain("explicit_model_incomplete");
	});

	it("rejects unknown assets and invalid permissions", () => {
		const result = compileAgentCard(
			{
				...baseAsset,
				skills: ["missing"],
				tools: ["missing"],
				permissions: {
					workspace: "read",
					readScopes: ["../outside"],
					writeScopes: ["output"],
				},
			},
			"analyst.yaml",
			context,
		);
		expect(new Set(result.diagnostics.map((item) => item.code))).toEqual(
			new Set(["unknown_skill", "unknown_tool", "invalid_scope", "permission_exceeded"]),
		);
	});

	it("resolves configured explicit models", () => {
		const result = compileAgentCard(
			{
				...baseAsset,
				model: { selection: "explicit", provider: "provider", id: "model", thinkingLevel: "high" },
			},
			"analyst.yaml",
			context,
		);
		expect(result.diagnostics).toEqual([]);
		expect(result.value?.model).toEqual({
			selection: "explicit",
			provider: "provider",
			id: "model",
			thinkingLevel: "high",
		});
	});
});
