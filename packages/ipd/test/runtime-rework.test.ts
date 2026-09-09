import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	FileRunStore,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("WorkflowRuntime local rework", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("re-reviews a revised target together with the unaffected original submission", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-local-rework-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		fixture.assets = {
			...fixture.assets,
			agentCards: fixture.assets.agentCards.map((card) =>
				card.id === "producer"
					? { ...structuredClone(card), permissions: { ...card.permissions, writeScopes: ["outputs"] } }
					: card,
			),
		};
		const first = fixture.workflow.nodes.find((node) => node.kind === "execution");
		const review = fixture.workflow.nodes.find((node) => node.kind === "review");
		if (!first || first.kind !== "execution" || !review || review.kind !== "review")
			throw new Error("Fixture nodes are missing");
		const second = structuredClone(first);
		second.node_id = "produce-two";
		second.name = "Produce Two";
		second.agents[0].participant_id = "producer-two";
		second.agents[0].permissions.write_paths = ["outputs/produce-two"];
		second.outputs[0].output_id = "content-two";
		second.outputs[0].path_prefix = "outputs/produce-two";
		review.inputs.push({
			kind: "node_output",
			input_id: "candidate-two",
			source: { node_id: "produce-two", output_id: "content-two" },
			required: true,
			availability: "submitted",
			approval_review_node_ids: [],
		});
		review.targets.push({ node_id: "produce-two", output_id: "content-two", criterion_refs: ["quality"] });
		review.allowed_rework_node_ids.push("produce-two");
		fixture.workflow.nodes.push(second);
		fixture.workflow.completion.required_node_ids.push("produce-two");
		fixture.workflow.completion.final_outputs.push({ node_id: "produce-two", output_id: "content-two" });
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok)
			throw new Error(compiled.report.diagnostics.map((item) => `${item.path}: ${item.message}`).join("\n"));

		const directory = await prepareRunDirectory(root, "run-1");
		const executionRounds = new Map<string, number>();
		const reviewInputs: string[][] = [];
		let reviews = 0;
		const worker: NodeWorker = {
			async runExecution(work) {
				const definition = work.node.definition;
				if (definition.kind !== "execution") throw new Error("Expected execution node");
				const count = (executionRounds.get(definition.node_id) ?? 0) + 1;
				executionRounds.set(definition.node_id, count);
				const output = definition.outputs[0];
				await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
				await writeFile(
					join(directory.workspace, output.path_prefix, "result.txt"),
					`${definition.node_id}-${count}`,
				);
				return {
					summary: "produced",
					outputs: [
						{
							output_id: output.output_id,
							files: [{ path: `${output.path_prefix}/result.txt`, media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				reviews++;
				reviewInputs.push(work.inputSubmissions.map((submission) => submission.submissionId).sort());
				const pass = reviews === 2;
				return {
					decision: pass ? "PASS" : "REWORK",
					criteria: [
						{
							criterion_id: "quality",
							result: pass ? "PASS" : "FAIL",
							evidence: [
								{
									description: "Inspected both sealed results",
									reference: "sealed results",
									criterion_id: "quality",
								},
							],
							rationale: pass ? "accepted" : "first result needs revision",
							required_rework: pass ? [] : ["Revise the first result"],
						},
					],
					rework_node_ids: pass ? [] : ["produce"],
					unresolved_issues: [],
				};
			},
		};
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const result = await runtime.run();
		expect(result.status).toBe("succeeded");
		expect(executionRounds.get("produce")).toBe(2);
		expect(executionRounds.get("produce-two")).toBe(1);
		expect(reviewInputs).toEqual([
			["produce-two:round:1:submission", "produce:round:1:submission"],
			["produce-two:round:1:submission", "produce:round:2:submission"],
		]);
		expect(result.submissions.find((submission) => submission.nodeId === "produce-two")?.status).toBe("approved");
	});
});
