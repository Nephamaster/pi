import { describe, expect, it } from "vitest";
import { newAuthoringDraft } from "../src/control/workflow-draft-import.ts";
import { draftReferences } from "../src/control/workflow-draft-links.ts";
import { applyDraftCommand } from "../src/control/workflow-draft-operations.ts";
import { readDraftView } from "../src/control/workflow-draft-views.ts";

function emptyDraft() {
	return newAuthoringDraft("run-invariants", {
		task_input_ref: { id: "task", hash: "a".repeat(64) },
		process_selection_ref: { id: "selection", hash: "b".repeat(64) },
	});
}

describe("authoring provenance and migration invariants", () => {
	it("prevents deletion of a decision referenced by a design requirement", () => {
		const draft = applyDraftCommand(emptyDraft(), {
			domain: "governance",
			data: {
				requirements: { upsert: [
					{ requirement_id: "R-user", description: "Keep evidence", authority: "user", strength: "required", source_ref: "task", source_quote: "Keep evidence" },
					{ requirement_id: "R-design", description: "Use an evidence index", authority: "design", strength: "required", source_ref: "D-index", source_quote: "Use an evidence index" },
				] },
				decisions: { upsert: [{ decision_id: "D-index", description: "Use an evidence index", requirement_refs: ["R-user"], rationale: "Make required evidence locatable" }] },
			},
		}).draft;
		expect(draftReferences(draft)).toContainEqual({ target: "decision:D-index", path: "requirement:R-design.source_ref" });
		const before = structuredClone(draft);
		expect(() => applyDraftCommand(draft, { domain: "governance", data: { decisions: { remove_ids: ["D-index"] } } })).toThrow("references");
		expect(draft).toEqual(before);
	});
	it("accepts an explicit atomic removal of both requirement and its unreferenced decision", () => {
		const draft = emptyDraft();
		draft.requirements = [{ requirement_id: "R-design", description: "Design choice", authority: "design", strength: "advisory", source_ref: "D", source_quote: "Design choice" }];
		draft.decisions = [{ decision_id: "D", description: "Design choice", requirement_refs: [], rationale: "Fixture" }];
		const next = applyDraftCommand(draft, { domain: "governance", data: { requirements: { remove_ids: ["R-design"] }, decisions: { remove_ids: ["D"] } } }).draft;
		expect(next.requirements).toEqual([]);
		expect(next.decisions).toEqual([]);
	});
	it("provides a read-only view of retained legacy operation identities", () => {
		const draft = emptyDraft();
		draft.legacyOperations = { "old-edit": { requestHash: "hash-of-old-request", revision: 7 } };
		const before = structuredClone(draft);
		const view = readDraftView(draft, { view: "operation", operation_id: "old-edit" });
		expect(view.items).toEqual([{ protocol: "legacy-v1", requestHash: "hash-of-old-request", revision: 7 }]);
		expect(draft).toEqual(before);
	});
	it("does not report unrelated or inherited operation names as stored receipts", () => {
		const draft = emptyDraft();
		draft.legacyOperations = {};
		expect(readDraftView(draft, { view: "operation", operation_id: "missing" }).items).toEqual([{ found: false }]);
		expect(readDraftView(draft, { view: "operation", operation_id: "toString" }).items).toEqual([{ found: false }]);
	});
});
