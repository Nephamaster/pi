// Designer-facing domain tools. They never accept a complete Workflow or Node object.
import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import Type, { type TSchema } from "typebox";
import { IdentifierSchema, NonEmptyStringSchema } from "../contracts/primitives.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { toJsonValue } from "../ir/hash.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import type { WorkflowDraftManager } from "./workflow-draft.ts";
import { type DraftDomain, type DraftExternalViews, DraftError } from "./workflow-draft-model.ts";
import { DraftCommandSchemas, MutationEnvelopeSchema } from "./workflow-draft-schema.ts";
import { DRAFT_VIEW_NAMES, type DraftReadRequest, draftSummary, readDraftView } from "./workflow-draft-views.ts";

export interface WorkflowDraftToolset {
	tools: ToolDefinition[];
	getSubmitted(): WorkflowDefinition | undefined;
	resetSubmitted(): void;
	close(): Promise<void>;
}
const object = <P extends Record<string, TSchema>>(properties: P) => Type.Object(properties, { additionalProperties: false });
const ids = Type.Optional(Type.Array(IdentifierSchema, { minItems: 1, maxItems: 64, uniqueItems: true }));
const ReadSchema = Type.Unsafe<DraftReadRequest>(object({
	view: Type.Optional(Type.Union(DRAFT_VIEW_NAMES.map((name) => Type.Literal(name)))),
	node_ids: ids, criterion_ids: ids, ids,
	sections: Type.Optional(Type.Array(Type.Union(["identity", "contract", "agent", "outputs", "inputs", "review"].map((name) => Type.Literal(name))), { uniqueItems: true })),
	kind: Type.Optional(NonEmptyStringSchema), source: Type.Optional(NonEmptyStringSchema), query: Type.Optional(NonEmptyStringSchema), category: Type.Optional(NonEmptyStringSchema), operation_id: Type.Optional(NonEmptyStringSchema),
	limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 50 })), cursor: Type.Optional(NonEmptyStringSchema),
}));
const descriptions: Record<DraftDomain, string> = {
	topology: "Declare work packages, output ports and real input connections in a small batch. Incomplete skeletons are allowed. No separate edge graph is stored; use inputs to reconnect existing links.",
	configure_nodes: "Update only the supplied contract, employee, resource or environment fields of declared nodes. Omitted fields remain unchanged; supplied arrays replace that field. environment_ref=null removes an override.",
	outputs: "Define output substance, artifact type, purpose, evidence and path by node/output ID. criterion_refs are generated from criterion output_bindings, not edited here. Referenced ports cannot be deleted.",
	criteria: "Define mechanical or semantic criteria and their production output_bindings. Update only supplied fields. Review-only composite standards may have no production bindings; do not invent thresholds or grant approvals.",
	inputs: "Configure declared task materials or node-output use. required and node-output purpose/access must be explicit before compilation. Select approved Gates, a declared stage_candidate, or review_candidate for reviews.",
	reviews: "Assign semantic criteria to exact single/composite subjects; set legal rework owners and relations. Code derives targets, subject sets and required candidate-reading inputs. No ancestor-wide automatic rework.",
	stages: "Configure stage members and controlled exits. internal_uses is derived from stage_candidate inputs. No silent Gate removal or automatic change to completion.",
	governance: "Edit metadata, prerequisites and source-linked requirements/design decisions. Arrays replace only their field; null clears prerequisites. Preserve raw task and selected ProcessSpec; never invent formal user-task coverage.",
	coverage: "Upsert or remove individual ProcessSpec coverage rows keyed by source and requirement_id. Do not rewrite unrelated rows or fabricate substantive governance coverage.",
	completion: "Update supplied completion fields only: required nodes/reviews, final outputs and user-facing delivery outputs. Do not infer success from one file or automatically mark all nodes optional.",
};
function result(value: unknown, error = false) {
	const details = toJsonValue(value);
	return { content: [{ type: "text" as const, text: wrapPromptBlock(error ? "workflow_draft_error" : "workflow_draft_result", JSON.stringify(details)) }], details };
}
async function guarded(action: () => Promise<ReturnType<typeof result>>) {
	try { return await action(); }
	catch (error) {
		if (!(error instanceof DraftError)) throw error;
		return result({ captured: false, saved: false, message: error.message, diagnostics: error.diagnostics.slice(0, 12), diagnostic_count: error.diagnostics.length, truncated: error.diagnostics.length > 12 }, true);
	}
}
export function createWorkflowDraftTools(manager: WorkflowDraftManager, runId: string, context: DraftExternalViews = {}): WorkflowDraftToolset {
	manager.setContext(context);
	let submitted: WorkflowDefinition | undefined;
	const tools: ToolDefinition[] = [
		defineTool({ name: "workflow_draft_open", label: "Open Workflow Draft", description: "Open the single managed authoring draft. Returns defaults, revision and missing choices, not the complete Workflow.", parameters: object({}), executionMode: "sequential", async execute() { return guarded(async () => result(draftSummary(await manager.open(runId)))); } }),
		defineTool({ name: "workflow_draft_read", label: "Read Workflow Draft View", description: "Read a bounded scoped view. nodes requires node_ids. Follow next_cursor with the same selection; oversized items are lossless JSON text fragments. A changed revision/view/catalog invalidates the cursor.", parameters: ReadSchema, executionMode: "sequential", async execute(_callId, input) { return guarded(async () => result(readDraftView(await manager.read(), input, manager.getContext()))); } }),
	];
	for (const domain of Object.keys(DraftCommandSchemas) as DraftDomain[]) {
		const schema = Type.Unsafe<{ expected_revision: number; operation_id: string } & Record<string, unknown>>(object({ ...MutationEnvelopeSchema.properties, ...DraftCommandSchemas[domain].properties }));
		tools.push(defineTool({
			name: `workflow_draft_${domain}`, label: `Workflow Draft: ${domain}`, description: descriptions[domain], parameters: schema, executionMode: "sequential",
			async execute(_callId, input) {
				return guarded(async () => {
					const { expected_revision, operation_id, ...data } = input;
					const receipt = await manager.edit(expected_revision, operation_id, { domain, data });
					return result({ ...receipt, changed: receipt.changed.slice(0, 20), defaults_applied: receipt.defaults_applied.slice(0, 20), receipt_truncated: receipt.changed.length > 20 || receipt.defaults_applied.length > 20, receipt_view: { view: "operation", operation_id }, summary: draftSummary(await manager.read()) });
				});
			},
		}));
	}
	tools.push(defineTool({
		name: "workflow_draft_validate", label: "Validate Workflow Draft", description: "Check missing draft choices or run the existing full Compiler for the exact revision. Never returns the full Workflow. Read validation for paginated diagnostics. Draft completeness is not execution approval.",
		parameters: object({ expected_revision: Type.Integer({ minimum: 0 }), mode: Type.Optional(Type.Union([Type.Literal("draft"), Type.Literal("compile")])) }), executionMode: "sequential",
		async execute(_callId, input) { return guarded(async () => {
			const validation = await manager.validate(input.expected_revision, input.mode ?? "compile");
			return result({ revision: validation.revision, mode: validation.mode, valid: validation.valid, diagnostics: validation.diagnostics.slice(0, 12), diagnostic_count: validation.diagnostics.length, truncated: validation.diagnostics.length > 12, more: { tool: "workflow_draft_read", view: "validation" } });
		}); },
	}));
	tools.push(defineTool({
		name: "workflow_draft_submit", label: "Submit Workflow Draft", description: "Revalidate and durably capture the exact revision with a stable operation ID. Returns a compact receipt and ends this design turn, not the Run. Later edits require trusted control to reopen this same draft.",
		parameters: MutationEnvelopeSchema, executionMode: "sequential",
		async execute(_callId, input) { return guarded(async () => {
			const captured = await manager.submitRevision(input.expected_revision, input.operation_id);
			submitted = captured.workflow;
			return { ...result({ ...captured.receipt, status: "candidate_captured_for_independent_compilation" }), terminate: true };
		}); },
	}));
	return { tools, getSubmitted: () => submitted, resetSubmitted: () => { submitted = undefined; }, close: () => manager.close() };
}
