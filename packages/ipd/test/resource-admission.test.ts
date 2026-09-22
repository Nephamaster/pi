import { describe, expect, it } from "vitest";
import { ResourceAdmission } from "../src/runtime/resource-admission.ts";

describe("root resource admission", () => {
	it("shares deployment capacity across Runs while retaining root limits and fair queued work", async () => {
		const admission = new ResourceAdmission({ active: 2, activePerRoot: 1 });
		const first = await admission.acquire("run-a", "a1");
		let nextA = false;
		const queuedA = admission.acquire("run-a", "a2").then((release) => {
			nextA = true;
			return release;
		});
		const firstB = await admission.acquire("run-b", "b1");
		expect(nextA).toBe(false);
		expect(admission.view("run-a")).toMatchObject({ active: 1, queued: 1 });
		first();
		const second = await queuedA;
		expect(nextA).toBe(true);
		second();
		firstB();
		expect(admission.view("run-a").active).toBe(0);
	});

	it("cancels queued work without consuming or releasing someone else's slot", async () => {
		const admission = new ResourceAdmission({ active: 1 });
		const release = await admission.acquire("a", "first");
		const controller = new AbortController();
		const queued = admission.acquire("b", "second", controller.signal);
		controller.abort();
		await expect(queued).rejects.toMatchObject({ kind: "cancelled" });
		expect(admission.view("a").active).toBe(1);
		expect(admission.view("b").queued).toBe(0);
		release();
	});

	it("keeps tool slots separate and enforces retained participants and cumulative sealed storage", async () => {
		const admission = new ResourceAdmission({ active: 1, tools: 1, residentPerRoot: 1, sealedBytesPerRoot: 100 });
		const execution = await admission.acquire("a", "node");
		const tool = await admission.acquire("a", "tool", undefined, "tool");
		expect(admission.view("a")).toMatchObject({ active: 1, tools: 1 });
		admission.retain("a", "producer");
		admission.retain("a", "producer");
		expect(() => admission.retain("a", "other")).toThrow("retained participant limit");
		admission.checkSealedBytes("a", 0, 60);
		expect(() => admission.checkSealedBytes("a", 0, 50)).toThrow("sealed storage");
		expect(() => admission.releaseRoot("a")).toThrow("execution is active");
		tool();
		execution();
		admission.releaseRoot("a");
		expect(admission.view("a").resident).toBe(0);
	});
});
