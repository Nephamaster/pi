import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerIpdCreateRunTool } from "../src/index.ts";
import type { IpdService } from "../src/runtime/ipd-service.ts";

describe("IPD create-run tool", () => {
	it("accepts only identity, Skill, the verbatim user task, and optional user materials", async () => {
		const tools: ToolDefinition[] = [];
		const api = {
			registerTool(tool: ToolDefinition) {
				tools.push(tool);
			},
		} as unknown as ExtensionAPI;
		const createRun = vi.fn<IpdService["createRun"]>().mockResolvedValue({
			runId: "run-1",
			accepted: true,
			phase: "intake",
			status: "running",
			visualization: {
				url: "http://127.0.0.1:1234/runs/run-1",
				snapshotUrl: "http://127.0.0.1:1234/runs/run-1/snapshot.html",
				bindHost: "127.0.0.1",
				port: 1234,
			},
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
		expect(schema.required).toEqual(["request_id", "skill_name", "task"]);
		expect(schema.additionalProperties).toBe(false);
		expect(schema.properties.task.description).toContain("copied verbatim");

		const task = "Create the requested deck exactly as described.\nPreserve this second line.";
		const result = await tool.execute(
			"call-1",
			{ request_id: "request-1", skill_name: "pptx", task },
			undefined,
			undefined,
			{} as ExtensionContext,
		);
		const receiptText = result.content.find((item) => item.type === "text")?.text;
		expect(receiptText).toContain("Visualization: http://127.0.0.1:1234/runs/run-1");
		expect(receiptText).toContain("Snapshot: http://127.0.0.1:1234/runs/run-1/snapshot.html");
		expect(createRun).toHaveBeenCalledWith(
			"request-1",
			{
				schema_version: 1,
				task_input_id: "request-1",
				raw_task: { text: task, source: "external-agent-request" },
				objectives: [],
				requirements: [],
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
	});
});
