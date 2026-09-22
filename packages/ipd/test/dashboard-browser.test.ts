import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import type { RunState } from "../src/contracts/runtime.ts";
import { buildDashboardSnapshot } from "../src/visualization/dashboard-model.ts";
import { renderDashboardPage } from "../src/visualization/dashboard-page.ts";
import { IpdDashboardServer } from "../src/visualization/dashboard-server.ts";
import { createCompilerFixture, createEmptyRuntimeRecords } from "./fixtures.ts";

const chrome = process.env.PI_IPD_CHROME;
describe.runIf(chrome && existsSync(chrome))("real dashboard browser", () => {
	it("updates a live page and renders the same snapshot without a backend", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-browser-"));
		const fixture = createCompilerFixture();
		const state: RunState = {
			...createEmptyRuntimeRecords(),
			runId: fixture.runId,
			revision: 1,
			phase: "execute",
			status: "running",
			taskInput: fixture.taskInput,
			workflowCandidate: fixture.workflow,
			processSelection: fixture.processSelection,
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};
		let reads = 0;
		const server = new IpdDashboardServer({
			projectRoot: root,
			processSpecs: [fixture.processSpec],
			getRun: async () => {
				reads++;
				if (reads > 1) {
					state.revision = 2;
					state.phase = "closed";
					state.status = "succeeded";
				}
				return structuredClone(state);
			},
		});
		const dump = async (url: string, profile: string) =>
			(
				await promisify(execFile)(
					chrome!,
					[
						"--headless",
						"--no-sandbox",
						"--disable-gpu",
						"--disable-dev-shm-usage",
						"--no-first-run",
						`--user-data-dir=${join(root, profile)}`,
						"--virtual-time-budget=8000",
						"--dump-dom",
						url,
					],
					{ timeout: 30_000, maxBuffer: 2 * 1024 * 1024 },
				)
			).stdout;
		try {
			const link = await server.registerRun(fixture.runId);
			const live = await dump(link.url, "live-profile");
			expect(reads).toBeGreaterThan(1);
			expect(live.match(/id="generated-at"[^>]*>([^<]*)/)?.[1]).toContain("状态版本 2");
			expect(live).toContain("状态 <b>已成功</b>");
			const snapshot = buildDashboardSnapshot(state, [fixture.processSpec]);
			const file = join(root, "snapshot.html");
			await writeFile(file, renderDashboardPage({ runId: state.runId, initialSnapshot: snapshot }));
			await server.close();
			const offline = await dump(`file://${file}`, "offline-profile");
			expect(offline).toContain('id="live-label">离线快照</span>');
			expect(offline).toContain("状态 <b>已成功</b>");
			expect(offline).toContain('<g class="graph-node"');
		} finally {
			await server.close();
			await rm(root, { recursive: true, force: true });
		}
	}, 60_000);
});
