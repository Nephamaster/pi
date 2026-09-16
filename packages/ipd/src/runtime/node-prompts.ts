// 提供节点稳定系统规则和最小轮次启动消息。
import { loadPrompt } from "../adapter/prompt-loader.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import type { NodeRoundWork } from "./node-worker.ts";

const common = loadPrompt("common");

export function buildNodeSystemPrompt(): string {
	return common;
}

export function buildNodeRoundPrompt(work: NodeRoundWork): string {
	return wrapPromptBlock(
		"node_round_dispatch",
		work.resuming
			? `Continue IPD work round ${work.roundId} from the retained Session and workspace. Inspect saved progress and current files before acting. Do not blindly repeat earlier tool side effects. The frozen contract and quality obligations are unchanged.`
			: `Begin IPD work round ${work.roundId}.`,
	);
}
