import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import {
	compileWorkflow,
	FileRunStore,
	MechanicalChecker,
	type NodeRoundWork,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

it.each(["export", "check"] as const)(
	"invalidates an idle-model consumer during %s without pausing the Run",
	async (stage) => {
		const root = await mkdtemp(join(tmpdir(), "ipd-invalidation-"));
		try {
			const fixture = createCompilerFixture();
			fixture.assets.agentCards = fixture.assets.agentCards.map((card) => ({
				...card,
				permissions: {
					...card.permissions,
					readScopes: ["."],
					writeScopes: card.id === "producer" ? ["outputs"] : [],
				},
			}));
			const producer = fixture.workflow.nodes[0];
			const review = fixture.workflow.nodes[1];
			if (producer.kind !== "execution" || review.kind !== "review") throw new Error("Invalid fixture");
			const consumer = structuredClone(producer);
			consumer.node_id = "consumer";
			consumer.agents[0].participant_id = "consumer";
			consumer.agents[0].permissions.write_paths = ["outputs/consumer"];
			consumer.inputs = structuredClone(review.inputs);
			for (const input of consumer.inputs)
				if (input.kind === "node_output") {
					input.availability = "approved";
					input.approval_review_node_ids = ["review-produce"];
				}
			consumer.outputs[0].output_id = "consumer-output";
			consumer.outputs[0].path_prefix = "outputs/consumer";
			consumer.outputs[0].criterion_refs = ["integrity", "consumer-quality"];
			const consumerReview = structuredClone(review);
			consumerReview.node_id = "review-consumer";
			consumerReview.agents[0].participant_id = "consumer-reviewer";
			consumerReview.agents[0].permissions.read_paths = ["outputs/consumer"];
			consumerReview.inputs = [
				{
					kind: "node_output",
					input_id: "candidate",
					source: { node_id: "consumer", output_id: "consumer-output" },
					required: true,
					availability: "submitted",
					approval_review_node_ids: [],
				},
			];
			consumerReview.targets = [
				{ node_id: "consumer", output_id: "consumer-output", criterion_refs: ["consumer-quality"] },
			];
			consumerReview.allowed_rework_node_ids = ["consumer"];
			fixture.workflow.nodes.push(consumer, consumerReview);
			const other = structuredClone(producer);
			other.node_id = "other";
			other.agents[0].participant_id = "other-producer";
			other.agents[0].permissions.write_paths = ["outputs/other"];
			other.outputs[0].output_id = "other-output";
			other.outputs[0].path_prefix = "outputs/other";
			other.outputs[0].criterion_refs = ["integrity", "other-quality", "other-delayed-quality"];
			const otherInput = {
				kind: "node_output" as const,
				input_id: "other",
				source: { node_id: "other", output_id: "other-output" },
				required: true,
				availability: "submitted" as const,
				approval_review_node_ids: [],
			};
			const delayed = structuredClone(review);
			delayed.node_id = "delayed";
			delayed.agents[0].participant_id = "delayed-reviewer";
			delayed.agents[0].permissions.read_paths = ["outputs/other"];
			delayed.inputs = [otherInput];
			delayed.targets = [{ node_id: "other", output_id: "other-output", criterion_refs: ["other-delayed-quality"] }];
			delayed.allowed_rework_node_ids = ["other"];
			review.agents[0].permissions.read_paths.push("outputs/other");
			review.inputs.push(otherInput);
			review.targets.push({ node_id: "other", output_id: "other-output", criterion_refs: ["other-quality"] });
			review.allowed_rework_node_ids.push("other");
			fixture.workflow.nodes.push(other, delayed);
			for (const id of ["other-quality", "other-delayed-quality"])
				fixture.workflow.criteria.push({
					kind: "semantic",
					criterion_id: id,
					description: id,
					evidence_requirements: ["result"],
					process_criterion_refs: [],
				});
			fixture.workflow.criteria.push({
				kind: "semantic",
				criterion_id: "consumer-quality",
				description: "Consumer quality",
				evidence_requirements: ["result"],
				process_criterion_refs: [],
			});
			fixture.workflow.completion.required_node_ids.push("consumer", "review-consumer", "other", "delayed");
			const compiled = compileWorkflow(fixture);
			if (!compiled.ok) throw new Error(JSON.stringify(compiled.report.diagnostics));
			const directory = await prepareRunDirectory(root, "run-1");
			const store = new FileRunStore();
			store.bind("run-1", directory.stateFile);
			let entered: () => void = () => {};
			const barrier = new Promise<void>((resolve) => {
				entered = resolve;
			});
			let cancelled = false;
			let consumerWork: NodeRoundWork | undefined;
			const stopped: string[] = [];
			const hold = async (signal?: AbortSignal) => {
				entered();
				await new Promise<void>((resolve) => {
					const abort = () => {
						cancelled = true;
						resolve();
					};
					if (signal?.aborted) abort();
					else signal?.addEventListener("abort", abort, { once: true });
				});
			};
			const worker: NodeWorker = {
				async runExecution(work) {
					if (work.node.definition.kind !== "execution") throw new Error("Expected execution");
					if (work.node.definition.node_id === "consumer") consumerWork = work;
					const output = work.node.definition.outputs[0];
					await mkdir(join(directory.workspace, output.path_prefix), { recursive: true });
					await writeFile(join(directory.workspace, output.path_prefix, "result.txt"), "result");
					return {
						summary: "done",
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
				async exportSubmission(work) {
					if (stage === "export" && work.roundId === "consumer:round:1") await hold(work.signal);
					return undefined;
				},
				async stopRound(_run, node) {
					stopped.push(node);
				},
				async runReview(work) {
					const rework = work.roundId === "delayed:round:1";
					if (rework) await barrier;
					if (work.node.definition.kind !== "review") throw new Error("Expected review");
					return {
						decision: rework ? "REWORK" : "PASS",
						criteria: work.node.definition.targets.flatMap((target) =>
							target.criterion_refs.map((criterion) => {
								const input = work.inputSubmissions.find((submission) => submission.nodeId === target.node_id)!;
								return {
									criterion_id: criterion,
									result: rework ? ("FAIL" as const) : ("PASS" as const),
									evidence: [
										{
											description: "Checked exact input",
											reference: "result.txt",
											submission_id: input.submissionId,
											node_id: input.nodeId,
											output_id: target.output_id,
											criterion_id: criterion,
										},
									],
									rationale: "checked",
									required_rework: rework ? ["revise"] : [],
									rework_targets: rework ? [{ node_id: "other", output_id: "other-output" }] : [],
								};
							}),
						),
						unresolved_issues: [],
					};
				},
			};
			const mechanical = new MechanicalChecker(fixture.assets.checks);
			const evaluate = mechanical.evaluate.bind(mechanical);
			mechanical.evaluate = async (...args) => {
				if (
					stage === "check" &&
					args[1].contract.id === "consumer-output" &&
					consumerWork?.roundId === "consumer:round:1"
				)
					await hold(args[2]);
				return evaluate(...args);
			};
			const runtime = new WorkflowRuntime(store, directory, worker, new SubmissionStore(), mechanical, {
				stopTimeoutMs: 1000,
				roundTimeoutMs: 5000,
			});
			await runtime.activate(compiled.baseline, fixture.taskInput);
			const result = await runtime.run();
			expect(result.status).toBe("succeeded");
			expect(cancelled).toBe(true);
			expect(stopped).toEqual(["consumer"]);
			expect(result.events.some((event) => event.type === "run_paused")).toBe(false);
			expect(result.submissions.filter((submission) => submission.nodeId === "consumer")).toHaveLength(1);
			await runtime.release();
		} finally {
			await rm(root, { recursive: true, force: true });
		}
	},
);
