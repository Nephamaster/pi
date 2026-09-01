import { describe, expect, it } from "vitest";
import { IpdToolCommandSchema } from "../src/index.ts";
import { validateSchema } from "../src/ir/validation.ts";

describe("IpdToolCommandSchema", () => {
	it.each([
		{ action: "start", task: "Produce a reviewed deliverable", skillName: "task-skill" },
		{ action: "resume", runId: "run-1", escalationId: "escalation-1", answer: "Use source A" },
		{ action: "status", runId: "run-1", detail: "full" },
		{ action: "cancel", runId: "run-1", reason: "No longer required" },
	])("accepts the $action Action", (command) => {
		expect(validateSchema(IpdToolCommandSchema, command).ok).toBe(true);
	});

	it("rejects start without its mandatory Skill", () => {
		const result = validateSchema(IpdToolCommandSchema, {
			action: "start",
			task: "Produce a reviewed deliverable",
		});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.diagnostics.length).toBeGreaterThan(0);
	});

	it("rejects fields belonging to a different Action", () => {
		expect(
			validateSchema(IpdToolCommandSchema, {
				action: "status",
				runId: "run-1",
				answer: "not allowed",
			}).ok,
		).toBe(false);
	});
});
