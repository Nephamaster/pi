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

	it("treats Bash as an exclusive whole-workspace writer", async () => {
		const manager = new WorkspaceLockManager();
		const reader = await manager.acquire({ ownerId: "reader", readScopes: ["inputs"], writeScopes: [] });
		let acquired = false;
		const bashPromise = manager
			.acquire({ ownerId: "bash", readScopes: [], writeScopes: [], usesBash: true })
			.then((handle) => {
				acquired = true;
				return handle;
			});
		await Promise.resolve();
		expect(acquired).toBe(false);
		reader.release();
		const bash = await bashPromise;
		expect(manager.getActiveOwners()).toEqual(["bash"]);
		bash.release();
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
