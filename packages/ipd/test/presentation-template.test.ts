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

describe("important meeting PPT templates", () => {
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

	it("compiles the lean 1.0.4 variant with the same governance graph and a single broad visual criterion", async () => {
		const lean = JSON.parse(
			await readFile(new URL("../assets/workflows/important-meeting-ppt/1.0.4.json", import.meta.url), "utf8"),
		) as WorkflowDefinition;
		const result = compileWorkflow(input(lean));
		expect(result.ok, !result.ok ? JSON.stringify(result.report.diagnostics) : "").toBe(true);
		if (!result.ok) return;
		const previousResult = compileWorkflow(input());
		if (!previousResult.ok) throw new Error("Previous template did not compile");
		expect(result.baseline.graph.reverse).toEqual(previousResult.baseline.graph.reverse);
		expect(lean.nodes.map((node) => node.node_id)).toEqual(workflow.nodes.map((node) => node.node_id));
		for (const node of lean.nodes) {
			const previous = workflow.nodes.find((candidate) => candidate.node_id === node.node_id)!;
			expect(
				node.agents.map((agent) => ({
					agent_ref: agent.agent_ref,
					tools: agent.tools,
					skills: agent.skills,
					permissions: agent.permissions,
				})),
			).toEqual(
				previous.agents.map((agent) => ({
					agent_ref: agent.agent_ref,
					tools: agent.tools,
					skills: agent.skills,
					permissions: agent.permissions,
				})),
			);
		}
		expect(lean.nodes.reduce((count, node) => count + node.contract.work_requirements.length, 0)).toBeLessThan(
			workflow.nodes.reduce((count, node) => count + node.contract.work_requirements.length, 0),
		);
		expect(lean.criteria.filter((item) => item.criterion_id.startsWith("visual."))).toHaveLength(1);
		expect(result.baseline.graph.reviewsByOutput["visual-design/presentation-visual-system"]).toEqual([
			"design-gate",
		]);
		expect(lean.completion.delivery_outputs).toEqual([
			{ node_id: "produce-and-finalize", output_id: "final-presentation-package" },
		]);
	});

	async function workPackageTemplate(): Promise<WorkflowDefinition> {
		return JSON.parse(
			await readFile(new URL("../assets/workflows/important-meeting-ppt/1.1.0.json", import.meta.url), "utf8"),
		) as WorkflowDefinition;
	}

	it("compiles 1.1.0 with a real research agenda and independent early visual preparation", async () => {
		const candidate = await workPackageTemplate();
		const result = compileWorkflow(input(candidate));
		expect(result.ok, !result.ok ? JSON.stringify(result.report.diagnostics) : "").toBe(true);
		if (!result.ok) return;
		expect(result.baseline.graph.reverse["meeting-brief"]).toEqual([]);
		expect(result.baseline.graph.reverse["research-and-evidence"]).toEqual(["meeting-brief"]);
		expect(result.baseline.graph.reverse["visual-design"]).toEqual(["meeting-brief"]);
		expect(result.baseline.graph.reverse["storyline-design"]).toEqual([
			"baseline-gate",
			"meeting-brief",
			"research-and-evidence",
		]);
		expect(candidate.nodes.filter((node) => node.kind === "execution")).toHaveLength(5);
		expect(candidate.completion.required_review_node_ids).toEqual([
			"baseline-gate",
			"design-gate",
			"release-gate",
		]);
		expect(candidate.completion.final_outputs.map((output) => output.output_id)).toEqual([
			"presentation-deck",
			"final-presentation-package",
			"validation-evidence",
		]);
		expect(candidate.completion.delivery_outputs).toEqual([
			{ node_id: "produce-and-finalize", output_id: "final-presentation-package" },
		]);
		expect(candidate.criteria.find((criterion) => criterion.criterion_id === "release.one-pptx")).toMatchObject({
			kind: "mechanical",
			parameters: { exact_count: 1, extensions: [".pptx"] },
		});
	});

	it("rejects candidate research without its declared stage-internal permission", async () => {
		const candidate = await workPackageTemplate();
		if (!candidate.stages?.[0]) throw new Error("Missing preparation stage");
		candidate.stages[0].internal_uses = candidate.stages[0].internal_uses.filter(
			(use) => use.consumer_node_id !== "research-and-evidence",
		);
		const result = compileWorkflow(input(candidate));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.report.diagnostics).toContainEqual(
				expect.objectContaining({ code: "unapproved_execution_input", nodeId: "research-and-evidence" }),
			);
	});

	it("rejects crossing the preparation scope with an unapproved visual candidate", async () => {
		const candidate = await workPackageTemplate();
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
			expect(result.report.diagnostics).toContainEqual(expect.objectContaining({ code: "stage_exit_bypass" }));
	});

	it("requires explicit subjects for both new composite review judgments", async () => {
		for (const reviewId of ["design-gate", "release-gate"]) {
			const candidate = await workPackageTemplate();
			const review = candidate.nodes.find((node) => node.node_id === reviewId)!;
			if (review.kind !== "review") throw new Error("Missing review");
			delete review.criterion_subjects;
			const result = compileWorkflow(input(candidate));
			expect(result.ok).toBe(false);
			if (!result.ok)
				expect(result.report.diagnostics).toContainEqual(
					expect.objectContaining({ code: "review_criterion_target_ambiguous" }),
				);
		}
	});

	it("does not route a narrative-evidence defect to the independent visual producer", async () => {
		const candidate = await workPackageTemplate();
		const review = candidate.nodes.find((node) => node.node_id === "design-gate")!;
		if (review.kind !== "review") throw new Error("Missing review");
		const mapping = review.remediation_mappings?.find((item) => item.criterion_id === "design.argument");
		if (!mapping) throw new Error("Missing narrative remediation mapping");
		mapping.owner = { node_id: "visual-design", output_id: "presentation-visual-system" };
		const result = compileWorkflow(input(candidate));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.report.diagnostics).toContainEqual(
				expect.objectContaining({ code: "remediation_mapping_invalid" }),
			);
	});

	it("requires the reviewer to bind an upstream owner before routing repair to it", async () => {
		const candidate = await workPackageTemplate();
		const review = candidate.nodes.find((node) => node.node_id === "release-gate")!;
		if (review.kind !== "review") throw new Error("Missing review");
		review.inputs = review.inputs.filter(
			(item) => item.kind !== "node_output" || item.source.node_id !== "research-and-evidence",
		);
		const result = compileWorkflow(input(candidate));
		expect(result.ok).toBe(false);
		if (!result.ok)
			expect(result.report.diagnostics).toContainEqual(
				expect.objectContaining({ code: "remediation_mapping_invalid" }),
			);
	});
});
