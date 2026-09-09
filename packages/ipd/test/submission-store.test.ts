import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareRunDirectory, SubmissionStore, validateArtifactManifest } from "../src/index.ts";
import { createValidWorkflow } from "./fixtures.ts";

describe("SubmissionStore", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("seals an immutable submission from the shared Run workspace", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-submission-"));
		roots.push(root);
		const run = await prepareRunDirectory(root, "run-1");
		await mkdir(join(run.workspace, "outputs", "produce"), { recursive: true });
		await writeFile(join(run.workspace, "outputs", "produce", "result.txt"), "version one");
		const node = createValidWorkflow().nodes.find((item) => item.kind === "execution");
		if (!node || node.kind !== "execution") throw new Error("Missing execution node");
		const store = new SubmissionStore();
		const input = {
			run,
			runId: "run-1",
			node,
			roundId: "round-1",
			submissionId: "submission-1",
			inputSubmissionIds: [],
			submission: {
				summary: "First result",
				outputs: [
					{
						output_id: "content-output",
						files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
					},
				],
				evidence: [],
				metadata: {},
			},
		};
		const record = await store.seal(input);
		await writeFile(join(run.workspace, "outputs", "produce", "result.txt"), "version two");
		expect(await readFile(join(record.outputs[0].sealedRoot, "outputs", "produce", "result.txt"), "utf8")).toBe(
			"version one",
		);
		const output = node.outputs[0];
		expect(
			await validateArtifactManifest({
				workspace: record.outputs[0].sealedRoot,
				contract: {
					id: output.output_id,
					artifactType: output.artifact_type,
					description: output.description,
					businessPurpose: output.business_purpose,
				},
				manifest: record.outputs[0].manifest,
			}),
		).toEqual({ ok: true, diagnostics: [] });
		expect(await store.seal(input)).toEqual(record);
	});

	it("defensively normalizes a compiled output root before sealing", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-submission-"));
		roots.push(root);
		const run = await prepareRunDirectory(root, "run-1");
		await mkdir(join(run.workspace, "outputs", "produce"), { recursive: true });
		await writeFile(join(run.workspace, "outputs", "produce", "result.txt"), "result");
		const node = createValidWorkflow().nodes.find((item) => item.kind === "execution");
		if (!node || node.kind !== "execution") throw new Error("Missing execution node");
		node.outputs[0].path_prefix = "outputs/produce/";
		const record = await new SubmissionStore().seal({
			run,
			runId: "run-1",
			node,
			roundId: "round-1",
			submissionId: "submission-1",
			inputSubmissionIds: [],
			submission: {
				summary: "result",
				outputs: [
					{
						output_id: "content-output",
						files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }],
					},
				],
				evidence: [],
				metadata: {},
			},
		});
		expect(record.outputs[0].manifest.files[0].path).toBe("outputs/produce/result.txt");
	});

	it("rejects a symlink that escapes the declared output root", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-submission-link-"));
		roots.push(root);
		const run = await prepareRunDirectory(root, "run-1");
		await mkdir(join(run.workspace, "outputs", "produce"), { recursive: true });
		await mkdir(join(run.workspace, "outputs", "other"), { recursive: true });
		await writeFile(join(run.workspace, "outputs", "other", "secret.txt"), "secret");
		await symlink(
			join(run.workspace, "outputs", "other", "secret.txt"),
			join(run.workspace, "outputs", "produce", "link.txt"),
		);
		const node = createValidWorkflow().nodes.find((item) => item.kind === "execution");
		if (!node || node.kind !== "execution") throw new Error("Missing execution node");
		await expect(
			new SubmissionStore().seal({
				run,
				runId: "run-1",
				node,
				roundId: "round-1",
				submissionId: "submission-1",
				inputSubmissionIds: [],
				submission: {
					summary: "result",
					outputs: [
						{
							output_id: "content-output",
							files: [{ path: "outputs/produce/link.txt", media_type: "text/plain" }],
						},
					],
					evidence: [],
					metadata: {},
				},
			}),
		).rejects.toThrow("resolves outside output");
	});
});
