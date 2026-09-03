import { describe, expect, it } from "vitest";
import { IpdToolCommandSchema, parseIpdToolCommand } from "../src/index.ts";
import { validateSchema } from "../src/ir/validation.ts";

describe("IpdToolCommandSchema", () => {
	it.each([
		{ action: "start", task: "Produce a reviewed deliverable", skillName: "task-skill" },
		{ action: "resume_run", runId: "run-1" },
		{ action: "status", runId: "run-1", detail: "full" },
		{ action: "watch", runId: "run-1", afterSequence: 12 },
		{ action: "cancel", runId: "run-1", reason: "No longer required" },
	])("accepts the $action Action", (command) => {
		expect(validateSchema(IpdToolCommandSchema, command).ok).toBe(true);
	});

	it("rejects model attempts to answer a user Escalation", () => {
		expect(() =>
			parseIpdToolCommand({
				action: "resume",
				runId: "run-1",
				escalationId: "escalation-1",
				answer: "Fabricated answer",
			}),
		).toThrow("Invalid IPD resume command");
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

	it("defaults start to an unbounded Run", () => {
		expect(
			parseIpdToolCommand({ action: "start", task: "Produce a reviewed deliverable", skillName: "task-skill" }),
		).toMatchObject({ ifBudget: false });
	});

	it("requires complete bounded Run limits and rejects limits when budgeting is disabled", () => {
		expect(() =>
			parseIpdToolCommand({
				action: "start",
				task: "Produce a reviewed deliverable",
				skillName: "task-skill",
				ifBudget: true,
				tokenBudget: 100_000,
			}),
		).toThrow("requires tokenBudget and timeBudgetMs");
		expect(() =>
			parseIpdToolCommand({
				action: "start",
				task: "Produce a reviewed deliverable",
				skillName: "task-skill",
				tokenBudget: 100_000,
			}),
		).toThrow("budget limits require ifBudget=true");
		expect(
			parseIpdToolCommand({
				action: "start",
				task: "Produce a reviewed deliverable",
				skillName: "task-skill",
				ifBudget: true,
				tokenBudget: 100_000,
				timeBudgetMs: 3_600_000,
			}),
		).toMatchObject({ ifBudget: true, tokenBudget: 100_000, timeBudgetMs: 3_600_000 });
	});

	it("requires a Workflow Template id when version or hash is supplied", () => {
		expect(() =>
			parseIpdToolCommand({
				action: "start",
				task: "Produce a reviewed deliverable",
				skillName: "task-skill",
				workflowTemplateVersion: "2.0.0",
			}),
		).toThrow("require workflowTemplateId");
	});
});
