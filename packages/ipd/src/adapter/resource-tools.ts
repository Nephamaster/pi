// Admit authorized tool calls through the same deployment/root capacity service as node dispatches.
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import type { ResourceAdmission } from "../runtime/resource-admission.ts";

export function admitTools(
	tools: readonly ToolDefinition[],
	admission: ResourceAdmission,
	rootId: string,
	participantKey: string,
): ToolDefinition[] {
	return tools.map((tool) => ({
		...tool,
		async execute(toolCallId, input, signal, onUpdate, context) {
			const release = await admission.acquire(
				rootId,
				`${rootId}:${participantKey}:tool:${toolCallId}`,
				signal,
				"tool",
			);
			try {
				return await tool.execute(toolCallId, input, signal, onUpdate, context);
			} finally {
				release();
			}
		},
	}));
}
