import type { AgentMessage } from "@earendil-works/pi-agent-core";
import { fauxAssistantMessage } from "@earendil-works/pi-ai/compat";
import { describe, expect, it } from "vitest";
import { omitConsumedImages } from "../src/index.ts";

const imageResult = (id: string): AgentMessage => ({
	role: "toolResult",
	toolCallId: id,
	toolName: "read",
	content: [
		{ type: "text", text: `Read ${id}` },
		{ type: "image", data: id, mimeType: "image/png" },
	],
	isError: false,
	timestamp: 1,
});

describe("node context image retention", () => {
	it("omits only images already consumed by a successful assistant response", () => {
		const messages: AgentMessage[] = [
			imageResult("old-image"),
			fauxAssistantMessage("old image reviewed"),
			imageResult("pending-image"),
			fauxAssistantMessage("", { stopReason: "error", errorMessage: "request too large" }),
		];
		const filtered = omitConsumedImages(messages);
		expect(filtered[0]).toMatchObject({
			role: "toolResult",
			content: [
				{ type: "text", text: "Read old-image" },
				{ type: "text", text: expect.stringContaining("already consumed") },
			],
		});
		expect(filtered[2]).toEqual(messages[2]);
		expect(messages[0]).toEqual(imageResult("old-image"));
	});
});
