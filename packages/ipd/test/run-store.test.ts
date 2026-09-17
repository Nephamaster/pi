import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname as dirnameForTest, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { compileWorkflow } from "../src/compiler/compiler.ts";
import { FileRunStore, prepareRunDirectory, type RunState } from "../src/index.ts";
import { createCompilerFixture } from "./fixtures.ts";

describe("FileRunStore", () => {
	const roots: string[] = [];

	it("stores static assets once and hydrates the same public state after reopening", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-static-state-"));
		roots.push(root);
		const fixture = createCompilerFixture();
		const compiled = compileWorkflow(fixture);
		if (!compiled.ok) throw new Error("Invalid fixture");
		const directory = await prepareRunDirectory(root, fixture.runId);
		const store = new FileRunStore();
		store.bind(fixture.runId, directory.stateFile);
		await store.create({
			runId: fixture.runId,
			revision: 0,
			phase: "execute",
			status: "running",
			baseline: compiled.baseline,
			taskInput: fixture.taskInput,
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		});
		const before = await readdir(join(dirnameForTest(directory.stateFile), "objects"));
		await store.mutate(fixture.runId, "progress", {}, (draft, event) => {
			draft.status = "paused";
			event.emit("run_paused");
			return true;
		});
		const raw = JSON.parse(await readFile(directory.stateFile, "utf8"));
		expect(raw.baseline).toBeUndefined();
		expect(raw.staticRefs.baseline).toMatch(/^[a-f0-9]{64}$/);
		expect(await readdir(join(dirnameForTest(directory.stateFile), "objects"))).toEqual(before);
		const reopened = new FileRunStore();
		reopened.bind(fixture.runId, directory.stateFile);
		const restored = await reopened.read(fixture.runId);
		expect(restored.baseline).toEqual(compiled.baseline);
		expect(restored.taskInput).toEqual(fixture.taskInput);
		expect(restored.status).toBe("paused");
		expect(restored.events).toHaveLength(1);
		await writeFile(join(dirnameForTest(directory.stateFile), "objects", `${raw.staticRefs.baseline}.json`), "{}");
		const corrupt = new FileRunStore();
		corrupt.bind(fixture.runId, directory.stateFile);
		await expect(corrupt.read(fixture.runId)).rejects.toThrow("Corrupt Run object");
	});
	afterEach(async () => Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))));

	it("serializes mutations and reuses an identical operation result", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-run-store-"));
		roots.push(root);
		const directory = await prepareRunDirectory(root, "run-1");
		const store = new FileRunStore();
		store.bind("run-1", directory.stateFile);
		const state: RunState = {
			runId: "run-1",
			revision: 0,
			phase: "intake",
			status: "running",
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		};
		await store.create(state);
		const mutate = (operationId: string) =>
			store.mutate("run-1", operationId, { action: "advance" }, (draft, context) => {
				draft.phase = "selection";
				context.emit("phase_changed", { phase: draft.phase });
				return { revision: draft.revision + 1 };
			});
		const [first, second] = await Promise.all([mutate("op-1"), mutate("op-2")]);
		expect([first.revision, second.revision].sort()).toEqual([1, 2]);
		expect(await mutate("op-1")).toEqual(first);
		const saved = await store.read("run-1");
		expect(saved.revision).toBe(2);
		expect(saved.events.map((event) => event.sequence)).toEqual([1, 2]);
	});

	it("does not manufacture state when persistent storage is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-run-store-missing-"));
		roots.push(root);
		const store = new FileRunStore();
		store.bind("run-1", join(root, "missing", "state.json"));
		await expect(
			store.create({
				runId: "run-1",
				revision: 0,
				phase: "intake",
				status: "running",
				nodes: [],
				rounds: [],
				submissions: [],
				reviews: [],
				approvals: [],
				mechanicalChecks: [],
				events: [],
				operations: {},
			}),
		).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("does not reject a committed mutation when a subscriber fails", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-run-store-notify-"));
		roots.push(root);
		const directory = await prepareRunDirectory(root, "run-1");
		const errors: string[] = [];
		const store = new FileRunStore({
			onNotificationError: (error) => errors.push(error instanceof Error ? error.message : String(error)),
		});
		store.bind("run-1", directory.stateFile);
		await store.create({
			runId: "run-1",
			revision: 0,
			phase: "intake",
			status: "running",
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		});
		store.subscribe("run-1", () => {
			throw new Error("listener failed");
		});
		await expect(
			store.mutate("run-1", "finish", { action: "finish" }, (draft, event) => {
				draft.status = "succeeded";
				event.emit("run_succeeded");
				return true;
			}),
		).resolves.toBe(true);
		expect((await store.read("run-1")).status).toBe("succeeded");
		expect(errors).toEqual(["listener failed"]);
		expect(store.readNotificationErrors()).toMatchObject([
			{ runId: "run-1", message: "listener failed", eventSequences: [1] },
		]);
	});

	it("fails closed on another writer and reports mutation size and duration", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-run-store-writer-"));
		roots.push(root);
		const directory = await prepareRunDirectory(root, "run-1");
		const metrics: Array<{ operationId: string; stateBytes: number; durationMs: number }> = [];
		const store = new FileRunStore({ onMutationMetric: (metric) => metrics.push(metric) });
		store.bind("run-1", directory.stateFile);
		await store.create({
			runId: "run-1",
			revision: 0,
			phase: "intake",
			status: "running",
			nodes: [],
			rounds: [],
			submissions: [],
			reviews: [],
			approvals: [],
			mechanicalChecks: [],
			events: [],
			operations: {},
		});
		await store.mutate("run-1", "measure", { action: "measure" }, () => true);
		expect(metrics).toEqual([
			expect.objectContaining({
				operationId: "measure",
				stateBytes: expect.any(Number),
				durationMs: expect.any(Number),
			}),
		]);
		expect(metrics[0].stateBytes).toBeGreaterThan(0);

		await writeFile(`${directory.stateFile}.writer.lock`, "another-process\n");
		await expect(store.mutate("run-1", "conflict", { action: "conflict" }, () => true)).rejects.toThrow(
			"Run writer conflict",
		);
	});
});
