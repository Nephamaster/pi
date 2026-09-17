// 提供节点稳定系统规则和最小轮次启动消息。
import { loadPrompt } from "../adapter/prompt-loader.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import type { NodeRoundWork } from "./node-worker.ts";

const common = loadPrompt("common");

export function buildNodeSystemPrompt(): string {
	return common;
}

export function nodeDispatchKind(work: NodeRoundWork): string {
	if (work.feedback.some((item) => item.type === "submission_correction")) return "submission_correction";
	if (work.resuming) return "resume";
	if (work.feedback.some((item) => item.type === "quality_rework")) return "quality_rework";
	if (work.feedback.some((item) => item.type === "mechanical_failure")) return "mechanical_rework";
	return work.node.definition.kind === "review" ? "review" : "execute";
}

export function buildNodeRoundPrompt(work: NodeRoundWork): string {
	const kind = nodeDispatchKind(work);
	const submission = work.node.definition.kind === "review" ? "submit_review" : "submit_artifact";
	const instructions: Record<string, string> = {
		execute: `Execute the frozen contract and call ${submission} when the complete candidate is ready.`,
		review: "Review the exact input versions against the assigned criteria, then call submit_review.",
		resume:
			"Continue from the retained Session and workspace. Inspect saved progress and current files before acting. Do not blindly repeat earlier tool side effects. The frozen contract and quality obligations are unchanged.",
		quality_rework: `Apply the formal review requirements in ipd_current_round, preserving work that remains valid, then submit a complete revised candidate via ${submission}. Review references: ${
			[
				...new Set(
					work.feedback
						.filter((item) => item.type === "quality_rework")
						.map((item) => item.sourceId)
						.filter(Boolean),
				),
			].join(", ") || "see current state"
		}.`,
		mechanical_rework: `Correct the recorded mechanical check failures and submit a complete revised candidate via ${submission}.`,
		submission_correction: `Correct the submission protocol or export defects in ipd_current_round and call ${submission} again. This is not a new quality review or a request to repeat completed work.`,
	};
	return wrapPromptBlock(
		"node_round_dispatch",
		`${kind === "resume" ? "Continue" : "Begin"} IPD work round ${work.roundId}.\nDispatch: ${kind}.\n${instructions[kind]}`,
	);
}
