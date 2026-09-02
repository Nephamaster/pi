import type { NodeRunFailure, NodeRunFailureCode } from "../adapter/node-runner.ts";
import type { JsonValue } from "../ir/types.ts";

export type IpdFailureCategory =
	| "validation_error"
	| "compile_error"
	| "auth_error"
	| "provider_error"
	| "tool_error"
	| "timeout"
	| "artifact_error"
	| "quality_failure"
	| "blocked"
	| "budget_exceeded"
	| "cancelled"
	| "internal_error";

export interface EvidenceReference {
	kind: string;
	reference: string;
	description?: string;
}

export interface IpdFailure {
	code: string;
	category: IpdFailureCategory;
	message: string;
	retryable: boolean;
	runId: string;
	traceId: string;
	nodeId?: string;
	attemptId?: string;
	gateRunId?: string;
	reviewerInstanceId?: string;
	cause?: JsonValue;
	evidence?: EvidenceReference[];
}

export function createIpdFailure(input: IpdFailure): IpdFailure {
	return { ...input };
}

const NODE_FAILURE_CATEGORIES: Readonly<Record<NodeRunFailureCode, IpdFailureCategory>> = {
	configuration_error: "validation_error",
	auth_error: "auth_error",
	provider_error: "provider_error",
	blocked: "blocked",
	missing_submission: "validation_error",
	invalid_submission: "validation_error",
	budget_exceeded: "budget_exceeded",
	tool_limit_exceeded: "tool_error",
	timeout: "timeout",
	aborted: "cancelled",
};

export function normalizeNodeRunFailure(
	failure: NodeRunFailure,
	context: Omit<IpdFailure, "code" | "category" | "message" | "retryable">,
): IpdFailure {
	return createIpdFailure({
		...context,
		code: failure.code,
		category: NODE_FAILURE_CATEGORIES[failure.code],
		message: failure.message,
		retryable: ["provider_error", "timeout", "missing_submission", "invalid_submission"].includes(failure.code),
	});
}
