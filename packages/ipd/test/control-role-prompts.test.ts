import { describe, expect, it } from "vitest";
import {
	buildInitialWorkflowDesignPrompt,
	buildProcessSelectionPrompt,
	buildWorkflowDesignRevisionPrompt,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("control-role prompt projection", () => {
	it("designs from the original task and assets without requiring a business Skill", () => {
		const fixture = createCompilerFixture();
		const prompt = buildInitialWorkflowDesignPrompt(
			"workflow-design",
			fixture.taskInput,
			fixture.processSelection,
			fixture.processSpec,
			{ tools: ["bash"], environmentProfiles: ["general-purpose"] },
			[],
		);
		expect(prompt).toMatch(/^\/skill:workflow-design <workflow_design_assignment>/);
		expect(prompt.match(/\/skill:/g)).toHaveLength(1);
		expect(prompt).not.toContain("workflow_design_method_request");
		expect(prompt).toContain(fixture.taskInput.raw_task.text);
		expect(prompt).toContain("general-purpose");
		expect(prompt).toContain("absence is not a resource gap");
	});
	it("explicitly loads the bound process-selection Skill", () => {
		const fixture = createCompilerFixture();
		const prompt = buildProcessSelectionPrompt("process-selection", fixture.taskInput);
		expect(prompt).toMatch(/^\/skill:process-selection <process_selection_assignment>/);
		expect(prompt).toContain("</process_selection_assignment>");
		expect(prompt).toContain("TaskInput:");
		expect(prompt).toContain(fixture.taskInput.raw_task.text);
	});

	it("sends frozen design inputs once and keeps revision prompts incremental", () => {
		const fixture = createCompilerFixture();
		const runSkill = { id: "task-skill", filePath: "/locked/business skill/SKILL.md" };
		const initial = buildInitialWorkflowDesignPrompt(
			"workflow-design",
			fixture.taskInput,
			fixture.processSelection,
			fixture.processSpec,
			{ skills: ["task-skill"], tools: ["read"] },
			[],
			runSkill,
		);
		expect(initial).toContain("TaskInput:");
		expect(initial).toContain("ProcessSelection:");
		expect(initial).toContain("ProcessSpec:");
		expect(initial).toContain("Available non-employee resources:");
		expect(initial).toMatch(/^\/skill:workflow-design <workflow_design_assignment>/);
		expect(initial.match(/\/skill:/g)).toHaveLength(1);
		expect(initial).not.toContain("/skill:task-skill");
		expect(initial).toContain(runSkill.filePath);
		expect(initial).toContain("authorized read tool when relevant");
		expect(initial).toContain("<workflow_design_assignment>");
		expect(initial).toContain("</workflow_design_assignment>");

		const revision = buildWorkflowDesignRevisionPrompt(17, ["/nodes/2: missing review"]);
		expect(revision).toContain("Draft revision: 17");
		expect(revision).toContain("/nodes/2: missing review");
		expect(revision).not.toContain("TaskInput:");
		expect(revision).not.toContain("ProcessSelection:");
		expect(revision).not.toContain("ProcessSpec:");
		expect(revision).not.toContain("Available non-employee resources:");
		expect(revision).not.toContain("/skill:");
		expect(revision).toMatch(/^<workflow_design_revision>[\s\S]*<\/workflow_design_revision>$/);
	});
});
