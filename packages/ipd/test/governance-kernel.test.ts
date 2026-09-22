import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateGovernance } from "../src/compiler/validate-governance.ts";
import {
	compileWorkflow,
	FileRunStore,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { invalidateOutputRevisions } from "../src/runtime/quality-impact.ts";
import { aggregateAssessments } from "../src/runtime/review-governance.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { passReport, stageFixture } from "./governance-fixtures.ts";

describe("P1 stage governance", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("compiles explicit internal candidates and composite review subjects, rejects bypasses", () => {
		const fixture = stageFixture();
		const compiled = compileWorkflow(fixture);
		expect(compiled.ok, JSON.stringify(compiled)).toBe(true);
		const missingUse = stageFixture();
		missingUse.workflow.stages![0].internal_uses = [];
		const missing = compileWorkflow(missingUse);
		expect(!missing.ok && missing.report.diagnostics.some((item) => item.code === "unapproved_execution_input")).toBe(
			true,
		);
		const cross = stageFixture();
		cross.workflow.stages![0].member_node_ids = cross.workflow.stages![0].member_node_ids.filter(
			(id) => id !== "analysis",
		);
		expect(
			validateGovernance(cross.workflow, cross.taskInput, cross.processSpec).some(
				(item) => item.code === "stage_exit_bypass",
			),
		).toBe(true);
	});

	it("rejects fabricated user requirements and advisory hard Gates", () => {
		const fixture = stageFixture();
		fixture.workflow.requirements = [
			{
				requirement_id: "preference",
				authority: "recommendation",
				strength: "required",
				description: "Use 20 slides",
				source_ref: "method",
				source_quote: "20 slides",
			},
		];
		expect(
			validateGovernance(fixture.workflow, fixture.taskInput, fixture.processSpec).some(
				(item) => item.code === "recommendation_promoted",
			),
		).toBe(true);
		fixture.workflow.requirements[0] = {
			...fixture.workflow.requirements[0],
			authority: "user",
			source_ref: fixture.taskInput.task_input_id,
		};
		expect(
			validateGovernance(fixture.workflow, fixture.taskInput, fixture.processSpec).some(
				(item) => item.code === "requirement_source_mismatch",
			),
		).toBe(true);
	});

	it("keeps an advisory failure visible without blocking release or scheduling production rework", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-p1-advisory-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const producer = fixture.workflow.nodes[0];
		const reviewer = fixture.workflow.nodes[1];
		if (producer.kind !== "execution" || reviewer.kind !== "review") throw new Error("Invalid fixture");
		fixture.workflow.requirements = [
			{
				requirement_id: "layout-suggestion",
				authority: "recommendation",
				strength: "advisory",
				description: "Optional layout idea",
				source_ref: "style-guide",
				source_quote: "Consider alternate layout",
			},
		];
		fixture.workflow.criteria.push({
			kind: "semantic",
			criterion_id: "layout",
			description: "Optional layout idea",
			process_criterion_refs: [],
			evidence_requirements: ["Layout"],
			requirement_refs: ["layout-suggestion"],
			blocking: false,
		});
		producer.outputs[0].criterion_refs.push("layout");
		reviewer.targets[0].criterion_refs.push("layout");
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
		const directory = await prepareRunDirectory(root, fixture.runId);
		let executions = 0;
		const worker: NodeWorker = {
			async runExecution() {
				executions++;
				await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
				await writeFile(join(directory.workspace, "outputs/produce/result.txt"), "Meets required quality");
				return {
					summary: "Ready",
					outputs: [
						{
							output_id: "content-output",
							files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				const report = passReport(work);
				const advisory = report.criteria.find((item) => item.criterion_id === "layout")!;
				advisory.result = "FAIL";
				advisory.required_rework = ["Optional alternate layout"];
				advisory.rework_targets = [{ node_id: "produce", output_id: "content-output" }];
				return report;
			},
		};
		const store = new FileRunStore();
		store.bind(fixture.runId, directory.stateFile);
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(fixture.assets.checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const state = await runtime.run();
		expect(state.status, JSON.stringify(state.failure)).toBe("succeeded");
		expect(executions).toBe(1);
		expect(state.governance.findings[0]).toMatchObject({ blocking: false, status: "open", criterionId: "layout" });
	});

	it("routes a downstream observation to a declared upstream owner without creating a repair approval cycle", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-p1-remediation-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		fixture.assets = stageFixture().assets;
		const producer = fixture.workflow.nodes[0];
		const originalReview = fixture.workflow.nodes[1];
		if (producer.kind !== "execution" || originalReview.kind !== "review") throw new Error("Invalid fixture");
		const downstream = structuredClone(producer);
		downstream.node_id = "downstream";
		downstream.agents[0].participant_id = "downstream-worker";
		downstream.agents[0].permissions.write_paths = ["outputs/downstream"];
		downstream.inputs = [
			{
				kind: "node_output",
				input_id: "upstream",
				source: { node_id: "produce", output_id: "content-output" },
				required: true,
				availability: "approved",
				approval_review_node_ids: ["review-produce"],
			},
		];
		downstream.outputs[0] = {
			...downstream.outputs[0],
			output_id: "downstream-output",
			path_prefix: "outputs/downstream",
			criterion_refs: ["integrity", "integration-quality"],
		};
		const gate = structuredClone(originalReview);
		gate.node_id = "integration-gate";
		gate.agents[0].participant_id = "integration-reviewer";
		gate.targets = [
			{ node_id: "downstream", output_id: "downstream-output", criterion_refs: ["integration-quality"] },
		];
		gate.inputs = [
			{
				kind: "node_output",
				input_id: "candidate",
				source: { node_id: "downstream", output_id: "downstream-output" },
				required: true,
				availability: "submitted",
				approval_review_node_ids: [],
			},
			...structuredClone(downstream.inputs),
		];
		gate.allowed_rework_node_ids = ["produce", "downstream"];
		gate.remediation_mappings = [
			{
				criterion_id: "integration-quality",
				observed: { node_id: "downstream", output_id: "downstream-output" },
				owner: { node_id: "produce", output_id: "content-output" },
			},
		];
		fixture.workflow.nodes.push(downstream, gate);
		fixture.workflow.criteria.push({
			kind: "semantic",
			criterion_id: "integration-quality",
			description: "Integrated values are correct",
			process_criterion_refs: [],
			evidence_requirements: ["Recomputed values"],
		});
		fixture.workflow.completion.required_node_ids.push("downstream", "integration-gate");
		fixture.workflow.completion.required_review_node_ids.push("integration-gate");
		fixture.workflow.completion.final_outputs.push({ node_id: "downstream", output_id: "downstream-output" });
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
		const directory = await prepareRunDirectory(root, fixture.runId);
		const counts = new Map<string, number>();
		let reviews = 0;
		const worker: NodeWorker = {
			async runExecution(work) {
				const node = work.node.definition;
				if (node.kind !== "execution") throw new Error("Expected execution");
				counts.set(node.node_id, (counts.get(node.node_id) ?? 0) + 1);
				const output = node.outputs[0];
				const path = `${output.path_prefix}/result.txt`;
				await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
				await writeFile(join(directory.workspace, path), `${node.node_id}:${counts.get(node.node_id)}`);
				return {
					summary: "Candidate",
					outputs: [{ output_id: output.output_id, files: [{ path, media_type: "text/plain" }] }],
					resolution_claims: (work.findings ?? []).map((finding) => ({
						finding_id: finding.findingId,
						output_id: finding.owner.output_id,
						explanation: "Corrected the upstream data",
						evidence: [path],
					})),
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				const report = passReport(work);
				if (work.node.definition.node_id !== "integration-gate") return report;
				const upstream = work.inputSubmissions.find((item) => item.nodeId === "produce")!;
				report.criteria[0].evidence.push({
					description: "Confirmed upstream source",
					reference: upstream.outputs[0].manifest.files[0].path,
					submission_id: upstream.submissionId,
					node_id: upstream.nodeId,
					output_id: "content-output",
					criterion_id: "integration-quality",
				});
				if (++reviews === 1) {
					report.decision = "REWORK";
					report.criteria[0].result = "FAIL";
					report.criteria[0].required_rework = ["Repair upstream source data"];
					report.criteria[0].rework_targets = [{ node_id: "produce", output_id: "content-output" }];
					report.criteria[0].root_cause = {
						status: "supported",
						explanation: "The downstream computed the supplied upstream values correctly",
					};
				}
				return report;
			},
		};
		const store = new FileRunStore();
		store.bind(fixture.runId, directory.stateFile);
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(fixture.assets.checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const state = await runtime.run();
		expect(state.status, JSON.stringify(state.failure)).toBe("succeeded");
		expect(Object.fromEntries(counts)).toEqual({ produce: 2, downstream: 2 });
		expect(state.governance.findings[0]).toMatchObject({
			status: "resolved",
			rootCause: { status: "supported" },
			owner: { node_id: "produce" },
			reviewNodeId: "integration-gate",
		});
	});

	it("reuses an unaffected sibling output by exact revision while repairing another output", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-p1-preserve-"));
		roots.push(root);
		const fixture = stageFixture();
		const producer = fixture.workflow.nodes[0];
		const review = fixture.workflow.nodes[1];
		if (producer.kind !== "execution" || review.kind !== "review") throw new Error("Fixture invalid");
		producer.outputs.push({
			...structuredClone(producer.outputs[0]),
			output_id: "side-output",
			path_prefix: "outputs/produce/side",
			criterion_refs: ["integrity", "side-quality"],
		});
		fixture.workflow.criteria.push({
			kind: "semantic",
			criterion_id: "side-quality",
			description: "Independent side content",
			process_criterion_refs: [],
			evidence_requirements: ["File content"],
		});
		review.targets.push({ node_id: "produce", output_id: "side-output", criterion_refs: ["side-quality"] });
		review.inputs.push({
			kind: "node_output",
			input_id: "side",
			source: { node_id: "produce", output_id: "side-output" },
			required: true,
			availability: "submitted",
			approval_review_node_ids: [],
		});
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
		const directory = await prepareRunDirectory(root, fixture.runId);
		let reviews = 0;
		let preserved = false;
		const worker: NodeWorker = {
			async runExecution(work) {
				const node = work.node.definition;
				if (node.kind !== "execution") throw new Error("Expected execution");
				const preserve =
					node.node_id === "produce" && work.findings?.length
						? work.preservableOutputs?.find((item) => item.outputId === "side-output")
						: undefined;
				const outputs = [];
				for (const output of node.outputs) {
					if (output.output_id === preserve?.outputId) {
						preserved = true;
						await rm(join(directory.workspace, output.path_prefix), { recursive: true, force: true });
						continue;
					}
					await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
					const path = `${output.path_prefix}/result.txt`;
					await writeFile(join(directory.workspace, path), `${node.node_id}:${work.roundId}`);
					outputs.push({ output_id: output.output_id, files: [{ path, media_type: "text/plain" }] });
				}
				return {
					summary: "Candidate",
					outputs,
					preserved_outputs: preserve
						? [
								{
									output_id: preserve.outputId,
									submission_id: preserve.submissionId,
									revision_id: preserve.revisionId,
								},
							]
						: [],
					resolution_claims: (work.findings ?? []).map((finding) => ({
						finding_id: finding.findingId,
						output_id: finding.owner.output_id,
						explanation: "Repaired main output",
						evidence: ["outputs/produce/result.txt"],
					})),
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				const report = passReport(work);
				if (++reviews === 1) {
					report.decision = "REWORK";
					report.criteria[0].result = "FAIL";
					report.criteria[0].required_rework = ["Repair A"];
					report.criteria[0].rework_targets = [{ node_id: "produce", output_id: "content-output" }];
				}
				return report;
			},
		};
		const store = new FileRunStore();
		store.bind(fixture.runId, directory.stateFile);
		const runtime = new WorkflowRuntime(
			store,
			directory,
			worker,
			new SubmissionStore(),
			new MechanicalChecker(fixture.assets.checks),
		);
		await runtime.activate(compiled.baseline, fixture.taskInput);
		const state = await runtime.run();
		expect(state.status, JSON.stringify(state.failure)).toBe("succeeded");
		expect(preserved).toBe(true);
		const submissions = state.submissions.filter((item) => item.nodeId === "produce");
		const original = submissions[0].outputs.find((item) => item.outputId === "side-output")!;
		const retained = submissions[1].outputs.find((item) => item.outputId === "side-output")!;
		expect(retained.revisionId).toBe(original.revisionId);
		expect(retained.manifest).toEqual(original.manifest);
		expect(state.governance.artifacts.filter((item) => item.outputId === "side-output")).toHaveLength(1);
	});

	it.each(["REWORK", "BLOCKED"] as const)(
		"repairs known failures after %s while retaining independent D and complete Finding history",
		async (firstDecision) => {
			const root = await mkdtemp(join(tmpdir(), "ipd-p1-stage-"));
			roots.push(root);
			const fixture = stageFixture();
			const compiled = compileWorkflow(fixture);
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
			const directory = await prepareRunDirectory(root, fixture.runId);
			const counts = new Map<string, number>();
			let reviews = 0;
			const worker: NodeWorker = {
				async runExecution(work) {
					const node = work.node.definition;
					if (node.kind !== "execution") throw new Error("Execution expected");
					counts.set(node.node_id, (counts.get(node.node_id) ?? 0) + 1);
					const output = node.outputs[0];
					const path = `${output.path_prefix}/result.txt`;
					await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
					await writeFile(join(directory.workspace, path), `${node.node_id}-${counts.get(node.node_id)}`);
					return {
						summary: "Result with traceable evidence",
						outputs: [{ output_id: output.output_id, files: [{ path, media_type: "text/plain" }] }],
						evidence: [],
						metadata: {},
						resolution_claims: (work.findings ?? [])
							.filter((finding) => finding.owner.node_id === node.node_id)
							.map((finding) => ({
								finding_id: finding.findingId,
								output_id: output.output_id,
								explanation: "Fixed data error",
								evidence: [path],
							})),
					};
				},
				async runReview(work) {
					reviews++;
					expect(work.reviewBundle?.requiredRelations).toHaveLength(1);
					const report = passReport(work);
					if (reviews === 1) {
						report.decision = firstDecision;
						const criterion = report.criteria.find((item) => item.criterion_id === "quality")!;
						criterion.result = "FAIL";
						criterion.rationale = "A contains duplicate data";
						criterion.required_rework = ["Deduplicate the data"];
						criterion.rework_targets = [{ node_id: "produce", output_id: "content-output" }];
						if (firstDecision === "BLOCKED") {
							report.criteria.find((item) => item.criterion_id === "independent-quality")!.result = "BLOCKED";
							report.unresolved_issues = ["Independent verification unavailable until the next observation"];
						}
					}
					return report;
				},
			};
			const store = new FileRunStore();
			store.bind(fixture.runId, directory.stateFile);
			const runtime = new WorkflowRuntime(
				store,
				directory,
				worker,
				new SubmissionStore(),
				new MechanicalChecker(fixture.assets.checks),
			);
			await runtime.activate(compiled.baseline, fixture.taskInput);
			const state = await runtime.run();
			expect(state.status, JSON.stringify(state.failure)).toBe("succeeded");
			expect(Object.fromEntries(counts)).toEqual({ produce: 2, independent: 1, analysis: 2 });
			expect(reviews).toBe(2);
			expect(state.reviews[0].decision).toBe(firstDecision);
			expect(state.governance.findings).toHaveLength(1);
			expect(state.governance.findings[0]).toMatchObject({ status: "resolved", owner: { node_id: "produce" } });
			expect(state.governance.reviewBundles).toHaveLength(2);
			expect(
				state.governance.reviewBundles[0].targets.find((item) => item.nodeId === "independent")?.revisionId,
			).toBe(state.governance.reviewBundles[1].targets.find((item) => item.nodeId === "independent")?.revisionId);
			expect(state.governance.releases.filter((item) => item.status === "active")).toHaveLength(1);
			expect(await readFile(join(state.finalSubmission!.directory, "result.txt"), "utf8")).toBe("analysis-2");
			const bundle = state.governance.reviewBundles.at(-1)!;
			const assessments = state.governance.assessments.filter((item) => item.bundleId === bundle.bundleId);
			const expertBundle = structuredClone(bundle);
			expertBundle.criteria
				.find((item) => item.criterionId === assessments[0].criterionId)!
				.requiredParticipantIds.push("second-expert");
			expect(
				aggregateAssessments(expertBundle, [
					...assessments,
					{ ...assessments[0], assessmentId: "contrary-opinion", participantId: "second-expert", result: "FAIL" },
				]),
			).toBe("REWORK");
			const invalidated = structuredClone(state);
			const rootRevision = bundle.targets.find((item) => item.nodeId === "produce")!.revisionId;
			const impact = invalidateOutputRevisions(invalidated, [rootRevision]);
			expect(impact.revisionIds).toHaveLength(2);
			expect(invalidated.governance.artifacts.find((item) => item.nodeId === "independent")?.status).toBe("current");
			expect(invalidated.governance.releases.every((item) => item.status === "revoked")).toBe(true);
		},
	);
});
