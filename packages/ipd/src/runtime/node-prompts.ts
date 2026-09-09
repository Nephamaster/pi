// 提供节点稳定系统规则和最小轮次启动消息。
import { loadPrompt } from "../adapter/prompt-loader.ts";
import type { NodeRoundWork } from "./node-worker.ts";

const common = loadPrompt("common");

export function buildNodeSystemPrompt(): string {
	return common;
}

export function buildNodeRoundPrompt(work: NodeRoundWork): string {
	return `Begin IPD work round ${work.roundId}.`;
}
