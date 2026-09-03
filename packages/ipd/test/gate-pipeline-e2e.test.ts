import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionNodeRunner,
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	createDefaultArtifactViewRegistry,
	createSkillSnapshot,
	DynamicGateEvaluator,
	GraphEngine,
	MechanicalChecker,
	SqliteIpdLedger,
} from "../src/index.ts";
import { createCompileContext, createTestCards, createValidWorkflow, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("real Gate Pipeline integration", () => {
	it("lets the final Reviewer reject an Artifact that passed its local Gate", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-gate-e2e-"));
		roots.push(root);
		await mkdir(join(root, "outputs"));
		await writeFile(join(root, "outputs", "primary.txt"), "locally acceptable but globally incomplete");
		await writeFile(join(root, "outputs", "review.txt"), "reviewable final content");

		const faux = fauxProvider();
		const modelRuntime = await ModelRuntime.create({
			credentials: new InMemoryCredentialStore(),
			modelsPath: null,
			allowModelNetwork: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		await modelRuntime.refresh({ allowNetwork: false });
		const cards = createTestCards();
		const skill = createSkillSnapshot({
			name: TEST_SKILL,
			path: join(root, "SKILL.md"),
			baseDir: root,
			content: "Produce and independently evaluate the final Artifact.",
		});
		const workflow = createValidWorkflow(cards);
		workflow.skill = { name: skill.name, hash: skill.hash };
		for (const gate of [workflow.nodes[0].gate, workflow.finalGate]) {
			gate.mechanicalCriteria[0].checkId = "artifact-integrity";
			gate.mechanicalCriteria[0].parameters = {};
		}
		const context = createCompileContext(cards);
		context.runSkill = { name: skill.name, hash: skill.hash };
		context.checks = [{ id: "artifact-integrity", parameters: Type.Object({}, { additionalProperties: false }) }];
		const compiled = compileWorkflow(workflow, context);
		if (!compiled.ok) throw new Error(compiled.diagnostics.map((item) => item.message).join("\n"));

		const ledger = new SqliteIpdLedger({ databasePath: join(root, "ipd.sqlite") });
		try {
			ledger.createRun({
				runId: "run-1",
				traceId: "trace-1",
				idempotencyKey: "create",
				task: "Produce a complete final Artifact",
				skill: { name: skill.name, hash: skill.hash },
				globalBudget: { tokens: 100_000 },
			});
			ledger.transitionRun({ runId: "run-1", idempotencyKey: "compiling", status: "compiling" });
			ledger.freezeWorkflow({ runId: "run-1", idempotencyKey: "freeze", workflow: compiled.value });

			const nodeRunner = new AgentSessionNodeRunner({
				modelRuntime,
				agentDir: join(root, "agent"),
				sessionDir: join(root, "sessions"),
			});
			const checks = new CheckExecutorRegistry();
			checks.add(createArtifactIntegrityCheckExecutor());
			const gateEvaluator = new DynamicGateEvaluator({
				mechanicalChecker: new MechanicalChecker(checks),
				artifactViews: createDefaultArtifactViewRegistry(),
				nodeRunner,
			});
			const engine = new GraphEngine({ ledger, nodeRunner, gateEvaluator });

			faux.setResponses([
				fauxAssistantMessage(
					fauxToolCall("write", { path: "outputs/primary.txt", content: "final primary content" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("write", { path: "outputs/review.txt", content: "reviewable final content" }),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("submit_artifact", {
						summary: "Candidate Artifact",
						files: [
							{ path: "outputs/primary.txt", mimeType: "text/plain" },
							{ path: "outputs/review.txt", mimeType: "text/plain" },
						],
						metadata: {},
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("submit_review", {
						decision: "PASS",
						criteria: [
							{
								criterionId: "produce-gate-semantic",
								result: "PASS",
								evidence: { scope: "local" },
								rationale: "Local node objective is satisfied",
								requiredRework: [],
							},
						],
						unresolvedRisks: [],
					}),
					{ stopReason: "toolUse" },
				),
				fauxAssistantMessage(
					fauxToolCall("submit_review", {
						decision: "FAIL",
						criteria: [
							{
								criterionId: "final-gate-semantic",
								result: "FAIL",
								evidence: { scope: "end-to-end" },
								rationale: "The original user objective is not fully covered",
								requiredRework: ["Add the missing end-to-end content"],
							},
						],
						unresolvedRisks: ["Incomplete final coverage"],
					}),
					{ stopReason: "toolUse" },
				),
			]);

			const result = await engine.run("run-1", {
				cwd: root,
				skill,
				runDefaultModel: faux.getModel(),
				runDefaultThinkingLevel: "off",
			});
			expect(result.status).toBe("failed");
			expect(result.snapshot.nodes[0].status).toBe("succeeded");
			expect(result.snapshot.artifacts[0].status).toBe("accepted");
			expect(result.snapshot.gates.map((gate) => gate.status)).toEqual(["passed", "failed"]);
			expect(result.snapshot.reviewers).toHaveLength(2);
			expect(
				result.snapshot.criteria
					.filter((criterion) => criterion.kind === "semantic")
					.map((criterion) => criterion.result),
			).toEqual(["PASS", "FAIL"]);
		} finally {
			ledger.close();
		}
	});
});
