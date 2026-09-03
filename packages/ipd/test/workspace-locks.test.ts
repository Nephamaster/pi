import { describe, expect, it } from "vitest";
import { WorkspaceLockManager } from "../src/index.ts";

describe("WorkspaceLockManager", () => {
	it("allows concurrent readers and non-overlapping writers", async () => {
		const manager = new WorkspaceLockManager();
		const firstRead = await manager.acquire({ ownerId: "read-1", readScopes: ["inputs"], writeScopes: [] });
		const secondRead = await manager.acquire({ ownerId: "read-2", readScopes: ["inputs"], writeScopes: [] });
		const firstWrite = await manager.acquire({ ownerId: "write-1", readScopes: [], writeScopes: ["outputs/a"] });
		const secondWrite = await manager.acquire({ ownerId: "write-2", readScopes: [], writeScopes: ["outputs/b"] });
		expect(manager.getActiveOwners()).toEqual(["read-1", "read-2", "write-1", "write-2"]);
		firstRead.release();
		secondRead.release();
		firstWrite.release();
		secondWrite.release();
	});

	it("serializes overlapping read/write scopes", async () => {
		const manager = new WorkspaceLockManager();
		const reader = await manager.acquire({ ownerId: "reader", readScopes: ["shared"], writeScopes: [] });
		let acquired = false;
		const writerPromise = manager
			.acquire({ ownerId: "writer", readScopes: [], writeScopes: ["shared/output"] })
			.then((handle) => {
				acquired = true;
				return handle;
			});
		await Promise.resolve();
		expect(acquired).toBe(false);
		reader.release();
		const writer = await writerPromise;
		expect(acquired).toBe(true);
		writer.release();
	});

	it("serializes overlapping writers without blocking an independent writer", async () => {
		const manager = new WorkspaceLockManager();
		const data = await manager.acquire({ ownerId: "data", readScopes: [], writeScopes: ["outputs/data"] });
		const design = await manager.acquire({ ownerId: "design", readScopes: [], writeScopes: ["outputs/design"] });
		let replacementAcquired = false;
		const replacementPromise = manager
			.acquire({ ownerId: "data-replacement", readScopes: [], writeScopes: ["outputs/data/charts"] })
			.then((handle) => {
				replacementAcquired = true;
				return handle;
			});
		await Promise.resolve();
		expect(manager.getActiveOwners()).toEqual(["data", "design"]);
		expect(replacementAcquired).toBe(false);
		data.release();
		const replacement = await replacementPromise;
		expect(replacementAcquired).toBe(true);
		design.release();
		replacement.release();
	});

	it("removes aborted pending requests", async () => {
		const manager = new WorkspaceLockManager();
		const writer = await manager.acquire({ ownerId: "writer", readScopes: [], writeScopes: ["shared"] });
		const controller = new AbortController();
		const pending = manager.acquire(
			{ ownerId: "reader", readScopes: ["shared"], writeScopes: [] },
			controller.signal,
		);
		controller.abort();
		await expect(pending).rejects.toMatchObject({ code: "aborted" });
		writer.release();
		expect(manager.getActiveOwners()).toEqual([]);
	});
});
