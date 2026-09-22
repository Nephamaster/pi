import type {
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { hashJson, registerIpdCreateRunTool } from "../src/index.ts";
import type { IpdService } from "../src/runtime/ipd-service.ts";
import { createCompilerFixture, createEmptyRuntimeRecords } from "./fixtures.ts";

describe("IPD create-run tool", () => {
	it.each([false, true])(
		"allows /ipd without a business Skill (catalog has a candidate=%s)",
		async (withCandidate) => {
			let handler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
			const api = {
				registerTool() {},
				registerCommand(name: string, command: { handler: typeof handler }) {
					if (name === "ipd") handler = command.handler;
				},
			} as unknown as ExtensionAPI;
			const createRun = vi
				.fn()
				.mockResolvedValue({ runId: "run", accepted: true, phase: "intake", status: "running" });
			const service = {
				listProcessSpecTemplates: () => [],
				listRunSkills: () => (withCandidate ? [{ id: "pptx", description: "Presentations" }] : []),
				createRun,
			} as unknown as IpdService;
			registerIpdCreateRunTool(api, async () => service);
			const select = vi.fn(async (_title: string, choices: string[]) => choices[0]);
			await handler!("", {
				hasUI: true,
				ui: { select, confirm: async () => false, editor: async () => "Original task", notify: vi.fn() },
			} as unknown as ExtensionCommandContext);
			expect(createRun).toHaveBeenCalledWith(
				expect.any(String),
				expect.objectContaining({ raw_task: { text: "Original task", source: "user-command:/ipd" } }),
				undefined,
			);
			expect(select).toHaveBeenCalledTimes(withCandidate ? 2 : 1);
		},
	);
	it.each(["pause", "resume"] as const)("routes %s to the owning Run service", async (action) => {
		const tools: ToolDefinition[] = [];
		const api = {
			registerCommand() {},
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const operation = vi.fn().mockResolvedValue({
			runId: "run",
			phase: "execute",
			status: action === "pause" ? "paused" : "running",
			generation: 2,
		});
		const provider = vi.fn().mockResolvedValue({ pauseRun: operation, resumeRun: operation });
		registerIpdCreateRunTool(api, provider);
		const tool = tools.find((item) => item.name === `ipd_${action}_run`)!;
		const context = {} as ExtensionContext;
		await tool.execute("call", { run_id: "run" }, undefined, undefined, context);
		expect(provider).toHaveBeenCalledWith(context, "run");
		expect(operation).toHaveBeenCalledWith("run");
	});
	it("requires only identity and verbatim task, with optional Skill and user materials", async () => {
		const tools: ToolDefinition[] = [];
		const api = {
			registerCommand() {},
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const createRun = vi.fn<IpdService["createRun"]>().mockResolvedValue({
			runId: "run-1",
			accepted: true,
			phase: "intake",
			status: "running",
		});
		registerIpdCreateRunTool(api, async () => ({ createRun }) as unknown as IpdService);

		const tool = tools.find((candidate) => candidate.name === "ipd");
		if (!tool) throw new Error("IPD tool was not registered");
		const schema = tool.parameters as {
			additionalProperties?: boolean;
			properties: Record<string, { description?: string }>;
			required?: string[];
		};
		expect(Object.keys(schema.properties)).toEqual(["request_id", "skill_name", "task", "materials"]);
		expect(schema.required).toEqual(["request_id", "task"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties).not.toHaveProperty("objectives");
		expect(schema.properties).not.toHaveProperty("requirements");

		const task = "Prepare a deck for management. Final delivery must be exactly one PPTX file.";
		const firstResult = await tool.execute(
			"call-1",
			{ request_id: "request-1", skill_name: "pptx", task },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(firstResult.terminate).toBe(true);

		expect(createRun).toHaveBeenCalledWith(
			"request-1",
			{
				schema_version: 2,
				task_input_id: "request-1",
				raw_task: { text: task, source: "external-agent-request" },
				materials: [],
				unresolved_facts: [],
			},
			"pptx",
		);

		createRun.mockClear();
		const materials = [
			{
				material_id: "source-1",
				description: "Source supplied by the user",
				reference: "/input/source.md",
				media_type: "text/markdown",
			},
		];
		await tool.execute(
			"call-2",
			{ request_id: "request-2", skill_name: "pptx", task, materials },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(createRun).toHaveBeenCalledWith("request-2", expect.objectContaining({ materials }), "pptx");
		await tool.execute("call-3", { request_id: "request-3", task }, undefined, undefined, {} as ExtensionContext);
		expect(createRun).toHaveBeenCalledWith(
			"request-3",
			expect.objectContaining({ raw_task: { text: task, source: "external-agent-request" } }),
			undefined,
		);
	});

	it("starts a template-backed Run from the interactive /ipd command", async () => {
		const fixture = createCompilerFixture();
		fixture.workflow.nodes[0].agents[0].skills = [{ id: "pptx" }];
		let commandHandler: ((args: string, context: ExtensionCommandContext) => Promise<void>) | undefined;
		const api = {
			registerCommand(
				name: string,
				command: { handler: (args: string, context: ExtensionCommandContext) => Promise<void> },
			) {
				if (name === "ipd") commandHandler = command.handler;
			},
			registerTool() {},
		} as unknown as ExtensionAPI;
		const workflowTemplate = {
			workflow: fixture.workflow,
			hash: hashJson(fixture.workflow),
			source: "/templates/example-workflow/1.0.0.json",
		};
		const createRunFromTemplates = vi.fn<IpdService["createRunFromTemplates"]>().mockResolvedValue({
			runId: "run-template",
			accepted: true,
			phase: "intake",
			status: "running",
		});
		const service = {
			listProcessSpecTemplates: () => [fixture.processSpec],
			listWorkflowTemplates: async () => [workflowTemplate],
			listRunSkills: () => [
				{
					id: "pptx",
					hash: "a".repeat(64),
					source: "test",
					filePath: "/skills/pptx/SKILL.md",
					baseDir: "/skills/pptx",
					description: "Create presentations",
					allowedTools: ["bash"],
				},
			],
			createRunFromTemplates,
		} as unknown as IpdService;
		registerIpdCreateRunTool(api, async () => service);
		if (!commandHandler) throw new Error("/ipd command was not registered");
		const task = "  Create the requested presentation.\nPreserve this text.  ";
		const select = vi
			.fn()
			.mockResolvedValueOnce("Delivery Process · delivery-process@1.0.0")
			.mockResolvedValueOnce("Example Workflow · example-workflow@1.0.0")
			.mockResolvedValueOnce("pptx · Create presentations");
		const confirm = vi.fn().mockResolvedValue(false);
		const input = vi
			.fn()
			.mockResolvedValueOnce("Source brief")
			.mockResolvedValueOnce("/inputs/brief.md")
			.mockResolvedValueOnce("text/markdown");
		const notify = vi.fn();
		await commandHandler("", {
			hasUI: true,
			ui: { select, confirm, input, editor: vi.fn().mockResolvedValue(task), notify },
		} as unknown as ExtensionCommandContext);

		expect(createRunFromTemplates).toHaveBeenCalledOnce();
		const [requestId, taskInput, runSkillId, templates] = createRunFromTemplates.mock.calls[0];
		expect(requestId).toMatch(/^ipd-command-\d+$/);
		expect(taskInput).toMatchObject({
			task_input_id: requestId,
			raw_task: { text: task, source: "user-command:/ipd" },
			materials: [
				{
					material_id: "brief",
					description: "Source brief",
					reference: "/inputs/brief.md",
					media_type: "text/markdown",
				},
			],
		});
		expect(runSkillId).toBe("pptx");
		expect(templates).toEqual({
			processSpecId: "delivery-process",
			processSpecVersion: "1.0.0",
			workflowId: "example-workflow",
			workflowVersion: "1.0.0",
		});
		expect(notify).toHaveBeenCalledWith("IPD Run run-template 已启动", "info");
	});

	it("exposes explicit Run cancellation", async () => {
		const tools: ToolDefinition[] = [];
		const api = {
			registerCommand() {},
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const cancelled = {
			...createEmptyRuntimeRecords(),
			runId: "run-1",
			revision: 4,
			phase: "closed" as const,
			status: "cancelled" as const,
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};
		const cancelRun = vi.fn<IpdService["cancelRun"]>().mockResolvedValue(cancelled);
		registerIpdCreateRunTool(api, async () => ({ cancelRun }) as unknown as IpdService);
		const tool = tools.find((candidate) => candidate.name === "ipd_cancel_run");
		if (!tool) throw new Error("IPD cancel tool was not registered");
		const result = await tool.execute(
			"cancel-1",
			{ run_id: "run-1", reason: "No longer needed" },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		expect(cancelRun).toHaveBeenCalledWith("run-1", "No longer needed");
		expect(result.content.find((item) => item.type === "text")?.text).toContain('"status":"cancelled"');
	});
});
