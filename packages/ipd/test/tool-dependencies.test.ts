import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { compileWorkflow, validateSchema, type WorkflowDefinition, WorkflowDefinitionSchema } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

it("rejects an incomplete retrieval capability without granting its companion implicitly", () => {
	const f = createCompilerFixture();
	f.assets.tools = [
		{ id: "fetch_content", hash: "a".repeat(64), source: "test", requiredTools: ["get_search_content"] },
		{ id: "get_search_content", hash: "b".repeat(64), source: "test" },
	];
	f.assets.agentCards = f.assets.agentCards.map((card) => ({
		...card,
		tools: ["fetch_content", "get_search_content"],
	}));
	f.workflow.nodes[0].agents[0].tools = [{ id: "fetch_content" }];
	const missing = compileWorkflow(f);
	expect(missing.ok).toBe(false);
	if (!missing.ok)
		expect(missing.report.diagnostics).toContainEqual(expect.objectContaining({ code: "tool_dependency_missing" }));
	f.workflow.nodes[0].agents[0].tools.push({ id: "get_search_content" });
	expect(compileWorkflow(f).ok).toBe(true);
});

it("adds explicit paging to template 1.0.2 without changing the gates or other nodes", async () => {
	const old = JSON.parse(
		await readFile(new URL("../assets/workflows/important-meeting-ppt/1.0.1.json", import.meta.url), "utf8"),
	) as WorkflowDefinition;
	const next = JSON.parse(
		await readFile(new URL("../assets/workflows/important-meeting-ppt/1.0.2.json", import.meta.url), "utf8"),
	) as WorkflowDefinition;
	expect(validateSchema(WorkflowDefinitionSchema, next, "template").ok).toBe(true);
	const research = next.nodes.find((node) => node.node_id === "research-and-evidence")!;
	expect(research.agents[0].tools).toContainEqual({ id: "get_search_content" });
	expect(research.agents[0].permissions).toEqual(
		old.nodes.find((node) => node.node_id === research.node_id)!.agents[0].permissions,
	);
	const restored = structuredClone(next);
	restored.workflow_version = old.workflow_version;
	restored.nodes = restored.nodes.map((node) =>
		node.node_id === research.node_id ? old.nodes.find((candidate) => candidate.node_id === node.node_id)! : node,
	);
	expect(restored).toEqual(old);
});
