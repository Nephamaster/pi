import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PiNodeWorker } from "../src/adapter/pi-node-worker.ts";
import {
	claimRunController,
	compileWorkflow,
	FileRunStore,
	FileWorkflowAssetStore,
	hashJson,
	IpdControlPlane,
	IpdService,
	MechanicalChecker,
	type NodeRoundWork,
	type NodeWorker,
	NodeWorkerError,
	prepareRunDirectory,
	type RunDirectory,
	SubmissionStore,
	WorkflowRuntime,
	type WorkProgressReference,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

function deferred<T>() {
	let resolve: (value: T) => void = () => {};
	const promise = new Promise<T>((ok) => {
		resolve = ok;
	});
	return { promise, resolve };
}

async function candidate(directory: RunDirectory) {
	await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
	await writeFile(join(directory.workspace, "outputs/produce/result.txt"), "retained result");
	return {
		summary: "done",
		outputs: [
			{ output_id: "content-output", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
		],
		evidence: [],
		metadata: {},
	};
}

const review: NodeWorker["runReview"] = async (work) => ({
	decision: "PASS",
	criteria: [
		{
			criterion_id: "quality",
			result: "PASS",
			evidence: [
				{
					description: "Checked exact candidate",
					reference: "result.txt",
					submission_id: work.inputSubmissions[0].submissionId,
					node_id: "produce",
					output_id: "content-output",
					criterion_id: "quality",
				},
			],
			rationale: "Accepted",
			required_rework: [],
			rework_targets: [],
		},
	],
	unresolved_issues: [],
});

describe("managed Run lifecycle", () => {
	const roots: string[] = [];
	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});
	async function fixture(
		factory: (directory: RunDirectory) => NodeWorker,
		options = {},
		beforeCheck?: () => Promise<void>,
	) {
		const root = await mkdtemp(join(tmpdir(), "ipd-lifecycle-"));
		roots.push(root);
		const input = createCompilerFixture();
		const compiled = compileWorkflow(input);
		if (!compiled.ok) throw new Error("Invalid fixture");
		const directory = await prepareRunDirectory(root, "run-1");
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const worker = factory(directory);
		const mechanical = new MechanicalChecker(input.assets.checks);
		const evaluate = mechanical.evaluate.bind(mechanical);
		if (beforeCheck)
			mechanical.evaluate = async (...args) => {
				await beforeCheck();
				return evaluate(...args);
			};
		const runtime = new WorkflowRuntime(store, directory, worker, new SubmissionStore(), mechanical, {
			stopTimeoutMs: 30,
			...options,
		});
		await runtime.activate(compiled.baseline, input.taskInput);
		return { root, directory, store, worker, runtime, input, baseline: compiled.baseline };
	}

	it("resumes interrupted work in the same business round without spending a quality rework budget", async () => {
		const attempts: NodeRoundWork[] = [];
		let retained: WorkProgressReference[] = [];
		const f = await fixture(
			(directory) => ({
				async runExecution(work) {
					attempts.push(work);
					if (attempts.length === 1) {
						await writeFile(join(directory.workspace, "wip.txt"), "saved");
						throw new NodeWorkerError("transient", "model retries exhausted");
					}
					expect(await readFile(join(directory.workspace, "wip.txt"), "utf8")).toBe("saved");
					return candidate(directory);
				},
				runReview: review,
				async pauseRun() {
					retained = [
						{
							nodeId: "produce",
							participantId: "producer",
							sessionId: "original",
							entryId: "entry",
							workspace: directory.workspace,
						},
					];
					return retained;
				},
				async validateResume(state) {
					expect(state.workProgress).toEqual(retained);
				},
			}),
			{ maxQualityReworkRounds: 0 },
		);
		const paused = await f.runtime.run();
		expect(paused.status).toBe("paused");
		expect(paused.submissions).toEqual([]);
		await f.runtime.resume();
		const done = await f.runtime.run();
		expect(done.status).toBe("succeeded");
		expect(attempts.map((work) => work.roundId)).toEqual(["produce:round:1", "produce:round:1"]);
		expect(attempts.map((work) => work.generation)).toEqual([0, 2]);
		expect(attempts[1].resuming).toBe(true);
		expect(done.rounds.find((round) => round.nodeId === "produce")).toMatchObject({
			index: 1,
			attempt: 2,
			generation: 2,
		});
	});

	it.each([undefined, 0])(
		"does not impose a whole-round deadline when roundTimeoutMs is %s",
		async (roundTimeoutMs) => {
			const started = deferred<void>();
			const gate = deferred<void>();
			const f = await fixture(
				(directory) => ({
					async runExecution() {
						started.resolve();
						await gate.promise;
						return candidate(directory);
					},
					runReview: review,
				}),
				{ roundTimeoutMs },
			);
			vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
			const running = f.runtime.run();
			try {
				await started.promise;
				expect(vi.getTimerCount()).toBe(0);
				await vi.advanceTimersByTimeAsync(2 * 60 * 60 * 1000);
				expect((await f.store.read("run-1")).status).toBe("running");
			} finally {
				vi.useRealTimers();
				gate.resolve();
			}
			expect((await running).status).toBe("succeeded");
			await f.runtime.release();
		},
	);

	it("allows a checkpoint reminder without imposing a hard deadline", async () => {
		const gate = deferred<void>();
		const f = await fixture(
			(directory) => ({
				async runExecution() {
					await gate.promise;
					return candidate(directory);
				},
				runReview: review,
				async requestCheckpoint() {
					gate.resolve();
				},
			}),
			{ softRoundTimeoutMs: 10 },
		);
		expect((await f.runtime.run()).status).toBe("succeeded");
		await f.runtime.release();
	});

	it.each(["prepare", "model", "export", "mechanical", "review"] as const)(
		"revokes late work during %s and does not wait forever for uncooperative code",
		async (stage) => {
			const started = deferred<void>();
			const gate = deferred<void>();
			const f = await fixture(
				(directory) => ({
					async prepareRound() {
						if (stage === "prepare") {
							started.resolve();
							await gate.promise;
						}
					},
					async runExecution() {
						if (stage === "model") {
							started.resolve();
							await gate.promise;
						}
						return candidate(directory);
					},
					async exportSubmission() {
						if (stage === "export") {
							started.resolve();
							await gate.promise;
						}
						return undefined;
					},
					async runReview(work) {
						if (stage === "review") {
							started.resolve();
							await gate.promise;
						}
						return review(work);
					},
					async pauseRun() {
						return [];
					},
				}),
				{},
				stage === "mechanical"
					? async () => {
							started.resolve();
							await gate.promise;
						}
					: undefined,
			);
			const running = f.runtime.run();
			await started.promise;
			const before = Date.now();
			const paused = await f.runtime.pause("test pause");
			expect(Date.now() - before).toBeLessThan(1000);
			expect(paused.status).toBe("paused");
			expect(paused.cleanup?.status).toBe("failed");
			await expect(f.runtime.resume()).rejects.toThrow("not settled");
			gate.resolve();
			await running;
			await expect.poll(async () => (await f.store.read("run-1")).cleanup?.status).toBe("complete");
			const state = await f.store.read("run-1");
			expect(state.approvals).toEqual([]);
			expect(state.submissions).toHaveLength(stage === "review" ? 1 : 0);
			expect(await readdir(f.directory.submissions)).toHaveLength(stage === "review" ? 1 : 0);
			await f.runtime.cancel();
		},
	);

	it("includes environment preparation in the hard deadline and refuses resume until cleanup settles", async () => {
		const gate = deferred<void>();
		let prompted = false;
		const f = await fixture(
			() => ({
				prepareRound: () => gate.promise,
				async runExecution() {
					prompted = true;
					throw new Error("must not prompt");
				},
				runReview: review,
				async pauseRun() {
					return [];
				},
			}),
			{ roundTimeoutMs: 10 },
		);
		const state = await f.runtime.run();
		expect(state.status).toBe("paused");
		expect(state.failure?.code).toBe("timeout");
		expect(prompted).toBe(false);
		gate.resolve();
		await expect.poll(async () => (await f.store.read("run-1")).cleanup?.status).toBe("complete");
		await f.runtime.cancel();
	});

	it("refuses to continue a paused review after its exact input loses validity", async () => {
		const started = deferred<void>();
		const gate = deferred<void>();
		const f = await fixture((directory) => ({
			runExecution: () => candidate(directory),
			async runReview(work) {
				started.resolve();
				await gate.promise;
				return review(work);
			},
			async pauseRun() {
				gate.resolve();
				return [];
			},
		}));
		const running = f.runtime.run();
		await started.promise;
		await f.runtime.pause();
		await running;
		await f.store.mutate("run-1", "invalidate-input", {}, (state) => {
			state.submissions[0].status = "stale";
			return true;
		});
		await expect(f.runtime.resume()).rejects.toThrow("Inputs or approvals changed");
		expect((await f.store.read("run-1")).approvals).toEqual([]);
		await f.runtime.cancel();
	});

	it("requests a saved-work checkpoint through the worker before the hard deadline", async () => {
		const gate = deferred<void>();
		const checkpoints: string[] = [];
		const f = await fixture(
			(directory) => ({
				async runExecution() {
					await gate.promise;
					return candidate(directory);
				},
				runReview: review,
				async requestCheckpoint(work) {
					checkpoints.push(work.roundId);
					gate.resolve();
				},
			}),
			{ softRoundTimeoutMs: 10, roundTimeoutMs: 1000 },
		);
		expect((await f.runtime.run()).status).toBe("succeeded");
		expect(checkpoints.filter((id) => id === "produce:round:1")).toHaveLength(1);
		expect(new Set(checkpoints).size).toBe(checkpoints.length);
	});

	it("refuses changed Baselines, task input and lost original session references", async () => {
		const f = await fixture(() => ({
			async runExecution() {
				throw new NodeWorkerError("transient", "interrupted");
			},
			runReview: review,
			async pauseRun() {
				return [];
			},
			async validateResume() {
				throw new NodeWorkerError("session_lost", "original session lost");
			},
		}));
		await f.runtime.run();
		await expect(f.runtime.resume()).rejects.toThrow("original session lost");
		await f.store.mutate("run-1", "tamper-task", {}, (draft) => {
			draft.taskInput!.raw_task.text = "changed";
			return true;
		});
		await expect(f.runtime.resume()).rejects.toThrow("task input changed");
		await f.store.mutate("run-1", "tamper", {}, (draft) => {
			draft.baseline!.workflow.name = "changed";
			return true;
		});
		await expect(f.runtime.resume()).rejects.toThrow("Baseline changed");
	});

	it("continues the real Pi Session and stored history after a business block", async () => {
		const faux = registerFauxProvider();
		let native: PiNodeWorker | undefined;
		try {
			const model = faux.getModel();
			const root = await mkdtemp(join(tmpdir(), "ipd-native-resume-"));
			roots.push(root);
			const modelRuntime = await ModelRuntime.create({
				authPath: join(root, "auth.json"),
				modelsPath: null,
				refreshOnCreate: false,
			});
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			const f = await fixture((directory) => {
				native = new PiNodeWorker({
					agentDir: root,
					workspace: directory.workspace,
					sessionDirectory: directory.sessions,
					modelRuntime,
					model,
					thinkingLevel: "off",
				});
				return {
					runExecution: native.runExecution.bind(native),
					runReview: review,
					pauseRun: native.pauseRun.bind(native),
					validateResume: native.validateResume.bind(native),
					releaseRun: native.releaseRun.bind(native),
				};
			});
			const submitted = await candidate(f.directory);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("report_node_blocked", {
						reason: "Access unavailable",
						missing_conditions: ["Access"],
						attempted_actions: [],
						evidence: [],
						needed_to_resume: ["Restore access"],
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("report_node_blocked");
					expect(JSON.stringify(context.messages)).toContain("Continue IPD work round produce:round:1");
					return fauxAssistantMessage(fauxToolCall("submit_artifact", submitted), { stopReason: "toolUse" });
				},
			]);
			const blocked = await f.runtime.run();
			const original = blocked.workProgress?.[0];
			expect(original?.sessionFile).toBeDefined();
			expect(original?.entryId).toBeDefined();
			await f.runtime.resume();
			expect((await f.runtime.run()).status).toBe("succeeded");
			const current = await native!.pauseRun("run-1");
			expect(current[0].sessionId).toBe(original?.sessionId);
			expect(current[0].sessionFile).toBe(original?.sessionFile);
			expect(current[0].entryId).not.toBe(original?.entryId);
			expect(faux.state.callCount).toBe(2);
			await f.runtime.release();
		} finally {
			await native?.releaseRun("run-1");
			faux.unregister();
		}
	});

	it("reopens the same logical Pi Session after the Runtime process is replaced", async () => {
		const faux = registerFauxProvider();
		let originalWorker: PiNodeWorker | undefined;
		let recoveredWorker: PiNodeWorker | undefined;
		try {
			const model = faux.getModel();
			const root = await mkdtemp(join(tmpdir(), "ipd-native-process-recovery-"));
			roots.push(root);
			const modelRuntime = await ModelRuntime.create({ modelsPath: null, refreshOnCreate: false });
			modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
			await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
			const f = await fixture((directory) => {
				originalWorker = new PiNodeWorker({
					agentDir: root,
					workspace: directory.workspace,
					sessionDirectory: directory.sessions,
					modelRuntime,
					model,
					thinkingLevel: "off",
				});
				return {
					runExecution: originalWorker.runExecution.bind(originalWorker),
					runReview: review,
					pauseRun: originalWorker.pauseRun.bind(originalWorker),
					validateResume: originalWorker.validateResume.bind(originalWorker),
					releaseRun: originalWorker.releaseRun.bind(originalWorker),
				};
			});
			const submitted = await candidate(f.directory);
			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("report_node_blocked", {
						reason: "Access unavailable",
						missing_conditions: ["Access"],
						attempted_actions: [],
						evidence: [],
						needed_to_resume: ["Restore access"],
					}),
					{ stopReason: "toolUse" },
				),
				(context) => {
					expect(JSON.stringify(context.messages)).toContain("report_node_blocked");
					expect(JSON.stringify(context.messages)).toContain("Continue IPD work round produce:round:1");
					return fauxAssistantMessage(fauxToolCall("submit_artifact", submitted), { stopReason: "toolUse" });
				},
			]);

			const blocked = await f.runtime.run();
			const original = blocked.workProgress?.find((item) => item.nodeId === "produce");
			if (!original?.sessionId || !original.sessionFile)
				throw new Error("Original logical Session checkpoint is missing");
			await originalWorker!.releaseRun("run-1");
			const controller = await f.store.mutate("run-1", "test-controller-takeover", {}, (draft) => {
				const claimed = claimRunController(draft, "recovered-controller", { allowTakeover: true });
				return { controllerId: claimed.controllerId, term: claimed.term };
			});
			recoveredWorker = new PiNodeWorker({
				agentDir: root,
				workspace: f.directory.workspace,
				sessionDirectory: f.directory.sessions,
				modelRuntime,
				model,
				thinkingLevel: "off",
			});
			const worker: NodeWorker = {
				runExecution: recoveredWorker.runExecution.bind(recoveredWorker),
				runReview: review,
				pauseRun: recoveredWorker.pauseRun.bind(recoveredWorker),
				validateResume: recoveredWorker.validateResume.bind(recoveredWorker),
				releaseRun: recoveredWorker.releaseRun.bind(recoveredWorker),
			};
			const recovered = new WorkflowRuntime(
				f.store,
				f.directory,
				worker,
				new SubmissionStore(),
				new MechanicalChecker(f.input.assets.checks),
				{ controller },
			);
			await recovered.recover();
			await recovered.resume();
			expect((await recovered.run()).status).toBe("succeeded");
			const current = await recoveredWorker.pauseRun("run-1");
			expect(current.find((item) => item.nodeId === "produce")).toMatchObject({
				sessionId: original.sessionId,
				sessionFile: original.sessionFile,
			});
			expect(faux.state.callCount).toBe(2);
			await recovered.release();
		} finally {
			await originalWorker?.releaseRun("run-1");
			await recoveredWorker?.releaseRun("run-1");
			faux.unregister();
		}
	});

	it.each(["resume", "cancel"] as const)(
		"keeps blocked resources managed and retries failed terminal cleanup (%s)",
		async (action) => {
			let executions = 0;
			let releases = 0;
			let runtimeCreations = 0;
			const f = await fixture((directory) => ({
				async runExecution() {
					if (++executions === 1)
						return {
							kind: "blocked",
							report: {
								reason: "External access",
								missing_conditions: ["Access"],
								attempted_actions: [],
								evidence: [],
								needed_to_resume: ["Restore access"],
							},
						};
					return candidate(directory);
				},
				runReview: review,
				async pauseRun() {
					return [];
				},
				async releaseRun() {
					if (++releases === 1) throw new Error("temporary cleanup failure");
				},
			}));
			// A fresh service Run uses real template preparation and the same worker instance throughout.
			const assets = new FileWorkflowAssetStore({ directory: join(f.root, "assets") });
			await assets.save(f.input.workflow, hashJson(f.input.workflow));
			const service = new IpdService({
				projectRoot: f.root,
				store: f.store,
				assets: {
					...f.input.assets,
					skills: [
						{
							id: "task",
							hash: "a".repeat(64),
							source: "test",
							filePath: "/test/SKILL.md",
							baseDir: "/test",
							description: "test",
							allowedTools: [],
						},
					],
				},
				processSpecs: [f.input.processSpec],
				workflowAssets: assets,
				idFactory: () => "service-run",
				cleanupTimeoutMs: 200,
				createControlPlane: () =>
					new IpdControlPlane(
						f.store,
						{
							async select() {
								throw new Error("not used");
							},
						},
						{
							async design() {
								throw new Error("not used");
							},
						},
						assets,
					),
				createRuntime: (directory) => {
					runtimeCreations++;
					return new WorkflowRuntime(
						f.store,
						directory,
						{
							...f.worker,
							async runExecution(work) {
								const result = await f.worker.runExecution(work);
								if (!("report" in result)) await candidate(directory);
								return result;
							},
						},
						new SubmissionStore(),
						new MechanicalChecker(f.input.assets.checks),
						{ stopTimeoutMs: 100 },
					);
				},
			});
			await service.createRunFromTemplates("request", f.input.taskInput, "task", {
				processSpecId: f.input.processSpec.process_spec_id,
				processSpecVersion: f.input.processSpec.version,
				workflowId: f.input.workflow.workflow_id,
				workflowVersion: f.input.workflow.workflow_version,
			});
			await expect.poll(async () => (await service.getRun("service-run")).cleanup?.status).toBe("complete");
			expect((await service.getRun("service-run")).status).toBe("blocked");
			if (action === "resume") await service.resumeRun("service-run");
			else await service.cancelRun("service-run");
			await expect.poll(async () => (await service.getRun("service-run")).cleanup?.status).toBe("failed");
			expect((await service.getRun("service-run")).status).toBe(action === "resume" ? "succeeded" : "cancelled");
			await service.cancelRun("service-run");
			expect((await service.getRun("service-run")).cleanup?.status).toBe("complete");
			expect(runtimeCreations).toBe(1);
			expect(releases).toBe(2);
			await service.close();
		},
	);
});
