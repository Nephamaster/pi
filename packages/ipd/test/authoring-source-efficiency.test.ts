import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateGovernance } from "../src/compiler/validate-governance.ts";
import { WorkflowDraftManager } from "../src/control/workflow-draft.ts";
import { locateDiagnostic, materializeDraft } from "../src/control/workflow-draft-materialize.ts";
import { applyDraftCommand } from "../src/control/workflow-draft-operations.ts";
import { DraftCommandSchema } from "../src/control/workflow-draft-schema.ts";
import { readDraftView } from "../src/control/workflow-draft-views.ts";
import { toJsonValue } from "../src/ir/hash.ts";
import { processSources } from "../src/ir/process-sources.ts";
import { validateSchema } from "../src/ir/validation.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { authorFixture } from "./workflow-authoring-fixtures.ts";

describe("source binding and diagnostic editing (run regression)", () => {
	it("exposes item and nested criterion IDs rather than version-qualified guesses", () => {
		const fixture = createCompilerFixture();
		const draft = authorFixture(fixture.workflow);
		const view = readDraftView(
			draft,
			{ view: "process", kind: "sources", ids: ["content-review.criterion.1"] },
			{ process: toJsonValue(fixture.processSpec) },
		);
		expect(view.items).toEqual([
			{
				source_ref: "content-review.criterion.1",
				source_quote: "The content satisfies the task",
				source_kind: "process_criterion",
			},
		]);
		expect(processSources(fixture.processSpec)).toHaveLength(4);
	});
	it("copies the selected quote and ID deterministically without adding any checks or coverage", () => {
		const fixture = createCompilerFixture();
		const draft = authorFixture(fixture.workflow);
		const result = applyDraftCommand(
			draft,
			{
				domain: "governance",
				data: {
					requirements: {
						from_process: [{ requirement_id: "req-process", source_id: "produce", strength: "required" }],
					},
				},
			},
			{ process: toJsonValue(fixture.processSpec) },
		).draft;
		expect(result.requirements[0]).toMatchObject({
			requirement_id: "req-process",
			authority: "process",
			strength: "required",
			source_ref: "produce",
			source_quote: "Produce the deliverable",
		});
		expect(result.criteria).toEqual(draft.criteria);
		expect(result.process_coverage).toEqual(draft.process_coverage);
	});
	it("rejects unknown, qualified, ambiguous and missing selected sources", () => {
		const fixture = createCompilerFixture();
		const draft = authorFixture(fixture.workflow);
		const command = {
			domain: "governance" as const,
			data: {
				requirements: {
					from_process: [
						{ requirement_id: "req", source_id: "delivery-process@1.0.0", strength: "required" as const },
					],
				},
			},
		};
		expect(() => applyDraftCommand(draft, command, { process: toJsonValue(fixture.processSpec) })).toThrow(
			/entry ID/,
		);
		expect(() => applyDraftCommand(draft, command)).toThrow(/selected ProcessSpec/);
		command.data.requirements.from_process[0].source_id = "produce";
		fixture.processSpec.workflow_rules.push({ rule_id: "produce", description: "conflict", enforced_by: "review" });
		expect(() => applyDraftCommand(draft, command, { process: toJsonValue(fixture.processSpec) })).toThrow(
			/entry ID/,
		);
		expect(draft.requirements).toEqual([]);
	});
	it("patches only the bad reference without resending long text or changing siblings", () => {
		const fixture = createCompilerFixture();
		let draft = authorFixture(fixture.workflow);
		draft = applyDraftCommand(draft, {
			domain: "governance",
			data: {
				requirements: {
					upsert: [
						{
							requirement_id: "req",
							description: "keep ".repeat(300),
							authority: "process",
							strength: "required",
							source_ref: "wrong",
							source_quote: "Produce the deliverable",
						},
					],
				},
			},
		}).draft;
		const result = applyDraftCommand(draft, {
			domain: "governance",
			data: { requirements: { patch: [{ requirement_id: "req", source_ref: "produce" }] } },
		}).draft;
		expect(result.requirements[0]).toEqual({ ...draft.requirements[0], source_ref: "produce" });
		expect(result.nodes).toEqual(draft.nodes);
		expect(readDraftView(result, { view: "governance", ids: ["absent"] }).items).toEqual([]);
		expect(readDraftView(result, { view: "governance", ids: ["req"] }).items).toHaveLength(1);
	});
	it("validates edit schema and refuses patch-create or duplicate commands", () => {
		const fixture = createCompilerFixture();
		const draft = authorFixture(fixture.workflow);
		const command = {
			domain: "governance" as const,
			data: { requirements: { patch: [{ requirement_id: "missing", source_ref: "produce" }] } },
		};
		expect(validateSchema(DraftCommandSchema, command).ok).toBe(true);
		expect(() => applyDraftCommand(draft, command)).toThrow(/existing requirement/);
		expect(
			validateSchema(DraftCommandSchema, {
				domain: "governance",
				data: { requirements: { from_process: [{ requirement_id: "r", source_id: "produce" }] } },
			}).ok,
		).toBe(false);
	});
	it("returns exact source-field diagnostics while keeping bad quotes rejected", () => {
		const f = createCompilerFixture();
		f.workflow.requirements = [
			{
				requirement_id: "req",
				description: "requirement",
				authority: "process",
				strength: "advisory",
				source_ref: "delivery-process@1.0.0",
				source_quote: "Produce the deliverable",
			},
		];
		const invalid = validateGovernance(f.workflow, f.taskInput, f.processSpec).find(
			(item) => item.code === "requirement_source_mismatch",
		)!;
		expect(invalid.path).toBe("/requirements/0/source_ref");
		expect(invalid.message).toContain('"produce"');
		f.workflow.requirements[0].source_ref = "produce";
		f.workflow.requirements[0].source_quote = "invented";
		expect(
			validateGovernance(f.workflow, f.taskInput, f.processSpec).some(
				(item) => item.code === "requirement_source_mismatch",
			),
		).toBe(true);
	});
	it("routes named review and coverage diagnostics to their actual editors", () => {
		const { sourceMap } = materializeDraft(authorFixture(createCompilerFixture().workflow));
		expect(
			locateDiagnostic(
				{ code: "review_relation_not_declared", path: "/nodes/review-produce", message: "invalid relation" },
				sourceMap,
			).suggestedTool,
		).toBe("workflow_draft_reviews");
		expect(
			locateDiagnostic({ code: "coverage", path: "/requirement_coverage", message: "invalid coverage" }, sourceMap)
				.suggestedTool,
		).toBe("workflow_draft_coverage");
	});
	it("keeps manager atomicity and original request replay for from_process and sparse patches", async () => {
		const dir = await mkdtemp(join(tmpdir(), "ipd-source-fix-"));
		try {
			const f = createCompilerFixture();
			const manager = new WorkflowDraftManager({
				file: join(dir, "draft.json"),
				trustedReferences: {
					task_input_ref: f.workflow.task_input_ref,
					process_selection_ref: f.workflow.process_selection_ref,
				},
			});
			manager.setContext({ process: toJsonValue(f.processSpec) });
			await manager.open("run-1");
			const cmd = {
				domain: "governance",
				data: {
					requirements: { from_process: [{ requirement_id: "r", source_id: "produce", strength: "required" }] },
				},
			};
			const first = await manager.edit(0, "source-1", cmd);
			const replay = await manager.edit(0, "source-1", cmd);
			expect(first.applied_revision).toBe(1);
			expect(replay.replayed).toBe(true);
			await expect(
				manager.edit(1, "patch-bad", {
					domain: "governance",
					data: {
						requirements: {
							patch: [
								{ requirement_id: "r", description: "changed" },
								{ requirement_id: "unknown", description: "invalid" },
							],
						},
					},
				}),
			).rejects.toThrow();
			expect((await manager.read()).revision).toBe(1);
			expect((await manager.read()).requirements[0].description).toBe("Produce the deliverable");
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
