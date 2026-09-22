import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeSessionEventEnvelope } from "../src/adapter/node-session-adapter.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { type PiControlRoleOptions, PiProcessSelector, PiWorkflowDesigner } from "../src/control/pi-control-roles.ts";
import { WorkflowDraftManager } from "../src/control/workflow-draft.ts";
import { hashSkillPackage } from "../src/registry/skill-package.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { authoringCommands } from "./workflow-authoring-fixtures.ts";

describe("native control role bindings", () => {
	const cleanups: Array<() => Promise<void>> = [];
	afterEach(async () => {
		while (cleanups.length) await cleanups.pop()?.();
	});
	async function fixture() {
		const root = await mkdtemp(join(tmpdir(), "ipd-control-binding-"));
		const faux = registerFauxProvider();
		cleanups.push(async () => {
			faux.unregister();
			await rm(root, { recursive: true, force: true });
		});
		const modelRuntime = await ModelRuntime.create({
			authPath: join(root, "auth.json"),
			modelsPath: null,
			refreshOnCreate: false,
		});
		const model = faux.getModel();
		modelRuntime.registerProvider(model.provider, { baseUrl: model.baseUrl, api: model.api, models: [model] });
		await modelRuntime.setRuntimeApiKey(model.provider, "faux-key");
		const base = createCompilerFixture();
		const events: NodeSessionEventEnvelope[] = [];
		const options: PiControlRoleOptions = {
			agentDir: root,
			workspace: root,
			sessionDirectory: join(root, "sessions"),
			modelRuntime,
			model,
			thinkingLevel: "off",
			agentCard: base.assets.agentCards[0],
			sessionSettings: { retry: { maxRetries: 1, baseDelayMs: 1 } },
			onSessionEvent: (event) => {
				events.push(event);
			},
		};
		const skills = [];
		for (const id of ["method", "task"]) {
			const baseDir = join(root, id);
			await mkdir(baseDir);
			const filePath = join(baseDir, "SKILL.md");
			await writeFile(
				filePath,
				`---\nname: ${id}\ndescription: Synthetic control procedure.\n---\nSubmit a structured result.\n`,
			);
			skills.push({
				id,
				baseDir,
				filePath,
				hash: await hashSkillPackage(baseDir),
				source: "test",
				allowedTools: [],
				description: "Synthetic control procedure.",
			});
		}
		return { root, faux, base, events, options, skills };
	}

	it("rejects overlapping selection, corrects invalid output, and releases its one native session", async () => {
		const { faux, base, options, skills, events } = await fixture();
		const selector = new PiProcessSelector(options, skills[0]);
		const decision = {
			status: "selected",
			process_spec_id: base.processSpec.process_spec_id,
			process_spec_version: base.processSpec.version,
			rationale: "Matches the task",
			process_requirement_refs: ["produce"],
			unresolved_fact_refs: [],
		};
		faux.setResponses([
			fauxAssistantMessage(fauxToolCall("submit_process_selection", { ...decision, process_spec_id: "missing" }), {
				stopReason: "toolUse",
			}),
			fauxAssistantMessage(fauxToolCall("submit_process_selection", decision), { stopReason: "toolUse" }),
		]);
		const running = selector.select("run", base.taskInput, [base.processSpec]);
		await expect(selector.select("run", base.taskInput, [base.processSpec])).rejects.toThrow(
			"already has a bound Session",
		);
		expect((await running).process_spec_ref.id).toBe(base.processSpec.process_spec_id);
		expect(faux.state.callCount).toBe(2);
		expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
		expect(
			events
				.filter(({ event }) => event.type === "tool_execution_end")
				.map(({ event }) => event.type === "tool_execution_end" && event.isError),
		).toEqual([true, false]);
		await selector.cancelRun("run");
		await expect(selector.select("run", base.taskInput, [base.processSpec])).rejects.toThrow("cannot be recreated");
	});

	it.each([false, true])("designs and revises in one native Session (business Skill=%s)", async (withSkill) => {
		const { root, faux, base, options, skills, events } = await fixture();
		const workflow = base.workflow;
		const manager = new WorkflowDraftManager({
			file: join(root, "draft.json"),
			trustedReferences: {
				task_input_ref: workflow.task_input_ref,
				process_selection_ref: workflow.process_selection_ref,
			},
		});
		const draft = await manager.open("run");
		await manager.apply(draft.draftId, 0, "seed", [
			{
				kind: "set_header",
				header: {
					schema_version: 3,
					workflow_id: workflow.workflow_id,
					workflow_version: workflow.workflow_version,
					name: workflow.name,
				},
			},
			...workflow.nodes.map((node) => ({ kind: "upsert_node" as const, node })),
			...workflow.criteria.map((criterion) => ({ kind: "upsert_criterion" as const, criterion })),
			{ kind: "set_requirement_coverage", coverage: workflow.requirement_coverage },
			{ kind: "set_completion", completion: workflow.completion },
		]);
		const designer = new PiWorkflowDesigner({
			optionsForRun: () => options,
			managerForRun: () => manager,
			designSkill: skills[0],
			runSkill: withSkill ? skills[1] : undefined,
			assetSummary: {},
			agentCards: base.assets.agentCards,
		});
		faux.setResponses([
			fauxAssistantMessage("Method loaded."),
			fauxAssistantMessage(
				fauxToolCall("workflow_draft_submit", { expected_revision: 1, operation_id: "submit-design-1" }),
				{ stopReason: "toolUse" },
			),
			fauxAssistantMessage(
				fauxToolCall("workflow_draft_submit", { expected_revision: 1, operation_id: "submit-design-2" }),
				{ stopReason: "toolUse" },
			),
		]);
		try {
			expect(await designer.design("run", base.taskInput, base.processSelection, base.processSpec)).toEqual(
				workflow,
			);
			expect(
				await designer.design("run", base.taskInput, base.processSelection, base.processSpec, [
					"Recheck the workflow",
				]),
			).toEqual(workflow);
			expect(faux.state.callCount).toBe(3);
			expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
			const dispatches = events.flatMap(({ event }) =>
				event.type === "message_end" && event.message.role === "user"
					? [JSON.stringify(event.message.content)]
					: [],
			);
			expect(dispatches.join("\n")).not.toContain("/skill:undefined");
			if (!withSkill) expect(dispatches.join("\n")).toContain("No business Run Skill is selected");
		} finally {
			await designer.cancelRun("run");
		}
	});

	it("authors through domain tools in a single native Session and compiles with the existing engine", async () => {
		const { root, faux, base, options, skills, events } = await fixture();
		const manager = new WorkflowDraftManager({
			file: join(root, "domain-draft.json"),
			trustedReferences: {
				task_input_ref: base.workflow.task_input_ref,
				process_selection_ref: base.workflow.process_selection_ref,
			},
			validator: (workflow) => {
				const result = compileWorkflow({ ...base, workflow });
				return result.ok ? [] : result.report.diagnostics;
			},
		});
		const commands = authoringCommands(base.workflow);
		faux.setResponses([
			fauxAssistantMessage("Method loaded."),
			...commands.map((command, index) =>
				fauxAssistantMessage(
					fauxToolCall(`workflow_draft_${command.domain}`, {
						expected_revision: index,
						operation_id: `step-${index}`,
						...command.data,
					}),
					{ stopReason: "toolUse" },
				),
			),
			fauxAssistantMessage(
				fauxToolCall("workflow_draft_submit", {
					expected_revision: commands.length,
					operation_id: "submit-domain-workflow",
				}),
				{ stopReason: "toolUse" },
			),
		]);
		const designer = new PiWorkflowDesigner({
			optionsForRun: () => options,
			managerForRun: () => manager,
			designSkill: skills[0],
			assetSummary: {},
			agentCards: base.assets.agentCards,
		});
		try {
			const workflow = await designer.design(base.runId, base.taskInput, base.processSelection, base.processSpec);
			expect(compileWorkflow({ ...base, workflow }).ok).toBe(true);
			expect(workflow.nodes[1].inputs[0]).toMatchObject({
				purpose: "test_subject",
				required: true,
				availability: "submitted",
			});
			expect(new Set(events.map((event) => event.sessionId)).size).toBe(1);
			expect(events.filter(({ event }) => event.type === "tool_execution_end" && event.isError)).toEqual([]);
		} finally {
			await designer.cancelRun(base.runId);
		}
	});
});
