import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRunRequestRegistry } from "../src/index.ts";

describe("FileRunRequestRegistry", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("returns one durable Run identity for concurrent retries", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-requests-"));
		roots.push(root);
		const firstRegistry = new FileRunRequestRegistry(root);
		const secondRegistry = new FileRunRequestRegistry(root);
		const input = { requestId: "request-1", requestHash: "payload-a", runSkillId: "pptx" };
		const [first, second] = await Promise.all([
			firstRegistry.claim({ ...input, proposedRunId: "run-a" }),
			secondRegistry.claim({ ...input, proposedRunId: "run-b" }),
		]);

		expect(new Set([first.record.runId, second.record.runId]).size).toBe(1);
		expect([first.reused, second.reused].sort()).toEqual([false, true]);
		const reopened = await new FileRunRequestRegistry(root).claim({ ...input, proposedRunId: "run-c" });
		expect(reopened).toMatchObject({ reused: true, record: { runId: first.record.runId } });
	});

	it("rejects reuse of one request ID with a different payload", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-requests-"));
		roots.push(root);
		const registry = new FileRunRequestRegistry(root);
		await registry.claim({
			requestId: "request-1",
			requestHash: "payload-a",
			proposedRunId: "run-a",
			runSkillId: "pptx",
		});
		await expect(
			registry.claim({
				requestId: "request-1",
				requestHash: "payload-b",
				proposedRunId: "run-b",
				runSkillId: "pptx",
			}),
		).rejects.toThrow("request ID conflict");
	});
});
