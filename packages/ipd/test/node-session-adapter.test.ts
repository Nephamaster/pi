import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { NodeSessionAdapter, type NodeSessionFactory, type NodeSessionHandle } from "../src/index.ts";

class FakeSession implements NodeSessionHandle {
	readonly sessionId: string;
	isIdle = true;
	disposed = false;
	hold = false;
	readonly prompts: string[] = [];
	private listeners: Array<(event: AgentSessionEvent) => void> = [];
	private resume?: () => void;

	constructor(sessionId = "session-1") {
		this.sessionId = sessionId;
	}

	async prompt(text: string): Promise<void> {
		this.isIdle = false;
		this.prompts.push(text);
		this.emit({ type: "agent_settled" });
		if (this.hold) {
			await new Promise<void>((resolve) => {
				this.resume = resolve;
			});
		}
		this.isIdle = true;
	}

	async abort(): Promise<void> {
		this.hold = false;
		this.resume?.();
		this.resume = undefined;
		this.isIdle = true;
	}

	dispose(): void {
		this.disposed = true;
	}

	subscribe(listener: (event: AgentSessionEvent) => void): () => void {
		this.listeners.push(listener);
		return () => {
			this.listeners = this.listeners.filter((item) => item !== listener);
		};
	}

	private emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) listener(event);
	}
}

class FakeFactory implements NodeSessionFactory<string> {
	readonly session = new FakeSession();
	createCount = 0;

	async create(): Promise<NodeSessionHandle> {
		this.createCount++;
		return this.session;
	}
}

class DelayedFactory implements NodeSessionFactory<string> {
	createCount = 0;
	private releaseCreation?: () => void;
	private readonly barrier = new Promise<void>((resolve) => {
		this.releaseCreation = resolve;
	});

	release(): void {
		this.releaseCreation?.();
	}

	async create(): Promise<NodeSessionHandle> {
		this.createCount++;
		await this.barrier;
		return new FakeSession(`session-${this.createCount}`);
	}
}

describe("NodeSessionAdapter", () => {
	it("keeps one Session bound across multiple work rounds", async () => {
		const factory = new FakeFactory();
		const rounds: Array<string | undefined> = [];
		const adapter = new NodeSessionAdapter(factory, (event) => rounds.push(event.roundId));
		const first = await adapter.create({
			runId: "run-1",
			nodeId: "node-1",
			participantId: "p1",
			createInput: "config",
		});
		const repeated = await adapter.create({
			runId: "run-1",
			nodeId: "node-1",
			participantId: "p1",
			createInput: "ignored",
		});
		await adapter.dispatch("run-1", "node-1", "p1", "round-1", "first task");
		await adapter.dispatch("run-1", "node-1", "p1", "round-2", "rework task");
		expect(first.sessionId).toBe(repeated.sessionId);
		expect(factory.createCount).toBe(1);
		expect(factory.session.prompts).toEqual(["first task", "rework task"]);
		expect(rounds).toEqual(["round-1", "round-2"]);
	});

	it("does not silently recreate a released or lost Session", async () => {
		const factory = new FakeFactory();
		const adapter = new NodeSessionAdapter(factory);
		await adapter.create({ runId: "run-1", nodeId: "node-1", participantId: "p1", createInput: "config" });
		await adapter.release("run-1", "node-1", "p1");
		expect(factory.session.disposed).toBe(true);
		await expect(
			adapter.create({ runId: "run-1", nodeId: "node-1", participantId: "p1", createInput: "config" }),
		).rejects.toThrow("cannot be recreated");

		const secondFactory = new FakeFactory();
		const second = new NodeSessionAdapter(secondFactory);
		await second.create({ runId: "run-1", nodeId: "node-2", participantId: "p1", createInput: "config" });
		second.markLost("run-1", "node-2", "p1");
		await expect(
			second.create({ runId: "run-1", nodeId: "node-2", participantId: "p1", createInput: "config" }),
		).rejects.toThrow("cannot be recreated");
	});

	it("stops one round without destroying the Session or allowing concurrent rounds", async () => {
		const factory = new FakeFactory();
		const adapter = new NodeSessionAdapter(factory);
		await adapter.create({ runId: "run-1", nodeId: "node-1", participantId: "p1", createInput: "config" });
		factory.session.hold = true;
		const running = adapter.dispatch("run-1", "node-1", "p1", "round-1", "long task");
		await Promise.resolve();
		await expect(adapter.dispatch("run-1", "node-1", "p1", "round-2", "overlap")).rejects.toThrow("active round");
		await adapter.stop("run-1", "node-1", "p1", "round-1");
		await running;
		expect(factory.session.disposed).toBe(false);
		await adapter.dispatch("run-1", "node-1", "p1", "round-2", "continue");
		expect(factory.session.prompts).toEqual(["long task", "continue"]);
	});

	it("coalesces concurrent creation of the same binding", async () => {
		const factory = new DelayedFactory();
		const adapter = new NodeSessionAdapter(factory);
		const input = { runId: "run-1", nodeId: "node-1", participantId: "p1", createInput: "config" };
		const first = adapter.create(input);
		const second = adapter.create(input);
		await Promise.resolve();
		expect(factory.createCount).toBe(1);
		factory.release();
		expect((await first).sessionId).toBe((await second).sessionId);
		expect(factory.createCount).toBe(1);
	});
});
