import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { registerIpdCreateRunTool } from "../src/index.ts";
import type { IpdService } from "../src/runtime/ipd-service.ts";

describe("IPD create-run tool", () => {
	it("preserves verbatim task and projects only exact-source objectives and requirements", async () => {
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
		});
		registerIpdCreateRunTool(api, async () => ({ createRun }) as unknown as IpdService);

		const tool = tools.find((candidate) => candidate.name === "ipd");
		if (!tool) throw new Error("IPD tool was not registered");
		const schema = tool.parameters as {
			additionalProperties?: boolean;
			properties: Record<string, { description?: string }>;
			required?: string[];
		};
		expect(Object.keys(schema.properties)).toEqual([
			"request_id",
			"skill_name",
			"task",
			"objectives",
			"requirements",
			"materials",
		]);
		expect(schema.required).toEqual(["request_id", "skill_name", "task"]);
		expect(schema.additionalProperties).toBe(false);

		const task = "Prepare a deck for management. Final delivery must be exactly one PPTX file.";
		const objectiveText = "Prepare a deck for management";
		const requirementText = "Final delivery must be exactly one PPTX file";
		const objectiveStart = task.indexOf(objectiveText);
		const requirementStart = task.indexOf(requirementText);
		await tool.execute(
			"call-1",
			{
				request_id: "request-1",
				skill_name: "pptx",
				task,
				objectives: [
					{ id: "objective-management-deck", text: objectiveText, start: objectiveStart, end: objectiveStart + objectiveText.length },
				],
				requirements: [
					{ id: "requirement-single-pptx", text: requirementText, start: requirementStart, end: requirementStart + requirementText.length },
				],
			},
			undefined,
			undefined,
			{} as ExtensionContext,
		);

		expect(createRun).toHaveBeenCalledWith(
			"request-1",
			expect.objectContaining({
				raw_task: { text: task, source: "external-agent-request" },
				objectives: [
					expect.objectContaining({
						objective_id: "objective-management-deck",
						statement: { text: objectiveText, source: `raw_task:${objectiveStart}-${objectiveStart + objectiveText.length}` },
					}),
				],
				requirements: [
					expect.objectContaining({
						requirement_id: "requirement-single-pptx",
						statement: { text: requirementText, source: `raw_task:${requirementStart}-${requirementStart + requirementText.length}` },
					}),
				],
			}),
			"pptx",
		);

		await expect(
			tool.execute(
				"call-2",
				{
					request_id: "request-2",
					skill_name: "pptx",
					task,
					requirements: [{ id: "invented", text: "Deliver a PDF", start: requirementStart, end: requirementStart + 13 }],
				},
				undefined,
				undefined,
				{} as ExtensionContext,
			),
		).rejects.toThrow("must be copied exactly from task");
	});
});
