import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxProvider } from "@earendil-works/pi-ai";
import { afterEach, describe, expect, it } from "vitest";
import {
	compileWorkflow,
	createSkillSnapshot,
	type GraphRunContext,
	type GraphRunResult,
	type IpdGraphExecutionService,
	IpdRuntime,
	type IpdWorkflowPlanningService,
	type PlanAndFreezeWorkflowRequest,
	type PlanAndFreezeWorkflowResult,
	SqliteIpdLedger,
} from "../src/index.ts";
import { createCompileContext, createTestCards, createValidWorkflow, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("IpdRuntime recovery", () => {
	it("executes a requested Workflow amendment in the original background Run", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-runtime-recovery-"));
		roots.push(root);
		const cards = createTestCards();
		const skill = createSkillSnapshot({
			name: TEST_SKILL,
			path: join(root, "SKILL.md"),
			baseDir: root,
			content: "Test same-Run Workflow amendment.",
		});
		const initialDefinition = createValidWorkflow(cards);
		initialDefinition.skill = { name: skill.name, hash: skill.hash };
		const initial = compileWorkflow(initialDefinition, {
			...createCompileContext(cards),
			runSkill: { name: skill.name, hash: skill.hash },
		});
		if (!initial.ok) throw new Error(initial.diagnostics.map((item) => item.message).join("\n"));
		const amendedDefinition = structuredClone(initialDefinition);
		amendedDefinition.version = "1.1.0";
		amendedDefinition.name = "Amended Runtime Workflow";
		const amended = compileWorkflow(amendedDefinition, {
			...createCompileContext(cards),
			runSkill: { name: skill.name, hash: skill.hash },
		});
		if (!amended.ok) throw new Error(amended.diagnostics.map((item) => item.message).join("\n"));

		const ledger = new SqliteIpdLedger({ databasePath: join(root, "ipd.sqlite") });
		const planningModes: boolean[] = [];
		const planner: IpdWorkflowPlanningService = {
			async planAndFreeze(request: PlanAndFreezeWorkflowRequest): Promise<PlanAndFreezeWorkflowResult> {
				planningModes.push(request.amendExistingWorkflow ?? false);
				if (request.amendExistingWorkflow) {
					const workflowVersion = ledger.amendWorkflow({
						runId: request.runId,
						idempotencyKey: "amend-workflow",
						workflow: amended.value,
					});
					return {
						ok: true,
						compiled: amended.value,
						asset: { workflow: amended.value.definition, hash: amended.value.hash, source: "test" },
						workflowVersion,
						traces: [],
						revisions: 1,
					};
				}
				ledger.createRun({
					runId: request.runId,
					traceId: request.traceId,
					idempotencyKey: "create-run",
					task: request.task,
					skill: { name: skill.name, hash: skill.hash },
					globalBudget: request.globalBudget,
				});
				ledger.transitionRun({ runId: request.runId, idempotencyKey: "compile-run", status: "compiling" });
				const workflowVersion = ledger.freezeWorkflow({
					runId: request.runId,
					idempotencyKey: "freeze-workflow",
					workflow: initial.value,
				});
				return {
					ok: true,
					compiled: initial.value,
					asset: { workflow: initial.value.definition, hash: initial.value.hash, source: "test" },
					workflowVersion,
					traces: [],
					revisions: 1,
				};
			},
		};
		let graphCalls = 0;
		const graphEngine: IpdGraphExecutionService = {
			async run(runId: string, _context: GraphRunContext): Promise<GraphRunResult> {
				graphCalls++;
				ledger.transitionRun({ runId, idempotencyKey: `graph-start-${graphCalls}`, status: "running" });
				if (graphCalls === 1) {
					ledger.recordDecision({
						runId,
						idempotencyKey: "request-amendment",
						decisionId: "request-amendment",
						type: "workflow_amendment_request",
						action: "request_replan",
						rationale: "The original plan is exhausted",
						evidence: {},
					});
					ledger.transitionRun({ runId, idempotencyKey: "enter-replanning", status: "replanning" });
				} else {
					ledger.transitionRun({ runId, idempotencyKey: "finish-test", status: "failed" });
				}
				const snapshot = ledger.getRunSnapshot(runId);
				return { runId, status: snapshot.run.status, snapshot };
			},
			async resume(): Promise<GraphRunResult> {
				throw new Error("not used");
			},
			async cancel(): Promise<GraphRunResult> {
				throw new Error("not used");
			},
		};
		const runtime = new IpdRuntime({
			ledger,
			graphEngine,
			assetProvider: {
				async prepare() {
					return {
						agentCards: [cards.executor, cards.reviewer, cards.staff],
						plannerCard: cards.staff,
						staffCoreCards: [cards.staff],
						workflowAssets: [],
						planner,
					};
				},
			},
			idFactory: () => (ledger.getRun("run-1") ? "trace-1" : "run-1"),
		});

		try {
			const started = await runtime.start({
				task: "Complete the amended plan",
				skill,
				context: {
					cwd: root,
					projectTrusted: true,
					availableSkills: [skill],
					runDefaultModel: fauxProvider().getModel(),
					runDefaultThinkingLevel: "off",
				},
			});
			expect(started.runId).toBe("run-1");
			for (let attempt = 0; attempt < 100 && runtime.status("run-1").status === "running"; attempt++) {
				await new Promise((resolve) => setTimeout(resolve, 1));
			}
			const snapshot = ledger.getRunSnapshot("run-1");
			expect(snapshot.run.status).toBe("failed");
			expect(snapshot.workflow?.revision).toBe(2);
			expect(snapshot.workflowHistory).toHaveLength(2);
			expect(planningModes).toEqual([false, true]);
			expect(graphCalls).toBe(2);
		} finally {
			runtime.close();
		}
	});
});
