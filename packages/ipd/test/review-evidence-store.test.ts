import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import {
	compileWorkflow,
	type NodeRoundWork,
	type NodeWorker,
	prepareRunDirectory,
	SubmissionStore,
} from "../src/index.ts";
import { validateReviewEvidence } from "../src/runtime/evidence-validation.ts";
import { sealReviewEvidence } from "../src/runtime/review-evidence-store.ts";
import { createCompilerFixture, createExecutionStamp } from "./fixtures.ts";
import { passReport } from "./governance-fixtures.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

it("seals reviewer verification separately and checks the exact subject file and hash", async () => {
	const root = await mkdtemp(join(tmpdir(), "ipd-review-evidence-"));
	roots.push(root);
	const fixture = createCompilerFixture();
	const compiled = compileWorkflow(fixture);
	if (!compiled.ok) throw new Error("Invalid fixture");
	const directory = await prepareRunDirectory(root, fixture.runId);
	await mkdir(join(directory.workspace, "outputs/produce"), { recursive: true });
	await writeFile(join(directory.workspace, "outputs/produce/result.txt"), "observed subject");
	const node = compiled.baseline.nodes[0].definition;
	if (node.kind !== "execution") throw new Error("Invalid fixture");
	const submission = await new SubmissionStore().seal({
		run: directory,
		runId: fixture.runId,
		node,
		roundId: "produce:1",
		attemptId: "produce:attempt:1",
		submissionId: "candidate",
		inputSubmissionIds: [],
		submission: {
			summary: "Subject",
			outputs: [
				{ output_id: "content-output", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
			],
			evidence: [],
			metadata: {},
		},
	});
	const work: NodeRoundWork = {
		stamp: createExecutionStamp("review:1"),
		runId: fixture.runId,
		roundId: "review:1",
		node: compiled.baseline.nodes[1],
		inputSubmissions: [submission],
		inputBindings: [
			{
				inputId: "candidate",
				submissionId: submission.submissionId,
				outputId: "content-output",
				approvalReviewNodeIds: [],
			},
		],
		taskContext: { materials: [], unresolvedFacts: [] },
		forbiddenMutableReadPaths: [],
		feedback: [],
	};
	const report = passReport(work);
	report.criteria[0].evidence[0].verification_path = "outputs/review-evidence/check.json";
	const worker: NodeWorker = {
		async runExecution() {
			throw new Error("unused");
		},
		async runReview() {
			throw new Error("unused");
		},
		async exportReviewEvidence() {
			const path = await mkdtemp(join(tmpdir(), "ipd-review-export-"));
			roots.push(path);
			await mkdir(join(path, "outputs/review-evidence"), { recursive: true });
			await writeFile(join(path, "outputs/review-evidence/check.json"), '{"observed":"subject exists"}');
			return path;
		},
	};
	const receipts = await sealReviewEvidence(directory, worker, work, report);
	const records = await validateReviewEvidence(work, report, receipts);
	expect(records[0]).toMatchObject({
		provenance: "reviewer_observation",
		rawDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
	});
	expect(await readFile(join(directory.root, records[0].rawRef), "utf8")).toContain("subject exists");
	expect(records[0].subjectFileRef).toContain("candidate/content-output/outputs/produce/result.txt");
	report.criteria[0].evidence[0].reference = "https://example.com/no-snapshot";
	await expect(validateReviewEvidence(work, report, receipts)).rejects.toThrow("sealed file");
	report.criteria[0].evidence[0].verification_path = "../state.json";
	await expect(sealReviewEvidence(directory, worker, work, report)).rejects.toThrow("export boundary");
});
