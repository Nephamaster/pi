import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WorkflowDraftManager } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

describe("WorkflowDraftManager", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("builds one revisioned Workflow through idempotent domain operations", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-draft-"));
		roots.push(root);
		const workflow = createValidWorkflow();
		const manager = new WorkflowDraftManager({
			file: join(root, "workflow-draft.json"),
			trustedReferences: {
				task_input_ref: workflow.task_input_ref,
				process_selection_ref: workflow.process_selection_ref,
			},
		});
		const draft = await manager.open("run-1");
		const operations = [
			{
				kind: "set_header" as const,
				header: {
					schema_version: workflow.schema_version,
					workflow_id: workflow.workflow_id,
					workflow_version: workflow.workflow_version,
					name: workflow.name,
				},
			},
			...workflow.nodes.map((node) => ({ kind: "upsert_node" as const, node })),
			...workflow.criteria.map((criterion) => ({ kind: "upsert_criterion" as const, criterion })),
			{ kind: "set_requirement_coverage" as const, coverage: workflow.requirement_coverage },
			{ kind: "set_completion" as const, completion: workflow.completion },
		];
		const updated = await manager.apply(draft.draftId, 0, "operation-1", operations);
		expect(updated.revision).toBe(1);
		expect((await manager.apply(draft.draftId, 0, "operation-1", operations)).revision).toBe(1);
		expect((await manager.validate(1)).valid).toBe(true);
		expect(await manager.submit(1)).toEqual(workflow);
		await expect(manager.apply(draft.draftId, 0, "operation-2", operations)).rejects.toThrow("revision conflict");
		const mismatched = new WorkflowDraftManager({
			file: join(root, "workflow-draft.json"),
			trustedReferences: {
				task_input_ref: { ...workflow.task_input_ref, hash: "f".repeat(64) },
				process_selection_ref: workflow.process_selection_ref,
			},
		});
		await expect(mismatched.open("run-1")).rejects.toThrow("trusted references");
	});
});
