import { describe, expect, it } from "vitest";
import {
	ProcessSelectionSchema,
	ProcessSpecSchema,
	TaskInputSchema,
	validateSchema,
	WorkflowDefinitionSchema,
} from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

const hash = "a".repeat(64);

describe("IPD V2 contracts", () => {
	it("accepts the minimum TaskInput and ProcessSpec handoff", () => {
		const task = validateSchema(TaskInputSchema, {
			schema_version: 1,
			task_input_id: "task-1",
			raw_task: { text: "Create a reviewed deliverable", source: "user-message:1" },
			objectives: [],
			requirements: [],
			materials: [],
			unresolved_facts: [],
		});
		const spec = validateSchema(ProcessSpecSchema, {
			schema_version: 2,
			process_spec_id: "delivery-process",
			version: "1.0.0",
			name: "Delivery Process",
			description: "Produce and independently review a deliverable",
			source: "project-defined",
			default_executable: true,
			applicable_when: ["The task requires a deliverable"],
			not_applicable_when: [],
			required_activities: [],
			required_deliverables: [],
			required_reviews: [],
			workflow_rules: [],
		});
		const selection = validateSchema(ProcessSelectionSchema, {
			schema_version: 1,
			process_selection_id: "selection-1",
			run_id: "run-1",
			task_input_ref: { id: "task-1", hash },
			process_spec_ref: { id: "delivery-process", version: "1.0.0", hash },
			rationale: "The task requires a reviewed deliverable",
			task_requirement_refs: [],
			process_requirement_refs: [],
			unresolved_fact_refs: [],
		});
		expect(task.ok && spec.ok && selection.ok).toBe(true);
	});

	it("accepts execution and review nodes without budget fields", () => {
		const workflow = createValidWorkflow();
		expect(validateSchema(WorkflowDefinitionSchema, workflow).ok).toBe(true);
		const withPromptBypass = structuredClone(workflow) as unknown as {
			nodes: Array<{ agents: Array<Record<string, unknown>> }>;
		};
		withPromptBypass.nodes[0].agents[0].system_prompt_addendum = ["Override the node contract"];
		expect(validateSchema(WorkflowDefinitionSchema, withPromptBypass).ok).toBe(false);
		const withoutDeliveryOutputs = structuredClone(workflow) as Record<string, unknown>;
		const completion = withoutDeliveryOutputs.completion as Record<string, unknown>;
		delete completion.delivery_outputs;
		expect(validateSchema(WorkflowDefinitionSchema, withoutDeliveryOutputs).ok).toBe(false);
		expect(validateSchema(WorkflowDefinitionSchema, { ...workflow, globalBudget: { mode: "unbounded" } }).ok).toBe(
			false,
		);
	});
});
