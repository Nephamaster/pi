import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EffectiveNode } from "../contracts/baseline.ts";
import { canonicalJson } from "../ir/hash.ts";
import type { NodeRoundWork } from "../runtime/node-worker.ts";

const CURRENT_CONTEXT_PREFIX = '<ipd_current_round source="runtime">';

export interface VirtualContextFile {
	path: string;
	content: string;
}

export function renderNodeContractFile(node: EffectiveNode): VirtualContextFile {
	const definition = node.definition;
	return {
		path: `/virtual/ipd/${definition.node_id}/NODE_CONTRACT.md`,
		content: `# IPD Node Contract\n\nThis file is a read-only Runtime projection of the frozen execution baseline.\n\n## Identity\n\n- Node: ${definition.node_id}\n- Kind: ${definition.kind}\n\n## Work contract\n\n\`\`\`json\n${canonicalJson(definition.contract)}\n\`\`\`\n\n## Inputs\n\n\`\`\`json\n${canonicalJson(definition.inputs)}\n\`\`\`\n\n## Deliverable or review responsibility\n\n\`\`\`json\n${canonicalJson(definition.kind === "execution" ? definition.outputs : { targets: definition.targets, allowed_rework_node_ids: definition.allowed_rework_node_ids })}\n\`\`\`\n\n## Acceptance criteria\n\n\`\`\`json\n${canonicalJson(node.criteria)}\n\`\`\`\n\n## Effective permissions\n\n\`\`\`json\n${canonicalJson(definition.agents.map((agent) => ({ participant_id: agent.participant_id, permissions: agent.permissions })))}\n\`\`\``,
	};
}

export function renderCurrentRoundContext(work: NodeRoundWork): string {
	return `${CURRENT_CONTEXT_PREFIX}\n${canonicalJson({
		run_id: work.runId,
		round_id: work.roundId,
		task_context: work.taskContext,
		input_bindings: work.inputBindings,
		input_submissions: work.inputSubmissions.map((submission) => ({
			submission_id: submission.submissionId,
			status: submission.status,
			outputs: submission.outputs.map((output) => ({
				output_id: output.outputId,
				sealed_root: output.sealedRoot,
				manifest: output.manifest,
			})),
			evidence: submission.evidence,
		})),
		feedback: work.feedback,
	})}\n</ipd_current_round>`;
}

export function omitConsumedImages(messages: AgentMessage[]): AgentMessage[] {
	let lastSuccessfulAssistant = -1;
	for (const [index, message] of messages.entries()) {
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted")
			lastSuccessfulAssistant = index;
	}
	if (lastSuccessfulAssistant < 0) return messages;
	return messages.map((message, index) => {
		if (index >= lastSuccessfulAssistant || message.role !== "toolResult") return message;
		if (!message.content.some((item) => item.type === "image")) return message;
		return {
			...message,
			content: [
				...message.content.filter((item) => item.type !== "image"),
				{
					type: "text",
					text: "[Image content already consumed by a later assistant response; omitted from this model request.]",
				},
			],
		};
	});
}

export function createCurrentRoundContextExtension(getContext: () => string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("context", (event) => {
			const content = getContext();
			if (!content) return undefined;
			return {
				messages: [
					...omitConsumedImages(event.messages),
					{
						role: "user",
						content: [{ type: "text", text: content }],
						timestamp: Date.now(),
					},
				],
			};
		});
	};
}
