import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FileRunStore, prepareRunDirectory, type RunState } from "../src/index.ts";

describe("FileRunStore", () => {
	const roots: string[] = [];
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
});
