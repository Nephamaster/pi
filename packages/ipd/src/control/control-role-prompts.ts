// 构造流程选择和工作流设计各轮的控制消息。
import type { LockedSkill } from "../contracts/baseline.ts";
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

export function buildInitialWorkflowDesignPrompt(
	designSkillId: string,
	task: TaskInput,
	selection: ProcessSelection,
	spec: ProcessSpec,
	assetSummary: JsonValue,
	compilerDiagnostics: readonly string[],
	runSkill?: Pick<LockedSkill, "id" | "filePath">,
): string {
	const businessMethod = runSkill
		? `A supplementary business Skill is bound: ${canonicalJson({ id: runSkill.id, filePath: runSkill.filePath })}. Read this exact SKILL.md with the authorized read tool when relevant, then consult its references as needed. Its guidance does not replace the task or ProcessSpec.`
		: "No business Run Skill is selected; its absence is not a resource gap.";
	// Native Skill expansion and the real assignment must reach the same first model request.
	return `/skill:${designSkillId} ${wrapPromptBlock(
		"workflow_design_assignment",
		`Use the loaded workflow-design method for this assignment; consult detailed references only as needed. ${businessMethod} Design this Workflow from the original task, ProcessSpec, available employees, tools and environment capabilities. Bind suitable Skills only where they help the work.\n\nTaskInput:\n${canonicalJson(task)}\n\nProcessSelection:\n${canonicalJson(selection)}\n\nProcessSpec:\n${canonicalJson(spec)}\n\nAvailable non-employee resources:\n${canonicalJson(assetSummary)}\n\nSearch and inspect AgentCards before binding employees.\n\nCompiler diagnostics:\n${compilerDiagnostics.length > 0 ? compilerDiagnostics.join("\n") : "None"}`,
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
