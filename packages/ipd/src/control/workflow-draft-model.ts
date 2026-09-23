// Authoring-only types. Partial drafts never constitute executable Workflows.

import type { Static } from "typebox";
import type { JsonValue } from "../contracts/primitives.ts";
import type {
	CriterionDefinition,
	ExecutionNode,
	NodeAgentConfigSchema,
	NodeInput,
	NodeOutputRef,
	ReviewNode,
	WorkflowDefinition,
	WorkflowNode,
} from "../contracts/workflow.ts";

export const AUTHORING_VERSION = 2;
export const AUTHORING_POLICY = "workflow-authoring-v2.1";
export type AgentConfig = Static<typeof NodeAgentConfigSchema>;
export type DraftContract = Partial<ExecutionNode["contract"]>;
export type DraftAgent = Partial<Omit<AgentConfig, "permissions">> & {
	permissions?: Partial<AgentConfig["permissions"]>;
};
export type DraftOutput = Pick<ExecutionNode["outputs"][number], "output_id"> &
	Partial<Omit<ExecutionNode["outputs"][number], "output_id" | "criterion_refs">>;
export type InputPurpose = NonNullable<Extract<NodeInput, { kind: "node_output" }>["purpose"]>;
export type DraftAccess =
	| { mode: "approved"; review_node_ids: string[] }
	| { mode: "stage_candidate"; stage_id: string }
	| { mode: "review_candidate" };
export type DraftInput =
	| { kind: "task_material"; input_id: string; material_id: string; required?: boolean }
	| {
			kind: "node_output";
			input_id: string;
			source: NodeOutputRef;
			required?: boolean;
			purpose?: InputPurpose;
			access?: DraftAccess;
			omit_default_purpose?: true;
	  };
export interface ReviewAssignment {
	criterion_id: string;
	mode: "single" | "composite";
	subjects: NodeOutputRef[];
}
export interface DraftReview {
	assignments?: ReviewAssignment[];
	explicit_subject_criteria?: string[];
	allowed_rework_node_ids?: string[];
	required_relations?: ReviewNode["required_relations"];
	remediation_mappings?: ReviewNode["remediation_mappings"];
	decision_policy?: ReviewNode["decision_policy"];
}
export interface DraftNode {
	node_id: string;
	kind: "execution" | "review";
	name: string;
	contract?: DraftContract;
	agent?: DraftAgent;
	environment_ref?: WorkflowNode["environment_ref"];
	outputs: DraftOutput[];
	inputs: DraftInput[];
	review_plan?: DraftReview;
}
export type DraftCriterionDefinition =
	| Partial<Omit<Extract<CriterionDefinition, { kind: "mechanical" }>, "criterion_id">>
	| Partial<Omit<Extract<CriterionDefinition, { kind: "semantic" }>, "criterion_id">>;
export interface DraftCriterion {
	criterion_id: string;
	definition: DraftCriterionDefinition;
	output_bindings: NodeOutputRef[];
}
export type DraftStage = Pick<NonNullable<WorkflowDefinition["stages"]>[number], "stage_id"> &
	Partial<Pick<NonNullable<WorkflowDefinition["stages"]>[number], "member_node_ids" | "exits">>;
export type DraftMetadata = Partial<Pick<WorkflowDefinition, "workflow_id" | "workflow_version" | "name">>;
export type DraftTrustedReferences = Pick<WorkflowDefinition, "task_input_ref" | "process_selection_ref">;
export interface DraftDiagnostic {
	code?: string;
	path: string;
	message: string;
	nodeId?: string;
	processRequirementId?: string;
	category?: string;
	authoringPath?: string;
	suggestedTool?: string;
}
export interface DraftReceipt {
	operation_id: string;
	applied_revision: number;
	changed: string[];
	defaults_applied: string[];
	candidate_hash?: string;
	candidate_file?: string;
}
export interface AuthoringDraft {
	draft_schema_version: 2;
	authoringPolicy: typeof AUTHORING_POLICY;
	draftId: string;
	runId: string;
	revision: number;
	trustedReferences: DraftTrustedReferences;
	metadata: DraftMetadata;
	nodes: DraftNode[];
	criteria: DraftCriterion[];
	stage_plans: DraftStage[];
	prerequisites?: WorkflowDefinition["prerequisites"];
	requirements: NonNullable<WorkflowDefinition["requirements"]>;
	decisions: NonNullable<WorkflowDefinition["decisions"]>;
	process_coverage: WorkflowDefinition["requirement_coverage"];
	completion?: Partial<WorkflowDefinition["completion"]>;
	editing: boolean;
	closureReason?: "captured" | "control_closed";
	emptyOptionalSections?: ("stages" | "requirements" | "decisions")[];
	lastValidation?: { revision: number; valid: boolean; mode: "draft" | "compile"; diagnostics: DraftDiagnostic[] };
	lastSubmission?: DraftReceipt;
	operations: Record<string, { requestHash: string; protocol: string; receipt: DraftReceipt }>;
	legacyOperations?: Record<string, { requestHash: string; revision: number }>;
	migration?: { sourceHash: string; sourceRevision: number; backupFile: string };
}
export type InputSource = { kind: "task_material"; material_id: string } | ({ kind: "node_output" } & NodeOutputRef);
export interface InputEdit {
	consumer_node_id: string;
	input_id: string;
	source?: InputSource;
	required?: boolean;
	purpose?: InputPurpose;
	access?: DraftAccess;
}
export interface NodeEdit {
	node_id: string;
	name?: string;
	contract?: DraftContract;
	employee?: Pick<DraftAgent, "participant_id" | "agent_ref">;
	resources?: Omit<DraftAgent, "participant_id" | "agent_ref">;
	environment_ref?: WorkflowNode["environment_ref"] | null;
}
export interface DraftCommands {
	topology: {
		nodes?: { node_id: string; kind: DraftNode["kind"]; name: string; output_ids?: string[] }[];
		connections?: (Pick<InputEdit, "consumer_node_id" | "input_id"> & { source: InputSource })[];
		remove_node_ids?: string[];
	};
	configure_nodes: { nodes: NodeEdit[] };
	outputs: { upsert?: (DraftOutput & { node_id: string })[]; remove?: NodeOutputRef[] };
	criteria: {
		upsert?: { criterion_id: string; definition?: DraftCriterionDefinition; output_bindings?: NodeOutputRef[] }[];
		remove_ids?: string[];
	};
	inputs: { upsert?: InputEdit[]; remove?: Pick<InputEdit, "consumer_node_id" | "input_id">[] };
	reviews: {
		upsert: (Omit<DraftReview, "decision_policy"> & {
			review_node_id: string;
			decision_policy?: DraftReview["decision_policy"] | null;
		})[];
	};
	stages: { upsert?: DraftStage[]; remove_ids?: string[] };
	governance: {
		metadata?: Partial<DraftMetadata>;
		prerequisites?: WorkflowDefinition["prerequisites"] | null;
		requirements?: {
			upsert?: AuthoringDraft["requirements"];
			patch?: (Partial<AuthoringDraft["requirements"][number]> & { requirement_id: string })[];
			from_process?: {
				requirement_id: string;
				source_id: string;
				strength: "required" | "advisory";
				description?: string;
			}[];
			remove_ids?: string[];
		};
		decisions?: { upsert?: AuthoringDraft["decisions"]; remove_ids?: string[] };
	};
	coverage: {
		upsert?: AuthoringDraft["process_coverage"];
		remove?: Pick<AuthoringDraft["process_coverage"][number], "source" | "requirement_id">[];
	};
	completion: Partial<WorkflowDefinition["completion"]>;
}
export type DraftDomain = keyof DraftCommands;
export type DraftCommand = { [K in DraftDomain]: { domain: K; data: DraftCommands[K] } }[DraftDomain];
export interface DraftExternalViews {
	catalog?: JsonValue;
	process?: JsonValue;
	materialIds?: readonly string[];
}
export class DraftError extends Error {
	readonly diagnostics: DraftDiagnostic[];
	constructor(code: string, path: string, message: string, diagnostics?: DraftDiagnostic[]) {
		super(message);
		this.name = "DraftError";
		this.diagnostics = diagnostics ?? [{ code, path, message, category: "error" }];
	}
}
export const outputKey = (ref: NodeOutputRef): string => `${ref.node_id}/${ref.output_id}`;
