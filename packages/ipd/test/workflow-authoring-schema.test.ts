import { describe, expect, it } from "vitest";
import {
	ExecutionNodeSchema,
	NodeAgentConfigSchema,
	OutputDefinitionSchema,
	WorkflowDefinitionSchema,
} from "../src/contracts/workflow.ts";
import { importLegacyDraft } from "../src/control/workflow-draft-import.ts";
import {
	AuthoringDraftSchema,
	DraftAgentSchema,
	DraftCommandSchema,
	DraftContractSchema,
	DraftOutputSchema,
} from "../src/control/workflow-draft-schema.ts";
import { validateSchema } from "../src/ir/validation.ts";
import { createValidWorkflow } from "./fixtures.ts";

describe("authoring Schema metadata preservation", () => {
	it("accepts actual employee and output fields without widening permissions", () => {
		const workflow = createValidWorkflow();
		const producer = workflow.nodes[0];
		if (producer.kind !== "execution") throw new Error("Invalid fixture");
		const { criterion_refs: _refs, ...output } = producer.outputs[0];
		expect(validateSchema(DraftAgentSchema, producer.agents[0]).ok).toBe(true);
		expect(validateSchema(DraftOutputSchema, output).ok).toBe(true);
		expect(validateSchema(DraftAgentSchema, { ...producer.agents[0], system_prompt_addendum: "bypass" }).ok).toBe(
			false,
		);
		expect(validateSchema(DraftOutputSchema, { ...output, artifact_type: 42 }).ok).toBe(false);
	});
	it("defers draft completeness without mutating the execution contract", () => {
		const workflow = createValidWorkflow();
		const contract = { ...workflow.nodes[0].contract, responsibilities: [] };
		expect(validateSchema(DraftContractSchema, contract).ok).toBe(true);
		expect(validateSchema(ExecutionNodeSchema.properties.contract, contract).ok).toBe(false);
		expect(ExecutionNodeSchema.properties.contract.properties.responsibilities.minItems).toBe(1);
		expect(validateSchema(NodeAgentConfigSchema, {}).ok).toBe(false);
		expect(validateSchema(OutputDefinitionSchema, { output_id: "x" }).ok).toBe(false);
		expect(validateSchema(WorkflowDefinitionSchema, workflow).ok).toBe(true);
	});
	it("retains domain parameter types and rejects mixed or injected fields", () => {
		expect(
			validateSchema(DraftCommandSchema, {
				domain: "configure_nodes",
				data: { nodes: [{ node_id: "produce", employee: { agent_ref: { id: "producer", version: "1.0.0" } } }] },
			}).ok,
		).toBe(true);
		expect(
			validateSchema(DraftCommandSchema, {
				domain: "configure_nodes",
				data: { nodes: [{ node_id: "produce", employee: { agent_ref: { id: "producer", version: 3 } } }] },
			}).ok,
		).toBe(false);
		expect(
			validateSchema(DraftCommandSchema, {
				domain: "outputs",
				data: { upsert: [{ node_id: "produce", output_id: "out", criterion_refs: ["hidden"] }] },
			}).ok,
		).toBe(false);
	});
	it("can persist a lossless imported fixture with original strict fields", () => {
		const { nodes, criteria, completion, requirement_coverage, task_input_ref, process_selection_ref, ...header } =
			createValidWorkflow();
		const draft = importLegacyDraft({
			draftId: "run-1:workflow-draft",
			runId: "run-1",
			revision: 1,
			trustedReferences: { task_input_ref, process_selection_ref },
			header,
			nodes,
			criteria,
			requirementCoverage: requirement_coverage,
			completion,
			operations: {},
		});
		const result = validateSchema(AuthoringDraftSchema, draft);
		expect(result.ok ? [] : result.diagnostics).toEqual([]);
	});
});
