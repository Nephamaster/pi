import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { expect, it } from "vitest";
import { CONTEXT_EVIDENCE_TOOL, projectRequestView } from "../src/adapter/request-view.ts";

const limits = { maxRequestBytes: 10_000, maxImagesPerRequest: 1, maxImagesPerMessage: 1 };

it("never hides a freshly requested evidence page behind another unread reference", () => {
	const page: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "page",
		toolName: CONTEXT_EVIDENCE_TOOL,
		content: [{ type: "text", text: "x".repeat(8000) }],
		isError: false,
		timestamp: 1,
	};
	expect(projectRequestView([page], new Map([["page", { id: "entry", message: page }]]), limits, 1)).toEqual([page]);
});

it("only replaces known tool evidence, preserving instructions, call IDs and opaque user images", () => {
	const tool: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: "x".repeat(20_000) }],
		isError: true,
		timestamp: 1,
	};
	const messages: AgentMessage[] = [
		{ role: "system", content: "frozen-contract", timestamp: 1 },
		{
			role: "user",
			content: [
				{ type: "text", text: "original-task" },
				{ type: "image", data: "unchanged", mimeType: "image/png" },
			],
			timestamp: 2,
		},
		tool,
	];
	const original = structuredClone(messages);
	const view = projectRequestView(messages, new Map([["call", { id: "entry", message: tool }]]), limits, 7000);
	expect(view.slice(0, 2)).toEqual(messages.slice(0, 2));
	expect(view[2]).toMatchObject({ role: "toolResult", toolCallId: "call", toolName: "read", isError: true });
	expect(JSON.stringify(view)).toContain("ipd_read_context");
	expect(messages).toEqual(original);
	expect(projectRequestView(messages, new Map(), limits, 1)).toEqual(messages);
});

it("does not undo a prior context edit or expose content filtered by another extension", () => {
	const raw: ToolResultMessage = {
		role: "toolResult",
		toolCallId: "call",
		toolName: "read",
		content: [{ type: "text", text: `private:${"x".repeat(20_000)}` }],
		isError: false,
		timestamp: 1,
	};
	const filtered = { ...raw, content: [{ type: "text" as const, text: "already-filtered" }] };
	expect(projectRequestView([filtered], new Map([["call", { id: "entry", message: raw }]]), limits, 1)).toEqual([
		filtered,
	]);
});
