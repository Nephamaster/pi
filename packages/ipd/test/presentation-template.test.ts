import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import {
	AssetAssembler,
	type CompilerAssetCatalog,
	compileWorkflow,
	createArtifactFileSetCheckExecutor,
	hashJson,
	type ProcessSpec,
	toCompilerAssetCatalog,
	type WorkflowDefinition,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("important meeting PPT 1.0.3", () => {
	let workflow: WorkflowDefinition;
	let processSpec: ProcessSpec;
	let assets: CompilerAssetCatalog;
	beforeAll(async () => {
		workflow = JSON.parse(
			await readFile(new URL("../assets/workflows/important-meeting-ppt/1.0.3.json", import.meta.url), "utf8"),
		) as WorkflowDefinition;
		const assembled = await new AssetAssembler().assemble({
			agentCardDirectories: [fileURLToPath(new URL("../assets/agency-role-library/agent-cards", import.meta.url))],
			processSpecDirectories: [fileURLToPath(new URL("../assets/process-specs", import.meta.url))],
			skills: [],
			tools: [],
			builtinToolNames: [
				"read",
				"write",
				"edit",
				"grep",
				"find",
				"ls",
				"bash",
				"web_search",
				"fetch_content",
				"get_search_content",
				"source_check",
			],
			hasModel: () => true,
		});
		processSpec = assembled.processSpecs.find(
			(spec) => spec.process_spec_id === "project-important-meeting-presentation-simple",
		)!;
		const { assets: fixtureAssets } = createCompilerFixture();
		fixtureAssets.checks.add(createArtifactFileSetCheckExecutor());
		assets = toCompilerAssetCatalog(assembled, fixtureAssets.checks);
		// Declared dependency fixture: compilation checks bindings, not installed PPTX software or model quality.
		assets.skills = [
			{
				id: "pptx",
				hash: "a".repeat(64),
				source: "test",
				filePath: "/virtual/pptx/SKILL.md",
				baseDir: "/virtual/pptx",
				description: "Static PPTX dependency fixture",
				allowedTools: ["read", "bash"],
				requiredTools: ["bash"],
			},
		];
		assets.tools = assets.tools.map((tool) =>
			["web_search", "fetch_content"].includes(tool.id)
				? { ...tool, execution: "control_read", requiredTools: ["get_search_content"] }
				: tool,
		);
	});

	function input(candidate = structuredClone(workflow)) {
		const fixture = createCompilerFixture();
		fixture.taskInput.materials = [];
		fixture.processSelection.task_input_ref.hash = hashJson(fixture.taskInput);
		fixture.processSelection.process_spec_ref = {
			id: processSpec.process_spec_id,
			version: processSpec.version,
			hash: hashJson(processSpec),
		};
		fixture.processSelection.process_requirement_refs = [];
		candidate.task_input_ref = fixture.processSelection.task_input_ref;
		candidate.process_selection_ref = {
			id: fixture.processSelection.process_selection_id,
			hash: hashJson(fixture.processSelection),
		};
		return { ...fixture, processSpec, workflow: candidate, assets };
	}

	it("compiles the eight nodes against packaged professional roles and the actual governing ProcessSpec", () => {
		const result = compileWorkflow(input());
		expect(result.ok, !result.ok ? JSON.stringify(result.report.diagnostics) : "").toBe(true);
		if (!result.ok) return;
		expect(result.baseline.nodes.map((node) => node.definition.node_id)).toEqual([
			"meeting-brief",
			"research-and-evidence",
			"baseline-gate",
			"storyline-design",
			"visual-design",
			"design-gate",
			"produce-and-finalize",
			"release-gate",
		]);
		const graph = result.baseline.graph;
		expect(graph.reverse["meeting-brief"]).toEqual([]);
		expect(graph.reverse["research-and-evidence"]).toEqual([]);
		const commonBaseline = ["baseline-gate", "meeting-brief", "research-and-evidence"];
		expect(graph.reverse["storyline-design"]).toEqual(commonBaseline);
		expect(graph.reverse["visual-design"]).toEqual(commonBaseline);
		expect(graph.reverse["design-gate"]).toEqual([...commonBaseline, "storyline-design", "visual-design"]);
		expect(graph.reverse["produce-and-finalize"]).toEqual([
			"baseline-gate",
			"design-gate",
			"meeting-brief",
			"research-and-evidence",
			"storyline-design",
			"visual-design",
		]);
		expect(graph.reworkTargetsByReview["design-gate"]).toEqual(["storyline-design", "visual-design"]);
		expect(graph.reviewsByOutput["visual-design/presentation-visual-system"]).toEqual(["design-gate"]);
		expect(result.baseline.workflow.completion.delivery_outputs).toEqual([
			{ node_id: "produce-and-finalize", output_id: "final-presentation-package" },
		]);
	});

	it("requires approval for the separate visual package before production", () => {
		const candidate = structuredClone(workflow);
		const producer = candidate.nodes.find((node) => node.node_id === "produce-and-finalize")!;
		const visualInput = producer.inputs.find(
			(item) => item.kind === "node_output" && item.source.node_id === "visual-design",
		)!;
		if (visualInput.kind !== "node_output") throw new Error("Missing visual input");
		visualInput.availability = "submitted";
		visualInput.approval_review_node_ids = [];
		const result = compileWorkflow(input(candidate));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.report.diagnostics).toContainEqual(
				expect.objectContaining({ code: "unapproved_execution_input", nodeId: "produce-and-finalize" }),
			);
	});

	it("rejects an incomplete paging binding in the research node", () => {
		const candidate = structuredClone(workflow);
		const research = candidate.nodes.find((node) => node.node_id === "research-and-evidence")!;
		research.agents[0].tools = research.agents[0].tools.filter((tool) => tool.id !== "get_search_content");
		const result = compileWorkflow(input(candidate));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.report.diagnostics).toContainEqual(
				expect.objectContaining({ code: "tool_dependency_missing", nodeId: "research-and-evidence" }),
			);
	});
});
