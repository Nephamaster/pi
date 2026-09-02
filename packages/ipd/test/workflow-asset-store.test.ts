import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileWorkflowAssetStore, hashJson, WorkflowAssetWriteError } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createRoot(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-workflow-assets-"));
	roots.push(root);
	return root;
}

describe("FileWorkflowAssetStore", () => {
	it("persists immutable, content-addressed Workflow Assets and reuses equal content", async () => {
		const root = await createRoot();
		const workflow = createValidWorkflow();
		const hash = hashJson(workflow);
		const store = new FileWorkflowAssetStore({ directory: root });

		const created = await store.save(workflow, hash);
		expect(created.reused).toBe(false);
		expect(existsSync(created.record.source)).toBe(true);
		expect(JSON.parse(await readFile(created.record.source, "utf8"))).toEqual(workflow);

		const reused = await store.save(workflow, hash);
		expect(reused.reused).toBe(true);
		expect(reused.record.source).toBe(created.record.source);
	});

	it("rejects a corrupted existing Asset instead of overwriting it", async () => {
		const root = await createRoot();
		const workflow = createValidWorkflow();
		const hash = hashJson(workflow);
		const store = new FileWorkflowAssetStore({ directory: root });
		const created = await store.save(workflow, hash);
		await writeFile(created.record.source, JSON.stringify({ ...workflow, objective: "corrupted" }));

		await expect(store.save(workflow, hash)).rejects.toBeInstanceOf(WorkflowAssetWriteError);
		expect(JSON.parse(await readFile(created.record.source, "utf8"))).toMatchObject({ objective: "corrupted" });
	});

	it("requires a version increment when Workflow content changes", async () => {
		const root = await createRoot();
		const workflow = createValidWorkflow();
		const store = new FileWorkflowAssetStore({ directory: root });
		await store.save(workflow, hashJson(workflow));
		const changed = structuredClone(workflow);
		changed.objective = "Changed objective under the same version";

		await expect(store.save(changed, hashJson(changed))).rejects.toThrow("increment its version");
	});
});
