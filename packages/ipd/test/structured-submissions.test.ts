import Type from "typebox";
import { describe, expect, it } from "vitest";
import { createSubmissionTool, SubmissionCapture } from "../src/index.ts";

describe("SubmissionCapture", () => {
	it("returns the original receipt for an identical operation replay", () => {
		const capture = new SubmissionCapture<{ result: string }>();
		const first = capture.capture("operation-1", { result: "ok" });
		const replay = capture.capture("operation-1", { result: "ok" });
		expect(first.reused).toBe(false);
		expect(replay).toMatchObject({ operationId: first.operationId, contentHash: first.contentHash, reused: true });
		expect(capture.value).toEqual({ result: "ok" });
	});

	it("rejects operation ID reuse with different content", () => {
		const capture = new SubmissionCapture<{ result: string }>();
		capture.capture("operation-1", { result: "ok" });
		expect(() => capture.capture("operation-1", { result: "changed" })).toThrow("different operation or payload");
	});

	it("returns semantic validation feedback without terminating the Session", async () => {
		const capture = new SubmissionCapture<{ result: string }>();
		const tool = createSubmissionTool({
			name: "submit_test",
			label: "Submit test",
			description: "test",
			parameters: Type.Object({ result: Type.String() }),
			capture,
			validate: (value) => (value.result === "ok" ? [] : ["result must be ok"]),
		});
		const rejected = await tool.execute("call-1", { result: "bad" }, undefined, undefined, {} as never);
		expect(rejected).toMatchObject({ isError: true, details: { captured: false } });
		expect(rejected.terminate).toBeUndefined();
		expect(capture.value).toBeUndefined();
		const accepted = await tool.execute("call-2", { result: "ok" }, undefined, undefined, {} as never);
		expect(accepted).toMatchObject({ terminate: true, details: { captured: true } });
		expect(capture.value).toEqual({ result: "ok" });
	});
});
