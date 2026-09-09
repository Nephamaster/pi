import { describe, expect, it } from "vitest";
import {
	buildInitialWorkflowDesignPrompt,
	buildProcessSelectionPrompt,
	buildWorkflowDesignRevisionPrompt,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("control-role prompt projection", () => {
	it("explicitly loads the bound process-selection Skill", () => {
		const fixture = createCompilerFixture();
		const prompt = buildProcessSelectionPrompt("process-selection", fixture.taskInput);
		expect(prompt).toContain("/skill:process-selection");
		expect(prompt).toContain("TaskInput:");
		expect(prompt).toContain(fixture.taskInput.raw_task.text);
	});

	it("sends frozen design inputs once and keeps revision prompts incremental", () => {
		const fixture = createCompilerFixture();
		const initial = buildInitialWorkflowDesignPrompt(
			"task-skill",
			fixture.taskInput,
			fixture.processSelection,
			fixture.processSpec,
			{ skills: ["task-skill"], tools: ["read"] },
			[],
		);
		expect(initial).toContain("TaskInput:");
		expect(initial).toContain("ProcessSelection:");
		expect(initial).toContain("ProcessSpec:");
		expect(initial).toContain("Available non-employee resources:");
		expect(initial).toContain("/skill:task-skill");

		const revision = buildWorkflowDesignRevisionPrompt(17, ["/nodes/2: missing review"]);
		expect(revision).toContain("Draft revision: 17");
		expect(revision).toContain("/nodes/2: missing review");
		expect(revision).not.toContain("TaskInput:");
		expect(revision).not.toContain("ProcessSelection:");
		expect(revision).not.toContain("ProcessSpec:");
		expect(revision).not.toContain("Available non-employee resources:");
		expect(revision).not.toContain("/skill:");
	});
});
