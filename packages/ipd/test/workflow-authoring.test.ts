import { describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { draftCompleteness } from "../src/control/workflow-draft-completeness.ts";
import { importLegacyDraft, type LegacyDraft, newAuthoringDraft } from "../src/control/workflow-draft-import.ts";
import { checkDraftLinks, draftTopology } from "../src/control/workflow-draft-links.ts";
import { locateDiagnostic, materializeDraft, reviewInputId } from "../src/control/workflow-draft-materialize.ts";
import type { AuthoringDraft, DraftCommand } from "../src/control/workflow-draft-model.ts";
import { applyDraftCommand } from "../src/control/workflow-draft-operations.ts";
import { readDraftView } from "../src/control/workflow-draft-views.ts";
import { createCompilerFixture, createValidWorkflow } from "./fixtures.ts";
import { authorFixture } from "./workflow-authoring-fixtures.ts";

const ref = { node_id: "produce", output_id: "content-output" };
const edit = (draft: AuthoringDraft, command: DraftCommand) => applyDraftCommand(draft, command).draft;
const ready = () => authorFixture(createValidWorkflow());
function legacy(workflow: WorkflowDefinition): LegacyDraft {
	const { nodes, criteria, completion, requirement_coverage, task_input_ref, process_selection_ref, ...header } =
		workflow;
	return {
		draftId: "run-1:workflow-draft",
		runId: "run-1",
		revision: 5,
		trustedReferences: { task_input_ref, process_selection_ref },
		header,
		nodes,
		criteria,
		requirementCoverage: requirement_coverage,
		completion,
		operations: {},
	};
}

describe("partial workflow authoring", () => {
	it("saves an incomplete skeleton without inventing professional content", () => {
		const base = createValidWorkflow();
		const state = newAuthoringDraft("run-1", {
			task_input_ref: base.task_input_ref,
			process_selection_ref: base.process_selection_ref,
		});
		const draft = edit(state, {
			domain: "topology",
			data: { nodes: [{ node_id: "A", kind: "execution", name: "Analysis", output_ids: ["result"] }] },
		});
		expect(draft.nodes[0].agent).toBeUndefined();
		expect(draft.nodes[0].contract).toBeUndefined();
		expect(draft.criteria).toEqual([]);
		expect(draftCompleteness(draft).length).toBeGreaterThan(0);
		expect(draft).not.toHaveProperty("edges");
	});
	it("materializes a complete domain design through the unchanged Compiler", () => {
		const base = createCompilerFixture();
		const draft = authorFixture(base.workflow);
		expect(draftCompleteness(draft)).toEqual([]);
		const workflow = materializeDraft(draft).candidate as WorkflowDefinition;
		expect(compileWorkflow({ ...base, workflow }).ok).toBe(true);
		expect(workflow.nodes[1].inputs[0]).toMatchObject({
			input_id: reviewInputId(ref),
			source: ref,
			required: true,
			purpose: "test_subject",
			availability: "submitted",
		});
		expect(materializeDraft(draft)).toEqual(materializeDraft(structuredClone(draft)));
	});
	it("updates one field without replacing the node, employee or independent reviewer", () => {
		const before = ready();
		const after = edit(before, {
			domain: "configure_nodes",
			data: { nodes: [{ node_id: "produce", contract: { work_requirements: ["Submit when sufficient"] } }] },
		});
		expect(after.nodes[0].agent).toEqual(before.nodes[0].agent);
		expect(after.nodes[1]).toEqual(before.nodes[1]);
		expect(before.nodes[0].contract?.work_requirements).toEqual(["Use the supplied material"]);
	});
	it("keeps an explicitly cleared required array incomplete", () => {
		const after = edit(ready(), {
			domain: "configure_nodes",
			data: { nodes: [{ node_id: "produce", contract: { responsibilities: [] } }] },
		});
		expect(after.nodes[0].contract?.responsibilities).toEqual([]);
		expect(draftCompleteness(after).some((item) => item.path.includes("responsibilities"))).toBe(true);
	});
	it("clears only an optional environment override", () => {
		let draft = edit(ready(), {
			domain: "configure_nodes",
			data: { nodes: [{ node_id: "produce", environment_ref: { id: "general-purpose", version: "1.0.0" } }] },
		});
		draft = edit(draft, {
			domain: "configure_nodes",
			data: { nodes: [{ node_id: "produce", environment_ref: null }] },
		});
		expect(draft.nodes[0].environment_ref).toBeUndefined();
	});
	it("rolls back a batch and never mutates the caller's state", () => {
		const state = ready();
		const original = structuredClone(state);
		expect(() =>
			edit(state, {
				domain: "configure_nodes",
				data: {
					nodes: [
						{ node_id: "produce", name: "Changed" },
						{ node_id: "missing", name: "Bad" },
					],
				},
			}),
		).toThrow();
		expect(state).toEqual(original);
	});
	it("rejects duplicate identities and kind replacement", () => {
		expect(() =>
			edit(ready(), {
				domain: "configure_nodes",
				data: {
					nodes: [
						{ node_id: "produce", name: "A" },
						{ node_id: "produce", name: "B" },
					],
				},
			}),
		).toThrow();
		expect(() =>
			edit(ready(), {
				domain: "topology",
				data: { nodes: [{ node_id: "produce", kind: "review", name: "Replaced" }] },
			}),
		).toThrow();
	});
	it("refuses referenced output and criterion deletion", () => {
		expect(() => edit(ready(), { domain: "outputs", data: { remove: [ref] } })).toThrow(/references/);
		expect(() => edit(ready(), { domain: "criteria", data: { remove_ids: ["quality"] } })).toThrow(/references/);
	});
	it("requires explicit input use choices and rejects hidden topology reconnection", () => {
		let draft = edit(ready(), {
			domain: "topology",
			data: {
				connections: [
					{ consumer_node_id: "review-produce", input_id: "explicit", source: { kind: "node_output", ...ref } },
				],
			},
		});
		expect(draftCompleteness(draft).some((item) => item.path.includes("explicit"))).toBe(true);
		draft = edit(draft, {
			domain: "inputs",
			data: {
				upsert: [
					{
						consumer_node_id: "review-produce",
						input_id: "explicit",
						required: true,
						purpose: "test_subject",
						access: { mode: "review_candidate" },
					},
				],
			},
		});
		expect(() =>
			edit(draft, {
				domain: "topology",
				data: {
					connections: [
						{
							consumer_node_id: "review-produce",
							input_id: "explicit",
							source: { kind: "task_material", material_id: "brief" },
						},
					],
				},
			}),
		).toThrow(/reconnect/i);
	});
	it("preserves explicit required candidate reads instead of duplicating them", () => {
		const draft = edit(ready(), {
			domain: "inputs",
			data: {
				upsert: [
					{
						consumer_node_id: "review-produce",
						input_id: "candidate",
						source: { kind: "node_output", ...ref },
						required: true,
						purpose: "test_subject",
						access: { mode: "review_candidate" },
					},
				],
			},
		});
		const workflow = materializeDraft(draft).candidate as WorkflowDefinition;
		expect(workflow.nodes[1].inputs).toHaveLength(1);
		expect(workflow.nodes[1].inputs[0].input_id).toBe("candidate");
	});
	it("does not accept an optional explicit target read", () => {
		const draft = edit(ready(), {
			domain: "inputs",
			data: {
				upsert: [
					{
						consumer_node_id: "review-produce",
						input_id: "candidate",
						source: { kind: "node_output", ...ref },
						required: false,
						purpose: "test_subject",
						access: { mode: "review_candidate" },
					},
				],
			},
		});
		expect(() => materializeDraft(draft)).toThrow(/required/);
	});
	it("rejects reserved generated IDs and execution review-candidate access", () => {
		expect(() =>
			edit(ready(), {
				domain: "inputs",
				data: {
					upsert: [
						{
							consumer_node_id: "review-produce",
							input_id: reviewInputId(ref),
							source: { kind: "task_material", material_id: "brief" },
						},
					],
				},
			}),
		).toThrow();
		expect(() =>
			edit(ready(), {
				domain: "inputs",
				data: {
					upsert: [
						{
							consumer_node_id: "produce",
							input_id: "bad",
							source: { kind: "node_output", ...ref },
							access: { mode: "review_candidate" },
						},
					],
				},
			}),
		).toThrow();
	});
	it("does not turn legal rework into a forward edge", () => {
		const state = ready();
		expect(draftTopology(state).edges.some((edge) => edge.from === "review-produce" && edge.to === "produce")).toBe(
			false,
		);
		expect(() =>
			edit(state, {
				domain: "inputs",
				data: {
					upsert: [
						{
							consumer_node_id: "produce",
							input_id: "cycle",
							source: { kind: "node_output", ...ref },
							required: true,
							purpose: "content_basis",
							access: { mode: "approved", review_node_ids: ["review-produce"] },
						},
					],
				},
			}),
		).toThrow(/cycle/i);
	});
	it("derives stage uses from the same input record", () => {
		let draft = edit(ready(), {
			domain: "topology",
			data: { nodes: [{ node_id: "B", kind: "execution", name: "Consume", output_ids: ["result"] }] },
		});
		draft = edit(draft, {
			domain: "stages",
			data: {
				upsert: [
					{
						stage_id: "S",
						member_node_ids: ["produce", "B"],
						exits: [{ output: ref, gate_node_ids: ["review-produce"] }],
					},
				],
			},
		});
		draft = edit(draft, {
			domain: "inputs",
			data: {
				upsert: [
					{
						consumer_node_id: "B",
						input_id: "basis",
						source: { kind: "node_output", ...ref },
						required: true,
						purpose: "content_basis",
						access: { mode: "stage_candidate", stage_id: "S" },
					},
				],
			},
		});
		const workflow = materializeDraft(draft).candidate as WorkflowDefinition;
		expect(workflow.stages?.[0].internal_uses).toEqual([{ consumer_node_id: "B", input_id: "basis" }]);
		expect(() =>
			edit(draft, { domain: "stages", data: { upsert: [{ stage_id: "S", member_node_ids: ["produce"] }] } }),
		).toThrow(/members/);
	});
	it("derives composite subjects without imposing a joint standard on each producer", () => {
		const other = { node_id: "D", output_id: "other" };
		let draft = edit(ready(), {
			domain: "topology",
			data: { nodes: [{ node_id: "D", kind: "execution", name: "Independent", output_ids: ["other"] }] },
		});
		draft = edit(draft, {
			domain: "criteria",
			data: { upsert: [{ criterion_id: "joint", definition: { kind: "semantic" }, output_bindings: [] }] },
		});
		draft = edit(draft, {
			domain: "reviews",
			data: {
				upsert: [
					{
						review_node_id: "review-produce",
						assignments: [{ criterion_id: "joint", mode: "composite", subjects: [ref, other] }],
						allowed_rework_node_ids: ["produce", "D"],
					},
				],
			},
		});
		const workflow = materializeDraft(draft).candidate as WorkflowDefinition;
		const reviewer = workflow.nodes[1];
		if (reviewer.kind !== "review") throw new Error("Unexpected fixture node");
		expect(reviewer.criterion_subjects?.[0].targets).toEqual([other, ref]);
		expect(draft.criteria.find((item) => item.criterion_id === "joint")?.output_bindings).toEqual([]);
	});
	it("retains original V3 purposes and explicit IDs on legacy import", () => {
		const workflow = createValidWorkflow();
		expect(materializeDraft(importLegacyDraft(legacy(workflow))).candidate).toEqual(workflow);
	});
	it("preserves explicit empty optional fields and single-subject declarations", () => {
		const workflow = createValidWorkflow();
		workflow.stages = [];
		workflow.requirements = [];
		workflow.decisions = [];
		const reviewer = workflow.nodes[1];
		if (reviewer.kind !== "review") throw new Error("Unexpected fixture node");
		reviewer.criterion_subjects = [{ criterion_id: "quality", targets: [ref] }];
		expect(materializeDraft(importLegacyDraft(legacy(workflow))).candidate).toEqual(workflow);
	});
	it("refuses legacy multi-member collapse and missing candidate binding", () => {
		const multi = createValidWorkflow();
		multi.nodes[0].agents.push(structuredClone(multi.nodes[0].agents[0]));
		expect(() => importLegacyDraft(legacy(multi))).toThrow(/multi-member/);
		const missing = createValidWorkflow();
		missing.nodes[1].inputs = [];
		expect(() => importLegacyDraft(legacy(missing))).toThrow(/candidate binding/);
	});
	it("does not fill a legacy missing header with new-run defaults", () => {
		const old = legacy(createValidWorkflow());
		delete old.header;
		const draft = importLegacyDraft(old);
		expect(draft.metadata.workflow_id).toBeUndefined();
		expect(draftCompleteness(draft).some((item) => item.path.includes("workflow_id"))).toBe(true);
	});
	it("maps diagnostics to the responsible authoring editor", () => {
		const output = materializeDraft(ready());
		const mapped = locateDiagnostic(
			{ path: "/nodes/0/outputs/0/path_prefix", message: "Invalid path" },
			output.sourceMap,
		);
		expect(mapped.authoringPath).toBe("output:produce/content-output");
		expect(mapped.suggestedTool).toBe("workflow_draft_outputs");
	});
	it("requires scoped reads and excludes full state from summary", () => {
		expect(() => readDraftView(ready(), { view: "nodes" })).toThrow();
		const result = JSON.stringify(readDraftView(ready(), { view: "summary" }));
		expect(result).not.toContain("trustedReferences");
		expect(result).not.toContain('"operations"');
	});
	it("pages long Unicode records losslessly and rejects stale cursors", () => {
		const draft = ready();
		draft.nodes[0].contract!.objective = "证据🙂".repeat(8000);
		const request = { view: "nodes" as const, node_ids: ["produce"], sections: ["contract" as const] };
		let page = readDraftView(draft, request);
		let text = "";
		let count = 0;
		const first = page;
		while (true) {
			text += page.fragment?.text ?? "";
			if (!page.next_cursor) break;
			expect(++count).toBeLessThan(20);
			page = readDraftView(draft, { ...request, cursor: page.next_cursor });
		}
		expect(JSON.parse(text).contract.objective).toBe(draft.nodes[0].contract.objective);
		expect(() =>
			readDraftView({ ...draft, revision: draft.revision + 1 }, { ...request, cursor: first.next_cursor! }),
		).toThrow(/cursor/i);
	});
	it("keeps graph and read projections pure", () => {
		const draft = ready();
		const original = structuredClone(draft);
		checkDraftLinks(draft, draft);
		draftTopology(draft);
		materializeDraft(draft);
		readDraftView(draft, { view: "topology" });
		expect(draft).toEqual(original);
	});
});
