import { describe, expect, it } from "vitest";
import { artifactReferenceDiagnostics } from "../src/adapter/artifact-reference-preflight.ts";
import { SubmissionCapture, type SubmitArtifact, type SubmitReview } from "../src/adapter/structured-submissions.ts";
import { submissionEvidenceReferences } from "../src/adapter/submission-context.ts";
import { patchSubmission, readSubmissionField } from "../src/adapter/submission-patch.ts";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import type { SubmissionRecord } from "../src/contracts/runtime.ts";
import { hashJson } from "../src/ir/hash.ts";
import type { NodeRoundWork } from "../src/runtime/node-worker.ts";
import { validateReviewSubmission } from "../src/runtime/review-validation.ts";
import { createCompilerFixture, createExecutionStamp } from "./fixtures.ts";

function candidate(): SubmitArtifact {
	return {
		summary: "unchanged ".repeat(1500),
		outputs: [
			{ output_id: "content-output", files: [{ path: "outputs/produce/result.txt", media_type: "text/plain" }] },
		],
		evidence: [{ description: "observed output", reference: "bad.txt", output_id: "content-output" }],
		metadata: { important: "preserve" },
	};
}
function reviewWork(): NodeRoundWork {
	const compiled = compileWorkflow(createCompilerFixture());
	if (!compiled.ok) throw new Error("Fixture failed");
	const node = compiled.baseline.nodes.find((item) => item.definition.kind === "review")!;
	const file = { path: "outputs/produce/result.txt", sha256: "a".repeat(64), size: 5, mimeType: "text/plain" };
	// Only fields consumed by the reference view/validator, not a simulated sealed store.
	const submission = {
		submissionId: "s1",
		nodeId: "produce",
		outputs: [{ outputId: "content-output", sealedRoot: "/private/do-not-disclose", manifest: { files: [file] } }],
	} as unknown as SubmissionRecord;
	return {
		stamp: createExecutionStamp("r1"),
		runId: "run-1",
		roundId: "r1",
		node,
		inputSubmissions: [submission],
		inputBindings: [
			{
				inputId: "candidate",
				submissionId: "s1",
				outputId: "content-output",
				availability: "submitted",
				approvalReviewNodeIds: [],
			} as NodeRoundWork["inputBindings"][number],
		],
		taskContext: { materials: [], unresolvedFacts: [] },
		forbiddenMutableReadPaths: [],
		feedback: [],
	};
}
function report(): SubmitReview {
	return {
		decision: "PASS",
		criteria: [
			{
				criterion_id: "quality",
				result: "PASS",
				evidence: [
					{
						criterion_id: "quality",
						submission_id: "s1",
						node_id: "produce",
						output_id: "content-output",
						reference: "outputs/produce/result.txt",
						description: "inspected",
					},
				],
				rationale: "verified",
				required_rework: [],
				rework_targets: [],
			},
		],
		unresolved_issues: [],
	};
}

describe("generic protocol efficiency (synthetic run regressions)", () => {
	it("repairs one field without resending or mutating the long report", () => {
		const input = candidate();
		const patches = [{ op: "set" as const, path: "/evidence/0/reference", value: "outputs/produce/result.txt" }];
		const result = patchSubmission(input, patches) as SubmitArtifact;
		expect(result.summary).toBe(input.summary);
		expect(result.metadata).toEqual(input.metadata);
		expect(input.evidence[0].reference).toBe("bad.txt");
		expect(result.evidence[0].reference).toBe("outputs/produce/result.txt");
		expect(JSON.stringify(patches).length).toBeLessThan(JSON.stringify(input).length / 20);
	});
	it.each([
		"/",
		"/__proto__/polluted",
		"/metadata/constructor",
		"/evidence/9/reference",
		"/missing/child",
		"/evidence/-",
		"/evidence/01",
		"/bad~2escape",
	])("rejects unsafe or absent pointer %s", (path) => {
		expect(() => patchSubmission(candidate(), [{ op: "set", path, value: "x" }])).toThrow();
	});
	it("applies ordered removals and additions atomically to a clone", () => {
		const input = candidate();
		const result = patchSubmission(input, [
			{ op: "set", path: "/evidence/0/locator", value: "section 2" },
			{ op: "remove", path: "/metadata/important" },
		]) as SubmitArtifact;
		expect(result.evidence[0].locator).toBe("section 2");
		expect(result.metadata).toEqual({});
		expect(() =>
			patchSubmission(input, [
				{ op: "set", path: "/summary", value: "changed" },
				{ op: "remove", path: "/missing" },
			]),
		).toThrow();
		expect(input.summary).toBe(candidate().summary);
	});
	it("reads only explicitly selected fields, returning a copy", () => {
		const input = candidate();
		const field = readSubmissionField(input, "/evidence/0") as { reference: string };
		field.reference = "changed";
		expect(input.evidence[0].reference).toBe("bad.txt");
	});
	it("keeps Runtime-rejected candidates only on explicit same-scope correction", () => {
		const capture = new SubmissionCapture<SubmitArtifact>();
		capture.beginRound("r1-input1");
		capture.capture("first", candidate());
		capture.beginRound("r1-input1", true);
		expect(capture.value).toBeUndefined();
		expect(capture.correction?.contentHash).toBe(hashJson(candidate()));
		capture.beginRound("r1-input2", true);
		expect(capture.correction).toBeUndefined();
	});
	it("does not carry rejected payload into rework or an ordinary new dispatch", () => {
		const capture = new SubmissionCapture<SubmitArtifact>();
		capture.beginRound("r1");
		capture.rememberRejected(candidate());
		capture.beginRound("r2", true);
		expect(capture.correction).toBeUndefined();
		capture.rememberRejected(candidate());
		capture.beginRound("r2");
		expect(capture.correction).toBeUndefined();
	});
	it("retains original single-capture conflict and replay semantics", () => {
		const capture = new SubmissionCapture<SubmitArtifact>();
		capture.beginRound("r1");
		capture.capture("x", candidate());
		expect(capture.capture("x", candidate()).reused).toBe(true);
		expect(() => capture.capture("y", candidate())).toThrow();
		capture.rememberRejected({ ...candidate(), summary: "other" });
		expect(capture.value?.summary).toBe(candidate().summary);
	});
	it("reports all invalid producer references instead of accepting joined paths", () => {
		const workflow = createCompilerFixture().workflow;
		const node = workflow.nodes[0];
		if (node.kind !== "execution") throw new Error("fixture");
		const input = candidate();
		input.evidence.push({ ...input.evidence[0], reference: "outputs/produce/result.txt (checked)" });
		const errors = artifactReferenceDiagnostics(input, node, "/workspace");
		expect(errors).toHaveLength(2);
		expect(errors.join("\n")).toContain("/evidence/1/reference");
		expect(errors.join("\n")).toContain("locator");
	});
	it.each(["outputs/produce/result.txt", "result.txt", "outputs/produce/result.txt#section", "submission.json"])(
		"retains valid exact-file forms: %s",
		(reference) => {
			const node = createCompilerFixture().workflow.nodes[0];
			if (node.kind !== "execution") throw new Error("fixture");
			const input = candidate();
			input.evidence[0].reference = reference;
			expect(artifactReferenceDiagnostics(input, node, "/workspace")).toEqual([]);
		},
	);
	it("returns only current bound subject tuples, not host roots or unbound outputs", () => {
		const work = reviewWork();
		const unbound = structuredClone(work.inputSubmissions[0]);
		unbound.submissionId = "unbound";
		work.inputSubmissions.push(unbound);
		const rows = submissionEvidenceReferences(work, "quality");
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ submission_id: "s1", output_id: "content-output" });
		expect(JSON.stringify(rows)).not.toContain("/private/");
		expect(submissionEvidenceReferences(work, "other")).toEqual([]);
		work.inputBindings = [];
		expect(submissionEvidenceReferences(work)).toEqual([]);
	});
	it("collects independent review defects with paths without changing acceptance", () => {
		const work = reviewWork();
		const value = report();
		value.criteria[0].evidence[0].criterion_id = "wrong";
		value.criteria[0].evidence[0].output_id = "background";
		value.decision = "REWORK";
		let message = "";
		try {
			validateReviewSubmission(work.node, value, work.inputSubmissions);
		} catch (error) {
			message = error instanceof Error ? error.message : String(error);
		}
		expect(message).toContain("/decision");
		expect(message).toContain("/criteria/0/evidence/0/criterion_id");
		expect(message).toContain("unrelated output");
		expect(message).toContain("content-output");
		expect(validateReviewSubmission(work.node, report(), work.inputSubmissions)).toEqual(report());
	});
	it("does not turn missing subjects, unauthorized rework or FAIL into approval", () => {
		const work = reviewWork();
		const value = report();
		value.criteria[0].result = "FAIL";
		value.criteria[0].rework_targets = [{ node_id: "independent", output_id: "other" }];
		expect(() => validateReviewSubmission(work.node, value, work.inputSubmissions)).toThrow(/concrete rework/);
		value.criteria[0].evidence = [];
		expect(() => validateReviewSubmission(work.node, value, work.inputSubmissions)).toThrow(/requires evidence/);
	});
});
