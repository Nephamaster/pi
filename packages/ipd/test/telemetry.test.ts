import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileIpdTelemetry } from "../src/index.ts";

describe("FileIpdTelemetry", () => {
	const roots: string[] = [];
	it("exports passive Pi spans with metadata only and preserves callback rejection identity", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-spans-"));
		roots.push(root);
		const file = join(root, "metrics.ndjson");
		const telemetry = new FileIpdTelemetry(file);
		const error = new Error("secret-provider-error");
		let called = 0;
		await expect(
			telemetry.context({ runId: "run", apiKey: "secret-key" }).startSpan({ name: "ipd.test" }, (span) => {
				called++;
				span.setAttributes({ nodeId: "produce", prompt: "secret-task" });
				span.addEvent("ipd.step", { toolName: "read", payload: "secret-file" });
				throw error;
			}),
		).rejects.toBe(error);
		expect(called).toBe(1);
		await telemetry.flush();
		const text = await readFile(file, "utf8");
		expect(text).not.toContain("secret-");
		expect(JSON.parse(text)).toMatchObject({
			source: "pi_telemetry",
			status: "error",
			attributes: { runId: "run", nodeId: "produce" },
		});
	});
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("writes ordered metrics outside RunState", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-telemetry-"));
		roots.push(root);
		const file = join(root, "telemetry.ndjson");
		const telemetry = new FileIpdTelemetry(file);
		telemetry.record({
			source: "run_store",
			runId: "run-1",
			operationId: "op-1",
			durationMs: 3,
			stateBytes: 100,
			eventCount: 1,
		});
		telemetry.record({
			source: "workflow_runtime",
			type: "round_duration",
			runId: "run-1",
			nodeId: "node-1",
			roundId: "node-1:round:1",
			durationMs: 10,
		});
		await telemetry.flush();
		const metrics = (await readFile(file, "utf8"))
			.trim()
			.split("\n")
			.map((line) => JSON.parse(line));
		expect(metrics.map((metric) => metric.source)).toEqual(["run_store", "workflow_runtime"]);
		expect(metrics.every((metric) => typeof metric.timestamp === "number")).toBe(true);
	});
});
