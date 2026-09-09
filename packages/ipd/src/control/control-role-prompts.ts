import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSelection, ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import { canonicalJson } from "../ir/hash.ts";

export function buildInitialWorkflowDesignPrompt(
	runSkillId: string,
	task: TaskInput,
	selection: ProcessSelection,
	spec: ProcessSpec,
	assetSummary: JsonValue,
	compilerDiagnostics: readonly string[],
): string {
	return `/skill:${runSkillId} Load the task-specific method, then design this Workflow.\n\nTaskInput:\n${canonicalJson(task)}\n\nProcessSelection:\n${canonicalJson(selection)}\n\nProcessSpec:\n${canonicalJson(spec)}\n\nAvailable non-employee resources:\n${canonicalJson(assetSummary)}\n\nSearch and inspect AgentCards before binding employees.\n\nCompiler diagnostics:\n${compilerDiagnostics.length > 0 ? compilerDiagnostics.join("\n") : "None"}`;
}

export function buildWorkflowDesignRevisionPrompt(
	draftRevision: number,
	compilerDiagnostics: readonly string[],
): string {
	return `Draft revision: ${draftRevision}\n\nCompiler diagnostics:\n${compilerDiagnostics.length > 0 ? compilerDiagnostics.join("\n") : "None"}\n\nRevise the existing draft and submit the corrected revision.`;
}
