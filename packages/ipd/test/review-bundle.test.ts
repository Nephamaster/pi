import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildReviewBundle, createArtifactManifest, createDefaultArtifactViewRegistry } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-review-"));
	roots.push(root);
	await mkdir(join(root, "outputs"));
	return root;
}

describe("Review Bundle", () => {
	it("creates views for every supported file and references unsupported files", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.bin"), Buffer.from([0, 1, 2]));
		await writeFile(join(workspace, "outputs", "review.txt"), "reviewable content");
		await writeFile(join(workspace, "outputs", "evidence.json"), JSON.stringify({ valid: true }));
		const contract = createValidWorkflow().nodes[0].output;
		const manifest = await createArtifactManifest({
			workspace,
			contract,
			submission: {
				id: "artifact-1",
				runId: "run-1",
				nodeId: "produce",
				attemptId: "attempt-1",
				contractId: contract.id,
				createdAt: 1,
				inputs: [],
				files: [
					{ path: "outputs/primary.bin", mimeType: "application/octet-stream" },
					{ path: "outputs/review.txt", mimeType: "text/plain" },
					{ path: "outputs/evidence.json", mimeType: "application/json" },
				],
				metadata: {},
			},
		});

		const result = await buildReviewBundle({
			workspace,
			contract,
			manifest,
			registry: createDefaultArtifactViewRegistry(),
			now: () => 10,
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundle.generatedAt).toBe(10);
		expect(result.bundle.materials.map((material) => material.kind)).toEqual(["reference", "text", "json"]);
	});

	it("keeps unsupported files as references for the Reviewer", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
		await writeFile(join(workspace, "outputs", "review.bin"), "opaque");
		const contract = createValidWorkflow().nodes[0].output;
		const manifest = await createArtifactManifest({
			workspace,
			contract,
			submission: {
				id: "artifact-1",
				runId: "run-1",
				nodeId: "produce",
				attemptId: "attempt-1",
				contractId: contract.id,
				createdAt: 1,
				inputs: [],
				files: [
					{ path: "outputs/primary.txt", mimeType: "text/plain" },
					{ path: "outputs/review.bin", mimeType: "application/octet-stream" },
				],
				metadata: {},
			},
		});

		const result = await buildReviewBundle({
			workspace,
			contract,
			manifest,
			registry: createDefaultArtifactViewRegistry(),
		});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.bundle.materials.map((material) => material.kind)).toEqual(["text", "reference"]);
	});
});
