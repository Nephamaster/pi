import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SettingsManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { loadIpdSessionSettings, projectIpdSessionSettings } from "../src/adapter/session-policy.ts";
import { FileIpdTelemetry } from "../src/runtime/telemetry.ts";

describe("IPD native session policy", () => {
	const roots: string[] = [];
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("copies only native model/context fields and retains Pi defaults for unspecified settings", () => {
		const source = {
			retry: { enabled: true, maxRetries: 1, provider: { timeoutMs: 1000 } },
			compaction: { reserveTokens: 200, modelOverrides: { "faux/faux-1": { keepRecentTokens: 500 } } },
			httpIdleTimeoutMs: 2500,
			images: { autoResize: true },
			extensions: ["unsafe.ts"],
			packages: ["untrusted-package"],
			shellCommandPrefix: "unexpected-command",
			defaultTools: ["bash"],
		};
		const policy = projectIpdSessionSettings(source);
		expect(Object.keys(policy).sort()).toEqual(["compaction", "httpIdleTimeoutMs", "images", "retry"]);
		source.retry.provider.timeoutMs = 9999;
		source.compaction.modelOverrides["faux/faux-1"].keepRecentTokens = 9999;
		expect(policy.retry?.provider?.timeoutMs).toBe(1000);
		expect(policy.compaction?.modelOverrides?.["faux/faux-1"].keepRecentTokens).toBe(500);
		const settings = SettingsManager.inMemory(projectIpdSessionSettings());
		expect(settings.getRetrySettings().enabled).toBe(true);
		expect(settings.getCompactionSettings().enabled).toBe(true);
	});

	it("loads only global settings, rejects corrupt global JSON, and never reads node/project overrides", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-session-policy-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir);
		await mkdir(join(root, ".pi"));
		await writeFile(join(agentDir, "settings.json"), JSON.stringify({ retry: { maxRetries: 1 }, extensions: ["unsafe.ts"] }));
		await writeFile(join(root, ".pi", "settings.json"), "invalid-project-json");
		expect(loadIpdSessionSettings(root, agentDir)).toEqual({ retry: { maxRetries: 1 } });
		await writeFile(join(agentDir, "settings.json"), "invalid-global-json");
		expect(() => loadIpdSessionSettings(root, agentDir)).toThrow("Cannot load trusted Pi session settings");
	});

	it("projects native event metadata without logging messages, model errors or tool payloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-session-metrics-"));
		roots.push(root);
		const file = join(root, "metrics.ndjson");
		const telemetry = new FileIpdTelemetry(file);
		const identity = { runId: "run", nodeId: "node", participantId: "worker", roundId: "round" };
		telemetry.recordSessionEvent({ ...identity, event: { type: "auto_retry_start", attempt: 1, maxAttempts: 2, delayMs: 100, errorMessage: "private-provider-error" } });
		telemetry.recordSessionEvent({ ...identity, event: { type: "compaction_end", reason: "threshold", result: undefined, aborted: false, willRetry: false, errorMessage: "private-summary-error" } });
		telemetry.recordSessionEvent({ ...identity, event: { type: "tool_execution_end", toolCallId: "call", toolName: "read", isError: false, result: { content: [{ type: "text", text: "private-file-content" }], details: {} } } });
		telemetry.recordSessionEvent({ ...identity, event: { type: "agent_end", messages: [{ role: "user", content: "private-task", timestamp: 1 }], willRetry: false } });
		await telemetry.flush();
		const raw = await readFile(file, "utf8");
		const records = raw.trim().split("\n").map((line) => JSON.parse(line));
		expect(records).toHaveLength(3);
		expect(records.map((item) => item.eventType)).toEqual(["auto_retry_start", "compaction_end", "tool_execution_end"]);
		expect(records[0]).toMatchObject({ ...identity, source: "pi_session", data: { attempt: 1, maxAttempts: 2, delayMs: 100 } });
		expect(raw).not.toContain("private-");
	});
});
