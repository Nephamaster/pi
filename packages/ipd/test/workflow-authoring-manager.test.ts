import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import type { WorkflowDefinition } from "../src/contracts/workflow.ts";
import { WorkflowDraftManager } from "../src/control/workflow-draft.ts";
import { createWorkflowDraftTools } from "../src/control/workflow-draft-tools.ts";
import { createCompilerFixture } from "./fixtures.ts";
import { authoringCommands } from "./workflow-authoring-fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function setup(seed = false) {
	const root = await mkdtemp(join(tmpdir(), "ipd-authoring-manager-"));
	roots.push(root);
	const base = createCompilerFixture();
	let calls = 0;
	const options = {
		file: join(root, "workflow-draft.json"),
		trustedReferences: {
			task_input_ref: base.workflow.task_input_ref,
			process_selection_ref: base.workflow.process_selection_ref,
		},
		validator: (workflow: WorkflowDefinition) => {
			calls++;
			const result = compileWorkflow({ ...base, workflow });
			return result.ok ? [] : result.report.diagnostics;
		},
	};
	const manager = new WorkflowDraftManager(options);
	await manager.open(base.runId);
	if (seed)
		for (const [index, command] of authoringCommands(base.workflow).entries())
			await manager.edit(index, `seed-${index}`, command);
	return { root, manager, options, base, calls: () => calls };
}
const skeleton = { domain: "topology", data: { nodes: [{ node_id: "A", kind: "execution", name: "Analyze" }] } };

describe("durable authoring and compilation", () => {
	it("returns original edit receipts across later revisions", async () => {
		const { manager } = await setup();
		await manager.edit(0, "declare", skeleton);
		await manager.edit(1, "rename", {
			domain: "configure_nodes",
			data: { nodes: [{ node_id: "A", name: "New name" }] },
		});
		expect(await manager.edit(0, "declare", skeleton)).toMatchObject({
			applied_revision: 1,
			current_revision: 2,
			replayed: true,
		});
		await expect(manager.edit(2, "declare", { domain: "completion", data: {} })).rejects.toThrow("conflict");
		await expect(manager.edit(0, "old", skeleton)).rejects.toThrow("revision conflict");
	});
	it("rejects unknown fields and trusted-reference injection without saving", async () => {
		const { manager } = await setup();
		await expect(
			manager.edit(0, "bad", {
				domain: "governance",
				data: { task_input_ref: { id: "fake", hash: "f".repeat(64) } },
			}),
		).rejects.toThrow("Invalid domain command");
		expect((await manager.read()).revision).toBe(0);
	});
	it("serializes independent managers against the same revision", async () => {
		const { manager, options, base } = await setup();
		const other = new WorkflowDraftManager(options);
		await other.open(base.runId);
		const results = await Promise.allSettled([manager.edit(0, "first", skeleton), other.edit(0, "second", skeleton)]);
		expect(results.filter((item) => item.status === "fulfilled")).toHaveLength(1);
		expect((await manager.read()).revision).toBe(1);
	});
	it("rejects opening the existing draft as a different Run", async () => {
		const { options } = await setup();
		await expect(new WorkflowDraftManager(options).open("other-run")).rejects.toThrow("another Run");
	});
	it("keeps incomplete candidates out of the Compiler and persists submission diagnostics", async () => {
		const { manager, calls } = await setup();
		expect((await manager.validate(0)).valid).toBe(false);
		expect(calls()).toBe(0);
		await expect(manager.submitRevision(0, "invalid-submit")).rejects.toThrow("invalid");
		expect((await manager.read()).lastValidation?.valid).toBe(false);
	});
	it("captures exact immutable candidates and reopens only through trusted control", async () => {
		const { root, manager } = await setup(true);
		const state = await manager.read();
		const first = await manager.submitRevision(state.revision, "submit-1");
		expect(await readFile(join(root, first.receipt.candidate_file!), "utf8")).toBe(
			`${JSON.stringify(first.workflow, null, "\t")}\n`,
		);
		await expect(manager.edit(state.revision, "closed-edit", skeleton)).rejects.toThrow("closed");
		expect((await manager.submitRevision(state.revision, "submit-1")).receipt.replayed).toBe(true);
		await manager.beginRevision();
		await manager.edit(state.revision, "fix-contract", {
			domain: "configure_nodes",
			data: {
				nodes: [
					{ node_id: "produce", contract: { work_requirements: ["Use supplied material and preserve evidence"] } },
				],
			},
		});
		const next = await manager.submitRevision(state.revision + 1, "submit-2");
		expect(next.workflow.nodes[1]).toEqual(first.workflow.nodes[1]);
		expect(next.receipt.candidate_hash).not.toBe(first.receipt.candidate_hash);
	});
	it("does not allow legacy whole-node edits after domain authoring", async () => {
		const { manager } = await setup();
		await manager.edit(0, "declare", skeleton);
		await expect(
			manager.apply((await manager.read()).draftId, 1, "legacy", [{ kind: "remove_node", node_id: "A" }]),
		).rejects.toThrow("Legacy whole-object");
	});
	it("cannot reopen or replay-submit cancelled designer control", async () => {
		const { manager } = await setup(true);
		const state = await manager.read();
		await manager.submitRevision(state.revision, "submit-1");
		await manager.close();
		await expect(manager.submitRevision(state.revision, "submit-1")).rejects.toThrow("closed");
		await expect(manager.beginRevision()).rejects.toThrow("closed");
	});
	it("requires stopped-writer migration and retains the original legacy bytes", async () => {
		const { root, options, base } = await setup();
		const { nodes, criteria, requirement_coverage, completion, task_input_ref, process_selection_ref, ...header } =
			base.workflow;
		const raw = JSON.stringify({
			draftId: `${base.runId}:workflow-draft`,
			runId: base.runId,
			revision: 4,
			trustedReferences: { task_input_ref, process_selection_ref },
			header,
			nodes,
			criteria,
			requirementCoverage: requirement_coverage,
			completion,
			operations: {},
		});
		await writeFile(options.file, raw);
		const manager = new WorkflowDraftManager(options);
		await expect(manager.open(base.runId)).rejects.toThrow("Legacy draft preserved");
		await expect(manager.migrateLegacy(base.runId, false)).rejects.toThrow("old designer");
		const imported = await manager.migrateLegacy(base.runId, true);
		expect(imported.revision).toBe(5);
		expect(await readFile(join(root, imported.migration!.backupFile), "utf8")).toBe(raw);
		expect(await manager.submit(5)).toEqual(base.workflow);
	});
	it("exposes fourteen domain tools and never returns the full compiled Workflow", async () => {
		const { manager, base } = await setup(true);
		const toolset = createWorkflowDraftTools(manager, base.runId);
		expect(toolset.tools).toHaveLength(14);
		expect(toolset.tools.some((tool) => tool.name === "workflow_draft_apply")).toBe(false);
		const validate = toolset.tools.find((tool) => tool.name === "workflow_draft_validate")!;
		const result = await validate.execute(
			"validate",
			{ expected_revision: (await manager.read()).revision },
			undefined,
			undefined,
			{} as never,
		);
		expect(result.details).toMatchObject({ valid: true, mode: "compile" });
		expect(result.details).not.toHaveProperty("workflow");
	});
});
