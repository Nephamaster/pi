import { open, readFile, rename } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue } from "../contracts/primitives.ts";
import type { RunEvent, RunState } from "../contracts/runtime.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";

export interface RunMutationContext {
	emit(type: string, data?: JsonValue, nodeId?: string, roundId?: string): void;
}

export interface RunStore {
	create(state: RunState): Promise<void>;
	read(runId: string): Promise<RunState>;
	mutate<T extends JsonValue>(
		runId: string,
		operationId: string,
		request: JsonValue,
		apply: (draft: RunState, context: RunMutationContext) => T,
	): Promise<T>;
}

export interface FileRunStoreOptions {
	onNotificationError?: (error: unknown, runId: string, events: readonly RunEvent[]) => void;
}

export interface RunNotificationError {
	runId: string;
	message: string;
	eventSequences: number[];
	timestamp: number;
}

export class FileRunStore implements RunStore {
	private readonly stateFiles = new Map<string, string>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly listeners = new Map<string, Set<(events: readonly RunEvent[]) => void>>();
	private readonly onNotificationError: NonNullable<FileRunStoreOptions["onNotificationError"]>;
	private readonly notificationErrors: RunNotificationError[] = [];

	constructor(options: FileRunStoreOptions = {}) {
		this.onNotificationError = options.onNotificationError ?? (() => {});
	}

	bind(runId: string, stateFile: string): void {
		this.stateFiles.set(runId, stateFile);
	}

	subscribe(runId: string, listener: (events: readonly RunEvent[]) => void): () => void {
		const listeners = this.listeners.get(runId) ?? new Set();
		listeners.add(listener);
		this.listeners.set(runId, listeners);
		return () => listeners.delete(listener);
	}

	readNotificationErrors(): readonly RunNotificationError[] {
		return structuredClone(this.notificationErrors);
	}

	async create(state: RunState): Promise<void> {
		const path = this.requirePath(state.runId);
		try {
			const file = await open(path, "wx");
			try {
				await file.writeFile(`${JSON.stringify(state, null, "\t")}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST") throw new Error(`Run already exists: ${state.runId}`);
			throw error;
		}
	}

	async read(runId: string): Promise<RunState> {
		return JSON.parse(await readFile(this.requirePath(runId), "utf8")) as RunState;
	}

	async mutate<T extends JsonValue>(
		runId: string,
		operationId: string,
		request: JsonValue,
		apply: (draft: RunState, context: RunMutationContext) => T,
	): Promise<T> {
		let result: T | undefined;
		await this.enqueue(runId, async () => {
			const state = await this.read(runId);
			const requestHash = hashJson(request);
			const previous = state.operations[operationId];
			if (previous) {
				if (previous.requestHash !== requestHash) throw new Error(`Operation ID conflict: ${operationId}`);
				result = previous.result as T;
				return;
			}
			const draft = structuredClone(state);
			const pendingEvents: RunEvent[] = [];
			result = apply(draft, {
				emit: (type, data = null, nodeId, roundId) => {
					pendingEvents.push({
						sequence: draft.events.length + pendingEvents.length + 1,
						type,
						timestamp: Date.now(),
						nodeId,
						roundId,
						data,
					});
				},
			});
			draft.revision++;
			draft.events.push(...pendingEvents);
			draft.operations[operationId] = { requestHash, result: toJsonValue(result) };
			await this.write(this.requirePath(runId), draft);
			for (const listener of this.listeners.get(runId) ?? []) {
				try {
					listener(pendingEvents);
				} catch (error) {
					this.notificationErrors.push({
						runId,
						message: error instanceof Error ? error.message : String(error),
						eventSequences: pendingEvents.map((event) => event.sequence),
						timestamp: Date.now(),
					});
					try {
						this.onNotificationError(error, runId, pendingEvents);
					} catch {
						// Notification reporting cannot change the already committed mutation result.
					}
				}
			}
		});
		if (result === undefined) throw new Error(`Operation produced no result: ${operationId}`);
		return result;
	}

	private requirePath(runId: string): string {
		const path = this.stateFiles.get(runId);
		if (!path) throw new Error(`RunStore is not bound to ${runId}`);
		return path;
	}

	private async write(path: string, state: RunState): Promise<void> {
		const temporary = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`);
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(`${JSON.stringify(state, null, "\t")}\n`, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
	}

	private async enqueue(runId: string, operation: () => Promise<void>): Promise<void> {
		const previous = this.queues.get(runId) ?? Promise.resolve();
		const current = previous.catch(() => {}).then(operation);
		this.queues.set(runId, current);
		try {
			await current;
		} finally {
			if (this.queues.get(runId) === current) this.queues.delete(runId);
		}
	}
}
