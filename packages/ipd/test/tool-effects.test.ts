import { describe, expect, it } from "vitest";
import { createToolEffectRegistry, declareToolEffect, externalToolEffects } from "../src/index.ts";

describe("Tool effect registry", () => {
	it("treats built-in workspace tools as recoverable and unknown extension tools conservatively", () => {
		const effects = createToolEffectRegistry([
			declareToolEffect({ name: "remote_lookup" }, "external_idempotent"),
			{ name: "send_message" },
		]);

		expect(
			externalToolEffects(
				["read", "write", "bash", "web_search", "fetch_content", "source_check", "get_search_content"],
				effects,
			),
		).toEqual([]);
		expect(externalToolEffects(["remote_lookup", "send_message", "unregistered"], effects)).toEqual([
			{ tool: "remote_lookup", effect: "external_idempotent" },
			{ tool: "send_message", effect: "external_non_idempotent" },
			{ tool: "unregistered", effect: "external_non_idempotent" },
		]);
	});
});
