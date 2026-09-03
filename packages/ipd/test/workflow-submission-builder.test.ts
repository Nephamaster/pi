import Type from "typebox";
import { describe, expect, it } from "vitest";
import {
	createWorkflowSubmissionTools,
	WORKFLOW_NODE_REMOVE_TOOL_NAME,
	WORKFLOW_NODE_TOOL_NAME,
	WorkflowSubmissionBuilder,
} from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

describe("WorkflowSubmissionBuilder", () => {
	it("normalizes unambiguous Workflow Tool argument representation", () => {
		const workflow = createValidWorkflow();
		const builder = new WorkflowSubmissionBuilder([], {
			skill: workflow.skill,
			globalBudget: { mode: "unbounded" },
			staff: workflow.staff,
		});
		const tools = createWorkflowSubmissionTools(builder);
		const remove = tools.find((tool) => tool.name === WORKFLOW_NODE_REMOVE_TOOL_NAME);
		const node = tools.find((tool) => tool.name === WORKFLOW_NODE_TOOL_NAME);
		expect(remove?.prepareArguments?.({ " nodeId ": "produce" })).toEqual({ nodeId: "produce" });
		expect(node?.prepareArguments?.({ id: "produce", skills: ["injected-by-runtime"] })).toEqual({
			id: "produce",
		});
	});

	it("injects unbounded Node budgets and the default Attempt limit", () => {
		const workflow = createValidWorkflow();
		workflow.globalBudget = { mode: "unbounded" };
		const builder = new WorkflowSubmissionBuilder(
			[
				{
					id: "artifact-exists",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
				},
			],
			{
				skill: workflow.skill,
				globalBudget: workflow.globalBudget,
				staff: workflow.staff,
			},
			workflow,
		);

		const finalized = builder.finalize();
		expect(finalized.nodes[0].budget).toEqual({ mode: "unbounded" });
		expect(finalized.nodes[0].rework.maxAttempts).toBe(10);
	});

	it("removes an obsolete preloaded Node and its Gate", () => {
		const workflow = createValidWorkflow();
		const builder = new WorkflowSubmissionBuilder(
			[
				{
					id: "artifact-exists",
					parameters: Type.Object({ path: Type.String() }, { additionalProperties: false }),
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
