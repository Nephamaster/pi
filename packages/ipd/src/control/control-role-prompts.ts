// 构造流程选择和工作流设计各轮的控制消息。
import type { JsonValue } from "../contracts/primitives.ts";
import type { ProcessSelection, ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import { canonicalJson } from "../ir/hash.ts";
import { wrapPromptBlock } from "../prompt/block.ts";

export function buildProcessSelectionPrompt(selectionSkillId: string, task: TaskInput): string {
	return `/skill:${selectionSkillId} ${wrapPromptBlock(
		"process_selection_assignment",
		`Load the process-selection method, evaluate this TaskInput, inspect serious ProcessSpec candidates through the catalog tools, and submit one decision.\n\nTaskInput:\n${canonicalJson(task)}`,
	)}`;
}

export function buildWorkflowDesignMethodPrompt(designSkillId: string): string {
	return `/skill:${designSkillId} ${wrapPromptBlock(
		"workflow_design_method_request",
		"Load the workflow design method. Do not submit a Workflow yet.",
	)}`;
}

export function buildInitialWorkflowDesignPrompt(
	runSkillId: string | undefined,
	task: TaskInput,
	selection: ProcessSelection,
	spec: ProcessSpec,
	assetSummary: JsonValue,
	compilerDiagnostics: readonly string[],
): string {
	return `${runSkillId ? `/skill:${runSkillId} ` : ""}${wrapPromptBlock(
		"workflow_design_assignment",
		`${runSkillId ? "Use the supplied business Skill as supplementary method guidance." : "No business Run Skill is selected; its absence is not a resource gap."} Design this Workflow from the original task, ProcessSpec, available employees, tools and environment capabilities. Bind suitable Skills only where they help the work.\n\nTaskInput:\n${canonicalJson(task)}\n\nProcessSelection:\n${canonicalJson(selection)}\n\nProcessSpec:\n${canonicalJson(spec)}\n\nAvailable non-employee resources:\n${canonicalJson(assetSummary)}\n\nSearch and inspect AgentCards before binding employees.\n\nCompiler diagnostics:\n${compilerDiagnostics.length > 0 ? compilerDiagnostics.join("\n") : "None"}`,
	)}`;
}

export function buildWorkflowDesignRevisionPrompt(
	draftRevision: number,
	compilerDiagnostics: readonly string[],
): string {
	return wrapPromptBlock(
		"workflow_design_revision",
		`Draft revision: ${draftRevision}\n\nCompiler diagnostics:\n${compilerDiagnostics.length > 0 ? compilerDiagnostics.join("\n") : "None"}\n\nRevise the existing draft and submit the corrected revision.`,
	);
}
