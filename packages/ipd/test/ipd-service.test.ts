import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	BootstrapProcessSelector,
	BootstrapWorkflowDesigner,
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	createRunId,
	FileRunStore,
	FileWorkflowAssetStore,
	hashJson,
	IpdControlPlane,
	IpdService,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	type RunState,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture, createEmptyRuntimeRecords } from "./fixtures.ts";

describe("IpdService", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("uses only the UTC creation time in default Run IDs", () => {
		expect(createRunId(Date.parse("2026-09-08T12:34:56.789Z"))).toBe("20260908T123456789Z");
	});

	it("clears the external-operation recovery barrier only after verified reconciliation", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-external-reconcile-"));
		roots.push(root);
		const directory = await prepareRunDirectory(root, "run-reconcile");
		const store = new FileRunStore();
		store.bind("run-reconcile", directory.stateFile);
		const state = {
			...createEmptyRuntimeRecords(),
			runId: "run-reconcile",
			revision: 0,
			phase: "execute",
			status: "blocked",
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			externalOperations: [
				{
					operationId: "operation-1",
					nodeId: "produce",
					participantId: "producer",
					attemptId: "attempt-1",
					intentRef: "environment:bash",
					requestHash: "request-hash",
					authorizationRef: "environment:binding:policy",
					targetRef: "network:example.com",
					outcome: "unknown",
					createdAt: 1,
					updatedAt: 2,
				},
			],
			waits: [
				{
					waitId: "wait-1",
					nodeId: "produce",
					participantId: "producer",
					kind: "external_operation",
					reason: "remote outcome unknown",
					missingConditions: ["reconcile"],
					wakeEvents: ["external_operation_reconciled"],
					state: "waiting",
					createdAt: 2,
				},
			],
			cleanup: { status: "complete" },
			failure: { code: "external_outcome_unknown", message: "remote outcome unknown" },
			events: [],
			operations: {},
		} satisfies RunState;
		await store.create(state);
		const service = new IpdService({
			store,
			createControlPlane: () => {
				throw new Error("not used");
			},
			processSpecs: [],
			assets: createCompilerFixture().assets,
			projectRoot: root,
			createRuntime: () => {
				throw new Error("not used");
			},
		});

		const reconciled = await service.reconcileExternalOperation(
			"run-reconcile",
			"operation-1",
			"succeeded",
			"receipt-1",
		);
		expect(reconciled.externalOperations[0]).toMatchObject({ outcome: "succeeded", receiptRef: "receipt-1" });
		expect(reconciled.waits[0]).toMatchObject({ state: "satisfied", resolvedAt: expect.any(Number) });
		expect(reconciled.failure).toBeUndefined();
	});

	it("records unexpected preparation exceptions as blocked preparation failures", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-preparation-failure-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const control = new IpdControlPlane(
			store,
			{
				async select() {
					throw new Error("selector exploded");
				},
			},
			{
				async design() {
					throw new Error("designer should not run");
				},
			},
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const service = new IpdService({
			store,
			createControlPlane: () => control,
			processSpecs: [fixture.processSpec],
			assets: {
				...fixture.assets,
				skills: [
					{
						id: "test-skill",
						hash: "a".repeat(64),
						source: "test",
						filePath: "/test/SKILL.md",
						baseDir: "/test",
						description: "Test Skill",
						allowedTools: [],
					},
				],
			},
			projectRoot: root,
			idFactory: () => "run-preparation-failure",
			createRuntime: () => {
				throw new Error("runtime should not start");
			},
		});

		await service.createRun("request-preparation-failure", fixture.taskInput, "test-skill");
		for (let count = 0; count < 50 && (await service.getRun("run-preparation-failure")).status === "running"; count++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		const state = await service.getRun("run-preparation-failure");
		expect(state.status).toBe("blocked");
		expect(state.phase).toBe("selection");
		expect(state.failure).toMatchObject({ code: "preparation_failure", message: "selector exploded" });
		expect(state.events.some((event) => event.type === "preparation_failed")).toBe(true);
		expect(state.events.some((event) => event.type === "runtime_failed")).toBe(false);
	});

	it.each([false, true])(
		"cancels during preparation with bounded cleanup (uncooperative=%s)",
		async (uncooperative) => {
			const root = await mkdtemp(join(tmpdir(), "pi-ipd-preparation-cancel-"));
			roots.push(root);
			const fixture = createCompilerFixture();
			const store = new FileRunStore();
			let finishSelection: (() => void) | undefined;
			const selection = new Promise<typeof fixture.processSelection>((resolve) => {
				finishSelection = () => resolve(fixture.processSelection);
			});
			const control = new IpdControlPlane(
				store,
				{
					select: async () => selection,
					async cancelRun() {
						if (!uncooperative) finishSelection?.();
					},
				},
				{
					async design() {
						throw new Error("designer should not run");
					},
				},
				new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
			);
			const service = new IpdService({
				store,
				createControlPlane: () => control,
				processSpecs: [fixture.processSpec],
				assets: {
					...fixture.assets,
					skills: [
						{
							id: "test-skill",
							hash: "a".repeat(64),
							source: "test",
							filePath: "/test/SKILL.md",
							baseDir: "/test",
							description: "Test Skill",
							allowedTools: [],
						},
					],
				},
				projectRoot: root,
				idFactory: () => "run-cancelled",
				cleanupTimeoutMs: 30,
				createRuntime: () => {
					throw new Error("runtime should not start");
				},
			});
			await service.createRun("request-cancelled", fixture.taskInput, "test-skill");
			const cancelled = await service.cancelRun("run-cancelled", "Stopped by test");
			expect(cancelled.status).toBe("cancelled");
			expect(cancelled.phase).toBe("closed");
			expect(cancelled.events.filter((event) => event.type === "run_cancelled")).toHaveLength(1);
			expect(cancelled.events.some((event) => event.type === "preparation_failed")).toBe(false);
			if (uncooperative) {
				expect(cancelled.cleanup?.status).toBe("failed");
				finishSelection?.();
				await expect.poll(async () => (await service.getRun("run-cancelled")).cleanup?.status).toBe("complete");
			}
		},
	);

	it("resolves selected templates and starts Runtime without Selector or Designer Agents", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-template-service-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const workflowAssets = new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") });
		await workflowAssets.save(fixture.workflow, hashJson(fixture.workflow));
		const control = new IpdControlPlane(
			store,
			{
				async select() {
					throw new Error("Process Selector must not run");
				},
			},
			{
				async design() {
					throw new Error("Workflow Designer must not run");
				},
			},
			workflowAssets,
		);
		const activate = vi.fn().mockResolvedValue(undefined);
		const run = vi.fn().mockResolvedValue(undefined);
		const service = new IpdService({
			store,
			createControlPlane: () => control,
			processSpecs: [fixture.processSpec],
			workflowAssets,
			assets: {
				...fixture.assets,
				skills: [
					{
						id: "test-skill",
						hash: "a".repeat(64),
						source: "test",
						filePath: "/test/SKILL.md",
						baseDir: "/test",
						description: "Test Skill",
						allowedTools: [],
					},
				],
			},
			projectRoot: root,
			idFactory: () => "run-template",
			createRuntime: () => ({ activate, run }) as unknown as WorkflowRuntime,
		});

		expect(service.listProcessSpecTemplates().map((spec) => spec.process_spec_id)).toEqual(["delivery-process"]);
		expect(await service.listWorkflowTemplates("delivery-process", "1.0.0")).toHaveLength(1);
		await service.createRunFromTemplates("request-template", fixture.taskInput, "test-skill", {
			processSpecId: "delivery-process",
			processSpecVersion: "1.0.0",
			workflowId: "example-workflow",
			workflowVersion: "1.0.0",
		});
		for (let count = 0; count < 50 && activate.mock.calls.length === 0; count++)
			await new Promise((resolve) => setTimeout(resolve, 10));

		expect(activate).toHaveBeenCalledOnce();
		expect(run).toHaveBeenCalledOnce();
		expect((await service.getRun("run-template")).events.map((event) => event.type)).toContain(
			"workflow_template_selected",
		);
	});

	it("creates once and exposes query-only progress and result APIs", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-service-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const store = new FileRunStore();
		const worker: NodeWorker = {
			async runExecution() {
				const path = join(root, ".pi", "ipd", "runs", "run-1", "workspace", "outputs", "produce");
				await mkdir(path, { recursive: true });
				await writeFile(join(path, "result.txt"), "done");
				return {
					summary: "done",
					outputs: [
						{ output_id: "result", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
					],
					evidence: [],
					metadata: {},
				};
			},
			async runReview(work) {
				const submission = work.inputSubmissions[0];
				const output = submission?.outputs[0];
				if (!submission || !output) throw new Error("Missing review input");
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: [
								{
									description: "Observed sealed output",
									reference: "outputs/produce/result.txt",
									submission_id: submission.submissionId,
									node_id: submission.nodeId,
									output_id: output.outputId,
									criterion_id: "quality",
								},
							],
							rationale: "accepted",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				};
			},
		};
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			new BootstrapWorkflowDesigner({ id: "producer", version: "1.0.0" }, { id: "reviewer", version: "1.0.0" }),
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const service = new IpdService({
			store,
			createControlPlane: () => control,
			processSpecs: [fixture.processSpec],
			assets: {
				...fixture.assets,
				skills: [
					{
						id: "test-skill",
						hash: "a".repeat(64),
						source: "test",
						filePath: "/test/SKILL.md",
						baseDir: "/test",
						description: "Test Skill",
						allowedTools: [],
					},
				],
			},
			projectRoot: root,
			idFactory: () => "run-1",
			createRuntime: (directory) =>
				new WorkflowRuntime(store, directory, worker, new SubmissionStore(), new MechanicalChecker(checks)),
		});
		const receipt = await service.createRun("request-1", fixture.taskInput, "test-skill");
		expect((await service.createRun("request-1", fixture.taskInput, "test-skill")).runId).toBe(receipt.runId);
		for (let count = 0; count < 50 && (await service.getRun("run-1")).status === "running"; count++)
			await new Promise((resolve) => setTimeout(resolve, 10));
		await expect.poll(async () => (await service.getRun("run-1")).cleanup?.status).toBe("complete");
		const before = await service.getRun("run-1");
		const events = await service.readEvents("run-1", 0);
		const result = await service.getResult("run-1");
		const after = await service.getRun("run-1");
		expect(after.revision).toBe(before.revision);
		expect(events.some((event) => event.type === "run_succeeded")).toBe(true);
		expect(result.finalSubmissionIds).toHaveLength(1);
		expect(result.finalSubmission).toMatchObject({
			directory: expect.stringContaining(join(root, ".pi", "ipd", "runs", "run-1", "final_submissions")),
			files: [{ path: "result.txt", nodeId: "produce", outputId: "result" }],
		});

		const reopened = new IpdService({
			store: new FileRunStore(),
			createControlPlane: () => {
				throw new Error("not used");
			},
			processSpecs: [],
			assets: fixture.assets,
			projectRoot: root,
			createRuntime: () => {
				throw new Error("not used");
			},
		});
		const reopenedResult = await reopened.getResult("run-1");
		expect(reopenedResult.state.status).toBe("succeeded");
		expect(reopenedResult.finalSubmission?.files.map((file) => file.path)).toEqual(["result.txt"]);
	});

	it("reuses the durable request receipt after the service instance is replaced", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-service-request-reopen-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const skill = {
			id: "test-skill",
			hash: "a".repeat(64),
			source: "test",
			filePath: "/test/SKILL.md",
			baseDir: "/test",
			description: "Test Skill",
			allowedTools: [],
		};
		const selectionNeverCompletes = new Promise<typeof fixture.processSelection>(() => {});
		const firstStore = new FileRunStore();
		const firstControl = new IpdControlPlane(
			firstStore,
			{ select: async () => selectionNeverCompletes },
			{ design: async () => fixture.workflow },
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const first = new IpdService({
			store: firstStore,
			createControlPlane: () => firstControl,
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			projectRoot: root,
			idFactory: () => "run-durable",
			controllerId: "controller-first",
			createRuntime: () => {
				throw new Error("runtime should not start");
			},
		});
		const initial = await first.createRun("request-durable", fixture.taskInput, skill.id);
		expect(initial.runId).toBe("run-durable");

		const secondControl = vi.fn();
		const second = new IpdService({
			store: new FileRunStore(),
			createControlPlane: () => {
				secondControl();
				throw new Error("an owned request must not start another control plane");
			},
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			projectRoot: root,
			idFactory: () => "run-duplicate",
			controllerId: "controller-second",
			createRuntime: () => {
				throw new Error("runtime should not start");
			},
		});
		const repeated = await second.createRun("request-durable", fixture.taskInput, skill.id);
		expect(repeated.runId).toBe("run-durable");
		expect(secondControl).not.toHaveBeenCalled();

		const changedTask = structuredClone(fixture.taskInput);
		changedTask.raw_task.text = "different request";
		expect(() => second.createRun("request-durable", changedTask, skill.id)).toThrow("request ID conflict");
	});

	it("pauses preparation on shutdown and resumes it under a new controller", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-preparation-recovery-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const skill = {
			id: "test-skill",
			hash: "a".repeat(64),
			source: "test",
			filePath: "/test/SKILL.md",
			baseDir: "/test",
			description: "Test Skill",
			allowedTools: [],
		};
		const firstStore = new FileRunStore();
		const pendingSelection = new Promise<typeof fixture.processSelection>(() => {});
		const firstControl = new IpdControlPlane(
			firstStore,
			{ select: async () => pendingSelection },
			{ design: async () => fixture.workflow },
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const first = new IpdService({
			store: firstStore,
			createControlPlane: () => firstControl,
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			projectRoot: root,
			idFactory: () => "run-preparation-recovery",
			controllerId: "controller-before-restart",
			createRuntime: () => {
				throw new Error("runtime should not start before recovery");
			},
		});
		await first.createRun("request-preparation-recovery", fixture.taskInput, skill.id);
		await first.close();
		const preserved = await first.getRun("run-preparation-recovery");
		expect(preserved).toMatchObject({ status: "paused", cleanup: { status: "complete" } });
		expect(preserved.events.some((event) => event.type === "preparation_paused")).toBe(true);

		const secondStore = new FileRunStore();
		const workflowAssets = new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") });
		const secondControl = new IpdControlPlane(
			secondStore,
			new BootstrapProcessSelector(),
			new BootstrapWorkflowDesigner({ id: "producer", version: "1.0.0" }, { id: "reviewer", version: "1.0.0" }),
			workflowAssets,
		);
		const activate = vi.fn().mockResolvedValue(undefined);
		const run = vi.fn().mockResolvedValue(undefined);
		const second = new IpdService({
			store: secondStore,
			createControlPlane: () => secondControl,
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			workflowAssets,
			projectRoot: root,
			controllerId: "controller-after-restart",
			createRuntime: () => ({ activate, run }) as unknown as WorkflowRuntime,
		});
		await second.resumeRun("run-preparation-recovery");
		await expect.poll(() => activate.mock.calls.length).toBe(1);
		const recovered = await second.getRun("run-preparation-recovery");
		expect(recovered.controller).toMatchObject({ controllerId: "controller-after-restart", term: 2 });
		expect(recovered.events.some((event) => event.type === "preparation_resumed")).toBe(true);
	});

	it("takes over a preparation intent left running by a lost service process", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-preparation-hard-recovery-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const skill = {
			id: "test-skill",
			hash: "a".repeat(64),
			source: "test",
			filePath: "/test/SKILL.md",
			baseDir: "/test",
			description: "Test Skill",
			allowedTools: [],
		};
		const firstStore = new FileRunStore();
		const first = new IpdService({
			store: firstStore,
			createControlPlane: () =>
				new IpdControlPlane(
					firstStore,
					{ select: async () => new Promise<typeof fixture.processSelection>(() => {}) },
					{ design: async () => fixture.workflow },
					new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
				),
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			projectRoot: root,
			idFactory: () => "run-preparation-hard-recovery",
			controllerId: "controller-before-crash",
			createRuntime: () => {
				throw new Error("runtime should not start on the lost service");
			},
		});
		await first.createRun("request-preparation-hard-recovery", fixture.taskInput, skill.id);
		await expect.poll(async () => (await first.getRun("run-preparation-hard-recovery")).phase).toBe("selection");

		const secondStore = new FileRunStore();
		const activate = vi.fn().mockResolvedValue(undefined);
		const run = vi.fn().mockResolvedValue(undefined);
		const second = new IpdService({
			store: secondStore,
			createControlPlane: () =>
				new IpdControlPlane(
					secondStore,
					new BootstrapProcessSelector(),
					new BootstrapWorkflowDesigner(
						{ id: "producer", version: "1.0.0" },
						{ id: "reviewer", version: "1.0.0" },
					),
					new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
				),
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [skill] },
			projectRoot: root,
			controllerId: "controller-after-crash",
			createRuntime: () => ({ activate, run }) as unknown as WorkflowRuntime,
		});
		await second.resumeRun("run-preparation-hard-recovery");
		await expect.poll(() => activate.mock.calls.length).toBe(1);
		const recovered = await second.getRun("run-preparation-hard-recovery");
		expect(recovered.controller).toMatchObject({ controllerId: "controller-after-crash", term: 2 });
		expect(recovered.events.some((event) => event.type === "preparation_controller_recovered")).toBe(true);
	});

	it("recovers a claimed but undelivered dispatch without duplicating the old Attempt", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-pending-dispatch-recovery-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Fixture did not compile");
		const directory = await prepareRunDirectory(root, fixture.runId);
		const store = new FileRunStore();
		store.bind(fixture.runId, directory.stateFile);
		const runSkill = {
			id: "test-skill",
			hash: "a".repeat(64),
			source: "test",
			filePath: "/test/SKILL.md",
			baseDir: "/test",
			description: "Test Skill",
			allowedTools: [],
		};
		let allowExecution!: () => void;
		const executionGate = new Promise<void>((resolve) => {
			allowExecution = resolve;
		});
		let allowCleanup!: () => void;
		const cleanupGate = new Promise<void>((resolve) => {
			allowCleanup = resolve;
		});
		const releaseRun = vi.fn(async () => {
			await cleanupGate;
		});
		const oldAttemptId = "produce:round:1:attempt:1:term:1:scope:1";
		const oldCommandId = `${oldAttemptId}:dispatch`;
		await store.create({
			...createEmptyRuntimeRecords(),
			runId: fixture.runId,
			revision: 0,
			phase: "execute",
			status: "running",
			controller: {
				controllerId: "old-controller",
				term: 1,
				status: "active",
				acquiredAt: 1,
			},
			taskInput: fixture.taskInput,
			runSkill,
			baseline: compiled.baseline,
			nodes: compiled.baseline.nodes.map((node) => ({
				nodeId: node.definition.node_id,
				kind: node.definition.kind,
				status: node.definition.node_id === "produce" ? "active" : "waiting",
				scopeEpoch: 1,
				nextRound: node.definition.node_id === "produce" ? 2 : 1,
				...(node.definition.node_id === "produce"
					? { activeRoundId: "produce:round:1", activeAttemptId: oldAttemptId }
					: {}),
			})),
			rounds: [
				{
					roundId: "produce:round:1",
					nodeId: "produce",
					index: 1,
					status: "active",
					inputSubmissionIds: [],
					inputBindings: [],
					activeAttemptId: oldAttemptId,
					startedAt: 1,
				},
			],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			attempts: [
				{
					attemptId: oldAttemptId,
					nodeId: "produce",
					participantId: "producer",
					roundId: "produce:round:1",
					index: 1,
					runGeneration: 0,
					controllerTerm: 1,
					scopeEpoch: 1,
					status: "claimed",
					inputBindings: [],
					claimedAt: 1,
				},
			],
			dispatchIntents: [
				{
					commandId: oldCommandId,
					attemptId: oldAttemptId,
					nodeId: "produce",
					participantId: "producer",
					roundId: "produce:round:1",
					runGeneration: 0,
					controllerTerm: 1,
					scopeEpoch: 1,
					operation: "execute",
					inputBindingHash: hashJson([]),
					status: "pending",
					deliveryCount: 0,
					createdAt: 1,
				},
			],
			events: [],
			operations: {},
		});
		const worker: NodeWorker = {
			async runExecution() {
				await executionGate;
				const path = join(directory.workspace, "outputs", "produce");
				await mkdir(path, { recursive: true });
				await writeFile(join(path, "result.txt"), "recovered");
				return {
					summary: "recovered",
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
				const submission = work.inputSubmissions[0];
				return {
					decision: "PASS",
					criteria: [
						{
							criterion_id: "quality",
							result: "PASS",
							evidence: [
								{
									description: "checked",
									reference: "submission.json",
									submission_id: submission.submissionId,
									node_id: submission.nodeId,
									output_id: "content-output",
									criterion_id: "quality",
								},
							],
							rationale: "accepted",
							required_rework: [],
							rework_targets: [],
						},
					],
					unresolved_issues: [],
				};
			},
			releaseRun,
		};
		const checks = new CheckExecutorRegistry();
		checks.add(createArtifactIntegrityCheckExecutor());
		const control = new IpdControlPlane(
			store,
			new BootstrapProcessSelector(),
			new BootstrapWorkflowDesigner({ id: "producer", version: "1.0.0" }, { id: "reviewer", version: "1.0.0" }),
			new FileWorkflowAssetStore({ directory: join(root, ".pi", "ipd", "workflow") }),
		);
		const service = new IpdService({
			store,
			createControlPlane: () => control,
			processSpecs: [fixture.processSpec],
			assets: { ...fixture.assets, skills: [runSkill] },
			projectRoot: root,
			controllerId: "new-controller",
			createRuntime: (runDirectory, controller) =>
				new WorkflowRuntime(store, runDirectory, worker, new SubmissionStore(), new MechanicalChecker(checks), {
					controller,
				}),
		});

		try {
			await service.resumeRun(fixture.runId);
			// The recovery receipt must not survive into the new execution.
			expect((await service.getRun(fixture.runId)).cleanup).toBeUndefined();
			allowExecution();
			await expect.poll(() => releaseRun.mock.calls.length).toBe(1);
			expect(await service.getRun(fixture.runId)).toMatchObject({
				status: "succeeded",
				cleanup: { status: "pending" },
			});
			expect(service.ownsRun(fixture.runId)).toBe(true);
			allowCleanup();
			// Wait for the service's final write and ownership release, not a stale disk flag.
			await expect.poll(() => service.ownsRun(fixture.runId)).toBe(false);
			const recovered = await service.getRun(fixture.runId);
			expect(recovered).toMatchObject({ status: "succeeded", cleanup: { status: "complete" } });
			expect(recovered.attempts).toHaveLength(3);
			expect(recovered.attempts[0]).toMatchObject({ attemptId: oldAttemptId, status: "superseded" });
			expect(recovered.dispatchIntents[0]).toMatchObject({
				commandId: oldCommandId,
				status: "cancelled",
				deliveryCount: 0,
			});
			expect(recovered.attempts.filter((attempt) => attempt.nodeId === "produce").at(-1)).toMatchObject({
				index: 2,
				controllerTerm: 2,
				scopeEpoch: 2,
				status: "completed",
			});
			expect(recovered.events.some((event) => event.type === "pending_dispatch_recovered")).toBe(true);
		} finally {
			// Also settle the fixture when an assertion fails, before afterEach removes its root.
			allowExecution();
			allowCleanup();
			await expect.poll(() => service.ownsRun(fixture.runId)).toBe(false);
			await service.close();
		}
	});
});
