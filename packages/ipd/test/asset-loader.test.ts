import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadAgentCardAssets, loadWorkflowAssets } from "../src/index.ts";
import { createValidWorkflow, TEST_SKILL, TEST_TOOLS } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-assets-"));
	roots.push(root);
	return root;
}

const context = {
	skillNames: new Set([TEST_SKILL]),
	toolNames: TEST_TOOLS,
	hasModel: () => true,
};

describe("asset loaders", () => {
	it("loads and compiles every JSON and YAML AgentCard", async () => {
		const root = await createRoot();
		await writeFile(
			join(root, "first.json"),
			JSON.stringify({
				id: "first",
				name: "First",
				description: "First card",
				responsibilities: ["Work"],
				nonResponsibilities: [],
				capabilities: ["work"],
			}),
		);
		await writeFile(
			join(root, "second.yaml"),
			[
				"id: second",
				"name: Second",
				"description: Second card",
				"responsibilities: [Review]",
				"nonResponsibilities: []",
				"capabilities: [review]",
			].join("\n"),
		);

		const result = await loadAgentCardAssets([root], context);
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.diagnostics).toEqual([]);
		expect(result.cards.map((card) => card.id)).toEqual(["first", "second"]);
	});

	it("reports invalid files and collisions without silently replacing assets", async () => {
		const root = await createRoot();
		const card = {
			id: "duplicate",
			name: "Duplicate",
			description: "Duplicate card",
			responsibilities: ["Work"],
			nonResponsibilities: [],
			capabilities: ["work"],
		};
		await writeFile(join(root, "first.json"), JSON.stringify(card));
		await writeFile(join(root, "second.json"), JSON.stringify(card));
		await writeFile(join(root, "invalid.yaml"), "id: [unterminated");

		const result = await loadAgentCardAssets([root], context);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toEqual(
			expect.arrayContaining(["asset_collision", "asset_parse_failed"]),
		);
	});

	it("loads immutable Workflow asset definitions and detects version collisions", async () => {
		const root = await createRoot();
		const workflow = createValidWorkflow();
		await writeFile(join(root, "first.json"), JSON.stringify(workflow));

		const loaded = await loadWorkflowAssets([root]);
		expect(loaded.ok).toBe(true);
		if (!loaded.ok) return;
		expect(loaded.assets).toHaveLength(1);
		expect(Object.isFrozen(loaded.assets[0].workflow)).toBe(true);

		await writeFile(join(root, "second.json"), JSON.stringify(workflow));

		const result = await loadWorkflowAssets([root]);
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.diagnostics.map((item) => item.code)).toContain("asset_collision");
	});
});
