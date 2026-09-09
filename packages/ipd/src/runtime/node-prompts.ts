import { loadPrompt } from "../adapter/prompt-loader.ts";
import { renderAgentProfile } from "../adapter/render-agent-profile.ts";
import type { NodeRoundWork } from "./node-worker.ts";

const common = loadPrompt("common");
const execution = loadPrompt("execution-node");
const review = loadPrompt("review-node");

export function buildNodeSystemPrompt(work: NodeRoundWork): string {
	const card = work.node.agents[0].agentCard;
	const configured = work.node.definition.agents[0];
	return [
		common,
		renderAgentProfile(card),
		`Node-specific system constraints:\n${configured.system_prompt_addendum.map((item) => `- ${item}`).join("\n") || "- None"}`,
		work.node.definition.kind === "execution" ? execution : review,
	].join("\n\n");
}

export function buildNodeRoundPrompt(work: NodeRoundWork): string {
	return `Begin IPD work round ${work.roundId}. Use the Runtime-provided current-round context, the virtual node contract, and the exact sealed input references. ${work.feedback.length > 0 ? "Address every listed rework item before resubmitting." : "Complete the assigned work and submit its structured result."}`;
}
