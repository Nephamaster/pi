import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ArtifactValidationError, createArtifactManifest, validateArtifactManifest } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

const roots: string[] = [];

afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function createWorkspace(): Promise<string> {
	const root = await mkdtemp(join(tmpdir(), "pi-ipd-artifact-"));
	roots.push(root);
	await mkdir(join(root, "outputs"));
	return root;
}

function submission(files: Array<{ role: "primary" | "evidence" | "review"; path: string; mimeType: string }>) {
	return {
		id: "artifact-1",
		runId: "run-1",
		nodeId: "produce",
		attemptId: "attempt-1",
		contractId: "content-output",
		createdAt: 1,
		inputs: [],
		files,
		metadata: {},
	};
}

describe("Artifact Manifest", () => {
	it("creates and validates a normalized, hashed Manifest", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
		await writeFile(join(workspace, "outputs", "review.txt"), "review");
		const contract = createValidWorkflow().nodes[0].output;
		const manifest = await createArtifactManifest({
			workspace,
			contract,
			submission: submission([
				{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" },
				{ role: "review", path: "outputs/review.txt", mimeType: "text/plain" },
			]),
		});

		expect(manifest.files.map((file) => file.path)).toEqual(["outputs/primary.txt", "outputs/review.txt"]);
		expect(manifest.files[0].sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(await validateArtifactManifest({ workspace, contract, manifest })).toEqual({ ok: true, diagnostics: [] });
	});

	it("accepts opaque UUID-style runtime IDs and enforces the Artifact Contract", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
		await writeFile(join(workspace, "outputs", "review.txt"), "review");
		const contract = createValidWorkflow().nodes[0].output;
		const opaqueSubmission = {
			...submission([
				{ role: "primary" as const, path: "outputs/primary.txt", mimeType: "text/plain" },
				{ role: "review" as const, path: "outputs/review.txt", mimeType: "text/plain" },
			]),
			id: "019d1234-5678-7000-8000-000000000001",
			runId: "019d1234-5678-7000-8000-000000000002",
			attemptId: "019d1234-5678-7000-8000-000000000003",
		};
		const manifest = await createArtifactManifest({ workspace, contract, submission: opaqueSubmission });
		expect(manifest.id).toBe(opaqueSubmission.id);

		await expect(
			createArtifactManifest({
				workspace,
				contract,
				submission: { ...opaqueSubmission, contractId: "different-contract" },
			}),
		).rejects.toMatchObject({
			diagnostics: expect.arrayContaining([expect.objectContaining({ code: "artifact_type_invalid" })]),
		});
	});

	it("detects content drift after registration", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.txt"), "first");
		await writeFile(join(workspace, "outputs", "review.txt"), "review");
		const contract = createValidWorkflow().nodes[0].output;
		const manifest = await createArtifactManifest({
			workspace,
			contract,
			submission: submission([
				{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" },
				{ role: "review", path: "outputs/review.txt", mimeType: "text/plain" },
			]),
		});
		await writeFile(join(workspace, "outputs", "primary.txt"), "other");

		const validation = await validateArtifactManifest({ workspace, contract, manifest });
		expect(validation.ok).toBe(false);
		expect(validation.diagnostics.map((item) => item.code)).toContain("artifact_hash_mismatch");
	});

	it("rejects files whose declared MIME does not match their content", async () => {
		const workspace = await createWorkspace();
		await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
		await writeFile(join(workspace, "outputs", "manifest.json"), "# Artifact Manifest\n");
		const contract = createValidWorkflow().nodes[0].output;
		await expect(
			createArtifactManifest({
				workspace,
				contract,
				submission: submission([
					{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" },
					{ role: "review", path: "outputs/manifest.json", mimeType: "application/json" },
				]),
			}),
		).rejects.toMatchObject({
			diagnostics: expect.arrayContaining([expect.objectContaining({ code: "artifact_content_invalid" })]),
		});
	});

	it("rejects missing files, missing roles, and workspace escapes", async () => {
		const workspace = await createWorkspace();
		const contract = createValidWorkflow().nodes[0].output;
		await writeFile(join(workspace, "outputs", "primary.txt"), "primary");
		const outside = join(workspace, "..", `outside-${Date.now()}.txt`);
		await writeFile(outside, "outside");
		roots.push(outside);
		await symlink(outside, join(workspace, "outputs", "outside-link.txt"));

		for (const [path, expectedCode] of [
			["outputs/missing.txt", "artifact_missing"],
			["../outside.txt", "artifact_path_invalid"],
			["outputs/outside-link.txt", "artifact_path_invalid"],
		] as const) {
			try {
				await createArtifactManifest({
					workspace,
					contract,
					submission: submission([
						{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" },
						{ role: "review", path, mimeType: "text/plain" },
					]),
				});
				throw new Error("Expected ArtifactValidationError");
			} catch (error) {
				expect(error).toBeInstanceOf(ArtifactValidationError);
				expect((error as ArtifactValidationError).diagnostics.map((item) => item.code)).toContain(expectedCode);
			}
		}

		await expect(
			createArtifactManifest({
				workspace,
				contract,
				submission: submission([{ role: "primary", path: "outputs/primary.txt", mimeType: "text/plain" }]),
			}),
		).rejects.toMatchObject({
			diagnostics: expect.arrayContaining([expect.objectContaining({ code: "artifact_role_missing" })]),
		});
	});
});
