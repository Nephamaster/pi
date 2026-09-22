import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { renderCurrentRoundContext } from "../src/adapter/node-context.ts";
import { createArtifactManifest } from "../src/artifact/manifest.ts";
import {
	CheckExecutorRegistry,
	compileWorkflow,
	createArtifactIntegrityCheckExecutor,
	FileRunStore,
	MechanicalChecker,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
	WorkflowRuntime,
} from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("delivers every file diagnostic to the original round and accepts the corrected candidate", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipd-diagnostics-"));
	roots.push(root);
	const fixture = createCompilerFixture();
	const compiled = compileWorkflow(fixture);
	if (!compiled.ok) throw new Error("Fixture did not compile");
	const directory = await prepareRunDirectory(root, "run-1");
	await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
	const calls: string[] = [];
	const worker: NodeWorker = {
		async runExecution(work) {
			calls.push(`${work.roundId}/${work.stamp.attemptId}`);
			if (calls.length === 2) {
				const correction = work.feedback.at(-1)!;
				expect(correction).toMatchObject({ type: "submission_correction", outputId: "content-output" });
				expect(correction.diagnostics).toEqual([
					expect.objectContaining({
						code: "artifact_content_invalid",
						source: "outputs/produce/data.json",
						path: "/files/0/mimeType",
						message: expect.stringContaining("JSON"),
					}),
					expect.objectContaining({
						code: "artifact_content_invalid",
						source: "outputs/produce/notes.txt",
						path: "/files/1/mimeType",
						message: expect.stringContaining("NUL"),
					}),
				]);
				const projection = JSON.parse(renderCurrentRoundContext(work));
				expect(projection.feedback.at(-1).diagnostics).toEqual(correction.diagnostics);
				expect(JSON.stringify(projection.feedback)).not.toContain(root);
			}
			await writeFile(
				join(directory.workspace, "outputs/produce/data.json"),
				calls.length === 1 ? '{"a":\n}' : '{"a":1}',
			);
			await writeFile(
				join(directory.workspace, "outputs/produce/notes.txt"),
				calls.length === 1 ? "bad\0text" : "fixed text",
			);
			return {
				summary: "Candidate",
				outputs: [
					{
						output_id: "content-output",
						files: [
							{ path: "outputs/produce/data.json", media_type: "application/json" },
							{ path: "outputs/produce/notes.txt", media_type: "text/plain" },
						],
					},
				],
				evidence: [],
				metadata: {},
			};
		},
		async runReview(work) {
			const submission = work.inputSubmissions[0];
			return {
				decision: "PASS",
				criteria: [
					{
						criterion_id: "quality",
						result: "PASS",
						rationale: "Accepted",
						required_rework: [],
						rework_targets: [],
						evidence: [
							{
								description: "Read candidate",
								reference: "outputs/produce/data.json",
								submission_id: submission.submissionId,
								node_id: submission.nodeId,
								output_id: "content-output",
								criterion_id: "quality",
							},
						],
					},
				],
				unresolved_issues: [],
			};
		},
	};
	const store = new FileRunStore();
	store.bind("run-1", directory.stateFile);
	const checks = new CheckExecutorRegistry();
	checks.add(createArtifactIntegrityCheckExecutor());
	const runtime = new WorkflowRuntime(store, directory, worker, new SubmissionStore(), new MechanicalChecker(checks));
	await runtime.activate(compiled.baseline, fixture.taskInput);
	expect((await runtime.run()).status).toBe("succeeded");
	expect(calls).toHaveLength(2);
	expect(calls[0]).toBe(calls[1]);
});

it("describes missing files without exposing the host export workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipd-private-export-"));
	roots.push(root);
	try {
		await createArtifactManifest({
			workspace: root,
			contract: { id: "output", artifactType: "json", description: "Result", businessPurpose: "Test" },
			submission: {
				id: "submission",
				runId: "run",
				nodeId: "node",
				attemptId: "attempt",
				contractId: "output",
				createdAt: 1,
				inputs: [],
				metadata: {},
				files: [{ path: "outputs/missing.json", mimeType: "application/json" }],
			},
		});
		throw new Error("Expected validation failure");
	} catch (error) {
		expect(error).toMatchObject({
			outputId: "output",
			diagnostics: [
				expect.objectContaining({ source: "outputs/missing.json", message: expect.stringContaining("ENOENT") }),
			],
		});
		expect(JSON.stringify(error)).not.toContain(root);
	}
});
