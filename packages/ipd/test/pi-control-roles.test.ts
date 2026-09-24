import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Context } from "@earendil-works/pi-ai";
import { fauxAssistantMessage, fauxToolCall, registerFauxProvider } from "@earendil-works/pi-ai/compat";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import type { NodeSessionEventEnvelope } from "../src/adapter/node-session-adapter.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { type PiControlRoleOptions, PiProcessSelector, PiWorkflowDesigner } from "../src/control/pi-control-roles.ts";
import { WorkflowDraftManager } from "../src/control/workflow-draft.ts";
import { canonicalJson, toJsonValue } from "../src/ir/hash.ts";
import { hashSkillPackage } from "../src/registry/skill-package.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { authoringCommands } from "./workflow-authoring-fixtures.ts";

function userTexts(context: Context): string[] {
	return context.messages.flatMap((message) =>
		message.role === "user"
			? [
					typeof message.content === "string"
						? message.content
						: message.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
				]
			: [],
	);
}

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
			tools: [{ id: "read", hash: "a".repeat(64), source: "test" }],
			sessionSettings: { retry: { maxRetries: 1, baseDelayMs: 1 } },
			onSessionEvent: (event) => {
				events.push(event);
			},
		};
		const skills = [];
		for (const id of ["method", "task"]) {
			const baseDir = join(root, id === "task" ? "business skill" : id);
			await mkdir(baseDir);
			const filePath = join(baseDir, "SKILL.md");
			await writeFile(
				filePath,
				`---\nname: ${id}\ndescription: Synthetic control procedure.\n${id === "task" ? "disable-model-invocation: true\n" : ""}---\n${id === "method" ? "Method body marker." : "Business body marker."} Submit a structured result.\n`,
			);
			if (id === "method") {
				await mkdir(join(baseDir, "references"));
				await writeFile(join(baseDir, "references", "detail.md"), "Reference body marker.\n");
			}
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
			(context) => {
				// Assert the real first provider request, not two independently valid prompt builders.
				const users = userTexts(context);
				expect(users).toHaveLength(1);
				expect(users[0]).toContain("Method body marker.");
				expect(users[0]).toContain(canonicalJson(base.taskInput));
				expect(users[0]).toContain(canonicalJson(base.processSelection));
				expect(users[0]).toContain(canonicalJson(base.processSpec));
				expect(users[0]).toContain("Available non-employee resources:");
				expect(users[0]).not.toContain("workflow_design_method_request");
				expect(users[0]).not.toContain("Business body marker.");
				expect(users[0]).not.toContain("Reference body marker.");
				if (withSkill) expect(users[0]).toContain(JSON.stringify(skills[1].filePath));
				else expect(users[0]).toContain("No business Run Skill is selected");
				return fauxAssistantMessage(
					fauxToolCall("read", {
						path: withSkill ? skills[1].filePath : join(skills[0].baseDir, "references", "detail.md"),
					}),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const read = context.messages.find(
					(message) => message.role === "toolResult" && message.toolName === "read",
				);
				expect(read).toMatchObject({ role: "toolResult", isError: false });
				expect(JSON.stringify(read)).toContain(withSkill ? "Business body marker." : "Reference body marker.");
				return fauxAssistantMessage(
					fauxToolCall("workflow_draft_submit", { expected_revision: 1, operation_id: "submit-design-1" }),
					{ stopReason: "toolUse" },
				);
			},
			(context) => {
				const users = userTexts(context);
				expect(users).toHaveLength(2);
				expect(users[1]).toContain("Recheck the workflow");
				expect(users[1]).not.toContain("TaskInput:");
				expect(users[1]).not.toContain("Method body marker.");
				expect(users[0]).toContain(canonicalJson(base.taskInput));
				expect(context.messages.some((message) => message.role === "toolResult")).toBe(true);
				return fauxAssistantMessage(
					fauxToolCall("workflow_draft_submit", { expected_revision: 1, operation_id: "submit-design-2" }),
					{ stopReason: "toolUse" },
				);
			},
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
			expect(dispatches).toHaveLength(2);
			expect(events.some((event) => event.roundId === "design-method")).toBe(false);
			expect(events.filter(({ event }) => event.type === "tool_execution_end" && event.isError)).toEqual([]);
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
			...commands.map((command, index) => {
				const data = toJsonValue(command.data);
				if (data === null || typeof data !== "object" || Array.isArray(data)) {
					throw new Error("Expected object-valued authoring command");
				}
				return fauxAssistantMessage(
					fauxToolCall(`workflow_draft_${command.domain}`, {
						expected_revision: index,
						operation_id: `step-${index}`,
						...data,
					}),
					{ stopReason: "toolUse" },
				);
			}),
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
			expect(faux.state.callCount).toBe(commands.length + 1);
			expect(events.some((event) => event.roundId === "design-method")).toBe(false);
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

	it("keeps the tool-error guard on the task-bearing first design round", async () => {
		const { root, faux, base, options, skills, events } = await fixture();
		const manager = new WorkflowDraftManager({
			file: join(root, "failed-draft.json"),
			trustedReferences: {
				task_input_ref: base.workflow.task_input_ref,
				process_selection_ref: base.workflow.process_selection_ref,
			},
		});
		const designer = new PiWorkflowDesigner({
			optionsForRun: () => options,
			managerForRun: () => manager,
			designSkill: skills[0],
			assetSummary: {},
			agentCards: base.assets.agentCards,
		});
		faux.setResponses(
			Array.from({ length: 9 }, (_, index) =>
				fauxAssistantMessage(fauxToolCall("read", { path: join(root, `missing-${index}.md`) }), {
					stopReason: "toolUse",
				}),
			),
		);
		try {
			await expect(designer.design("run", base.taskInput, base.processSelection, base.processSpec)).rejects.toThrow(
				"Round design-1 exceeded 8 tool errors",
			);
			expect(faux.state.callCount).toBe(9);
			expect(events.filter(({ event }) => event.type === "tool_execution_end" && event.isError)).toHaveLength(9);
			expect(events.some((event) => event.roundId === "design-method")).toBe(false);
		} finally {
			await designer.cancelRun("run");
		}
	});
});
