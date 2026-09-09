import type { TSchema } from "typebox";
import type { WorkflowDefinition } from "../contracts/workflow.ts";

export type IpdDiagnosticCode =
	| "schema_invalid"
	| "asset_collision"
	| "invalid_scope"
	| "explicit_model_incomplete"
	| "unknown_model"
	| "unknown_skill"
	| "unknown_tool"
	| "unknown_check"
	| "check_parameters_invalid"
	| "duplicate_id"
	| "permission_exceeded"
	| "artifact_path_invalid"
	| "artifact_missing"
	| "artifact_type_invalid"
	| "artifact_content_invalid"
	| "artifact_size_mismatch"
	| "artifact_hash_mismatch";

export interface IpdDiagnostic {
	code: IpdDiagnosticCode;
	path: string;
	message: string;
	source?: string;
	nodeId?: string;
}

export interface AgentCardCompileContext {
	skillNames: ReadonlySet<string>;
	toolNames: ReadonlySet<string>;
	hasModel(provider: string, modelId: string): boolean;
}

export interface CheckDefinition {
	id: string;
	parameters: TSchema;
}

export interface WorkflowAssetRecord {
	workflow: WorkflowDefinition;
	hash: string;
	source: string;
}

export interface ParsedAsset<T> {
	value?: T;
	diagnostics: IpdDiagnostic[];
}
