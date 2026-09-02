import Type from "typebox";
import { describe, expect, it } from "vitest";
import { WorkflowSubmissionBuilder } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

describe("WorkflowSubmissionBuilder", () => {
	it("removes an obsolete preloaded Node and its Gate", () => {
		const workflow = createValidWorkflow();
		const builder = new WorkflowSubmissionBuilder(
			[
				{
					id: "artifact-exists",
					parameters: Type.Object({ role: Type.String() }, { additionalProperties: false }),
				},
			],
			{
				skill: workflow.skill,
				globalBudget: workflow.globalBudget,
				staff: workflow.staff,
			},
			workflow,
		);

		expect(builder.finalize().nodes.map((node) => node.id)).toEqual(["produce"]);
		builder.removeNode("produce");
		expect(builder.value).toBeUndefined();
		expect(() => builder.finalize()).toThrow("submit_workflow_node at least once");
		expect(() => builder.removeNode("produce")).toThrow("Workflow Node does not exist: produce");
	});
});
