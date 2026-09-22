// Programmatic compatibility for existing callers; never registered as a designer tool.
import type { CriterionDefinition, WorkflowDefinition, WorkflowNode } from "../contracts/workflow.ts";
import { importLegacyDraft, type LegacyDraft } from "./workflow-draft-import.ts";
import { materializeDraft } from "./workflow-draft-materialize.ts";
import type { AuthoringDraft } from "./workflow-draft-model.ts";
import { DraftError } from "./workflow-draft-model.ts";

export type WorkflowDraftHeader = Pick<
	WorkflowDefinition,
	"schema_version" | "workflow_id" | "workflow_version" | "name"
> &
	Partial<Pick<WorkflowDefinition, "prerequisites" | "stages" | "requirements" | "decisions">>;
export type WorkflowDraftOperation =
	| { kind: "set_header"; header: WorkflowDraftHeader }
	| { kind: "upsert_node"; node: WorkflowNode }
	| { kind: "remove_node"; node_id: string }
	| { kind: "upsert_criterion"; criterion: CriterionDefinition }
	| { kind: "set_requirement_coverage"; coverage: WorkflowDefinition["requirement_coverage"] }
	| { kind: "set_completion"; completion: WorkflowDefinition["completion"] };

export function applyLegacyOperations(
	state: AuthoringDraft,
	operations: readonly WorkflowDraftOperation[],
): AuthoringDraft {
	if (Object.values(state.operations).some((operation) => operation.protocol === "authoring-v2"))
		throw new DraftError(
			"legacy_writer_disabled",
			"/",
			"Legacy whole-object operations cannot overwrite a domain-authored draft.",
		);
	const current = materializeDraft(state).candidate as unknown as Partial<WorkflowDefinition>;
	const {
		nodes = [],
		criteria = [],
		requirement_coverage = [],
		completion,
		task_input_ref: _task,
		process_selection_ref: _selection,
		...header
	} = current;
	const legacy: LegacyDraft = {
		draftId: state.draftId,
		runId: state.runId,
		revision: state.revision,
		trustedReferences: state.trustedReferences,
		header,
		nodes,
		criteria,
		requirementCoverage: requirement_coverage,
		completion,
		operations: state.legacyOperations ?? {},
	};
	const upsert = <T>(items: T[], value: T, key: (item: T) => string) => {
		const index = items.findIndex((item) => key(item) === key(value));
		if (index < 0) items.push(structuredClone(value));
		else items[index] = structuredClone(value);
	};
	for (const operation of operations) {
		switch (operation.kind) {
			case "set_header":
				legacy.header = structuredClone(operation.header);
				break;
			case "upsert_node":
				upsert(legacy.nodes, operation.node, (node) => node.node_id);
				break;
			case "remove_node":
				legacy.nodes = legacy.nodes.filter((node) => node.node_id !== operation.node_id);
				break;
			case "upsert_criterion":
				upsert(legacy.criteria, operation.criterion, (criterion) => criterion.criterion_id);
				break;
			case "set_requirement_coverage":
				legacy.requirementCoverage = structuredClone(operation.coverage);
				break;
			case "set_completion":
				legacy.completion = structuredClone(operation.completion);
				break;
		}
	}
	const imported = importLegacyDraft(legacy);
	imported.operations = structuredClone(state.operations);
	return imported;
}
