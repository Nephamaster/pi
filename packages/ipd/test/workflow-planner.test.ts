import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import {
	AgentSessionNodeRunner,
	createSkillSnapshot,
	FileWorkflowAssetStore,
	hashJson,
	type PlanAndFreezeWorkflowRequest,
	SqliteIpdLedger,
	type WorkflowAssetRecord,
	WorkflowPlanner,
} from "../src/index.ts";
import { createTestCards, createValidWorkflow, TEST_SKILL } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createFixture(runId = "run-1") {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-planner-"));
	roots.push(root);
	const faux = fauxProvider();
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(),
		modelsPath: null,
		allowModelNetwork: false,
	});
	modelRuntime.registerNativeProvider(faux.provider);
	await modelRuntime.refresh({ allowNetwork: false });
	const cards = createTestCards();
	const skillPath = join(root, "SKILL.md");
	const skill = createSkillSnapshot({
		name: TEST_SKILL,
		path: skillPath,
		baseDir: root,
		content: "ORIGINAL_SKILL_CONTENT: design a controlled Workflow.",
	});
	await writeFile(skillPath, skill.content);
	const ledger = new SqliteIpdLedger({ databasePath: join(root, "ipd.sqlite") });
	const assetStore = new FileWorkflowAssetStore({ directory: join(root, "workflow-assets") });
	const nodeRunner = new AgentSessionNodeRunner({
		modelRuntime,
		agentDir: join(root, "agent"),
		sessionDir: join(root, "sessions"),
	});
	const planner = new WorkflowPlanner({
		ledger,
		nodeRunner,
		assetStore,
		toolNames: new Set(["read", "write", "bash"]),
		checks: [
			{
				id: "artifact-exists",
				parameters: Type.Object({ role: Type.String() }, { additionalProperties: false }),
			},
		],
	});
	const candidate = createValidWorkflow(cards);
	candidate.skill = { name: skill.name, hash: skill.hash };
	const request: PlanAndFreezeWorkflowRequest = {
		runId,
		traceId: `trace-${runId}`,
		task: "Produce a reviewed artifact",
		skill,
		agentCards: [cards.executor, cards.reviewer, cards.staff],
		plannerCard: cards.staff,
		templates: [],
		globalBudget: candidate.globalBudget,
		cwd: root,
		runDefaultModel: faux.getModel(),
		runDefaultThinkingLevel: "off",
		maxRevisions: 3,
	};
	return { root, faux, cards, skill, ledger, assetStore, planner, candidate, request };
}

describe("WorkflowPlanner", () => {
	it("designs, persists, and freezes a Workflow without starting business Nodes", async () => {
		const fixture = await createFixture();
		await writeFile(fixture.skill.path, "CHANGED_AFTER_SNAPSHOT");
		let plannerPrompt = "";
		fixture.faux.setResponses([
			(context) => {
				plannerPrompt = context.systemPrompt ?? "";
				return fauxAssistantMessage(fauxToolCall("submit_workflow", fixture.candidate), { stopReason: "toolUse" });
			},
		]);
		try {
			const result = await fixture.planner.planAndFreeze(fixture.request);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.revisions).toBe(1);
			expect(plannerPrompt).toContain("ORIGINAL_SKILL_CONTENT");
			expect(plannerPrompt).not.toContain("CHANGED_AFTER_SNAPSHOT");
			expect(existsSync(result.asset.source)).toBe(true);
			const snapshot = fixture.ledger.getRunSnapshot("run-1");
			expect(snapshot.run.status).toBe("ready");
			expect(snapshot.workflow?.hash).toBe(result.compiled.hash);
			expect(snapshot.nodes).toEqual([]);
			expect(snapshot.decisions.map((decision) => decision.action)).toEqual(["accept"]);
			expect(snapshot.budgetUsage).toEqual([
				expect.objectContaining({ category: "staff", details: expect.objectContaining({ phase: "planning" }) }),
			]);

			fixture.ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-start", status: "running" });
			fixture.ledger.transitionRun({ runId: "run-1", idempotencyKey: "run-fail", status: "failed" });
			expect(existsSync(result.asset.source)).toBe(true);
		} finally {
			fixture.ledger.close();
		}
	});

	it("repairs a Compiler-rejected candidate on the next Planner revision", async () => {
		const fixture = await createFixture();
		const invalid = structuredClone(fixture.candidate);
		invalid.nodes[0].agentCardRef.hash = "0".repeat(64);
		let repairPrompt = "";
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_workflow", invalid), { stopReason: "toolUse" }),
			(context) => {
				repairPrompt = JSON.stringify(context.messages);
				return fauxAssistantMessage(fauxToolCall("submit_workflow", fixture.candidate), { stopReason: "toolUse" });
			},
		]);
		try {
			const result = await fixture.planner.planAndFreeze(fixture.request);
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.revisions).toBe(2);
			expect(repairPrompt).toContain("Unknown AgentCard");
			expect(fixture.ledger.getRunSnapshot("run-1").decisions.map((decision) => decision.action)).toEqual([
				"reject",
				"accept",
			]);
		} finally {
			fixture.ledger.close();
		}
	});

	it("reuses a prior Workflow Asset only by creating and compiling a derived Workflow", async () => {
		const fixture = await createFixture();
		const template = structuredClone(fixture.candidate);
		template.id = "template-workflow";
		template.name = "Template Workflow";
		const templateWrite = await fixture.assetStore.save(template, hashJson(template));
		const templates: WorkflowAssetRecord[] = [templateWrite.record];
		const derived = structuredClone(fixture.candidate);
		derived.id = "derived-workflow";
		derived.name = "Derived Workflow";
		derived.source = "template";
		derived.sourceTemplateId = template.id;
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_workflow", derived), { stopReason: "toolUse" }),
		]);
		try {
			const result = await fixture.planner.planAndFreeze({ ...fixture.request, templates });
			expect(result.ok).toBe(true);
			if (!result.ok) return;
			expect(result.asset.workflow.id).toBe("derived-workflow");
			expect(result.asset.workflow.sourceTemplateId).toBe("template-workflow");
			expect(result.asset.source).not.toBe(templateWrite.record.source);
		} finally {
			fixture.ledger.close();
		}
	});

	it("fails the Run after the configured Compiler revision limit", async () => {
		const fixture = await createFixture();
		const invalid = structuredClone(fixture.candidate);
		invalid.nodes[0].agentCardRef.hash = "0".repeat(64);
		fixture.faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_workflow", invalid), { stopReason: "toolUse" }),
			fauxAssistantMessage(fauxToolCall("submit_workflow", invalid), { stopReason: "toolUse" }),
		]);
		try {
			const result = await fixture.planner.planAndFreeze({ ...fixture.request, maxRevisions: 2 });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.failure.code).toBe("compiler_exhausted");
			expect(result.revisions).toBe(2);
			const snapshot = fixture.ledger.getRunSnapshot("run-1");
			expect(snapshot.run.status).toBe("failed");
			expect(snapshot.workflow).toBeUndefined();
			expect(snapshot.decisions.map((decision) => decision.action)).toEqual(["reject", "reject", "fail"]);
		} finally {
			fixture.ledger.close();
		}
	});

	it("rejects a missing Skill before creating a Run or calling the Planner", async () => {
		const fixture = await createFixture();
		try {
			const result = await fixture.planner.planAndFreeze({ ...fixture.request, skill: undefined });
			expect(result.ok).toBe(false);
			if (result.ok) return;
			expect(result.failure.code).toBe("missing_skill");
			expect(fixture.ledger.getRun("run-1")).toBeUndefined();
			expect(fixture.faux.state.callCount).toBe(0);
		} finally {
			fixture.ledger.close();
		}
	});
});
