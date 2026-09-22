// 以文件事务保存 Run 状态、幂等操作和顺序事件。
import { randomUUID } from "node:crypto";
import { link, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { NOOP_TELEMETRY_CONTEXT, type TelemetryContext } from "@earendil-works/pi-telemetry";
import type { JsonValue } from "../contracts/primitives.ts";
import type { RunEvent, RunState } from "../contracts/runtime.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { syncDirectory } from "./durable-file.ts";
import { requireCurrentRunState } from "./execution-control.ts";
import { RunSnapshotCodec } from "./run-snapshot.ts";

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
	telemetryContext?: TelemetryContext;
	onNotificationError?: (error: unknown, runId: string, events: readonly RunEvent[]) => void;
	onMutationMetric?: (metric: RunMutationMetric) => void;
	staleLockMs?: number;
	writerLockTimeoutMs?: number;
}

export interface RunMutationMetric {
	runId: string;
	operationId: string;
	durationMs: number;
	stateBytes: number;
	eventCount: number;
}

export interface RunNotificationError {
	runId: string;
	message: string;
	eventSequences: number[];
	timestamp: number;
}

export class RunAlreadyExistsError extends Error {
	constructor(runId: string, options?: ErrorOptions) {
		super(`Run already exists: ${runId}`, options);
		this.name = "RunAlreadyExistsError";
	}
}

async function processIdentity(pid: number): Promise<string | undefined> {
	if (process.platform === "linux") {
		try {
			const value = await readFile(`/proc/${pid}/stat`, "utf8");
			const closing = value.lastIndexOf(")");
			const fields =
				closing < 0
					? []
					: value
							.slice(closing + 2)
							.trim()
							.split(/\s+/);
			const startTime = fields[19];
			return startTime ? `linux:${pid}:${startTime}` : undefined;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
	}
	try {
		process.kill(pid, 0);
		return `pid:${pid}`;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ESRCH") return undefined;
		throw error;
	}
}

async function staleWriterLock(lockPath: string, staleLockMs: number): Promise<boolean> {
	const before = await stat(lockPath, { bigint: true });
	if (Date.now() - Number(before.mtimeMs) < staleLockMs) return false;
	const content = await readFile(lockPath, "utf8");
	let record: { pid?: unknown; processIdentity?: unknown } = {};
	try {
		record = JSON.parse(content) as typeof record;
	} catch {
		// An aged partial lock is recoverable only after the identity/age checks below.
	}
	const pid =
		typeof record.pid === "number" && Number.isInteger(record.pid) && record.pid > 0 ? record.pid : undefined;
	const expectedIdentity = typeof record.processIdentity === "string" ? record.processIdentity : undefined;
	if (pid !== undefined && expectedIdentity !== undefined && (await processIdentity(pid)) === expectedIdentity)
		return false;
	const current = await stat(lockPath, { bigint: true });
	const currentContent = await readFile(lockPath, "utf8");
	if (
		before.ino !== current.ino ||
		before.mtimeNs !== current.mtimeNs ||
		before.size !== current.size ||
		content !== currentContent
	)
		return false;
	try {
		await unlink(lockPath);
		return true;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
		throw error;
	}
}

export class FileRunStore implements RunStore {
	private readonly telemetry: TelemetryContext;
	private readonly codec = new RunSnapshotCodec();
	private readonly stateFiles = new Map<string, string>();
	private readonly queues = new Map<string, Promise<void>>();
	private readonly listeners = new Map<string, Set<(events: readonly RunEvent[]) => void>>();
	private readonly onNotificationError: NonNullable<FileRunStoreOptions["onNotificationError"]>;
	private readonly onMutationMetric: NonNullable<FileRunStoreOptions["onMutationMetric"]>;
	private readonly notificationErrors: RunNotificationError[] = [];
	private readonly staleLockMs: number;
	private readonly writerLockTimeoutMs: number;

	constructor(options: FileRunStoreOptions = {}) {
		this.telemetry = options.telemetryContext ?? NOOP_TELEMETRY_CONTEXT;
		this.onNotificationError = options.onNotificationError ?? (() => {});
		this.onMutationMetric = options.onMutationMetric ?? (() => {});
		this.staleLockMs = options.staleLockMs ?? 30_000;
		this.writerLockTimeoutMs = options.writerLockTimeoutMs ?? 5000;
		if (!Number.isFinite(this.staleLockMs) || this.staleLockMs < 0)
			throw new Error("staleLockMs must be a non-negative number");
		if (!Number.isFinite(this.writerLockTimeoutMs) || this.writerLockTimeoutMs < 0)
			throw new Error("writerLockTimeoutMs must be a non-negative number");
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
		requireCurrentRunState(state);
		const path = this.requirePath(state.runId);
		try {
			await this.withWriterLock(path, async () => {
				const content = await this.codec.encode(path, state);
				const file = await open(path, "wx");
				try {
					await file.writeFile(content, "utf8");
					await file.sync();
				} finally {
					await file.close();
				}
				await syncDirectory(dirname(path));
			});
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "EEXIST")
				throw new RunAlreadyExistsError(state.runId, { cause: error });
			throw error;
		}
	}

	async read(runId: string): Promise<RunState> {
		const path = this.requirePath(runId);
		return requireCurrentRunState(await this.codec.decode(path, await readFile(path, "utf8")));
	}

	async version(runId: string): Promise<string> {
		const file = await stat(this.requirePath(runId), { bigint: true });
		return `${file.ino}:${file.mtimeNs}:${file.size}`;
	}

	async mutate<T extends JsonValue>(
		runId: string,
		operationId: string,
		request: JsonValue,
		apply: (draft: RunState, context: RunMutationContext) => T,
	): Promise<T> {
		let result: T | undefined;
		await this.telemetry.startSpan({ name: "ipd.run.mutate", attributes: { runId } }, () =>
			this.enqueue(runId, async () => {
				const path = this.requirePath(runId);
				await this.withWriterLock(path, async () => {
					const startedAt = Date.now();
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
					const stateBytes = await this.write(path, draft);
					try {
						this.onMutationMetric({
							runId,
							operationId,
							durationMs: Date.now() - startedAt,
							stateBytes,
							eventCount: pendingEvents.length,
						});
					} catch {
						// Telemetry cannot affect an already committed mutation.
					}
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
			}),
		);
		if (result === undefined) throw new Error(`Operation produced no result: ${operationId}`);
		return result;
	}

	private requirePath(runId: string): string {
		const path = this.stateFiles.get(runId);
		if (!path) throw new Error(`RunStore is not bound to ${runId}`);
		return path;
	}

	private async write(path: string, state: RunState): Promise<number> {
		const content = await this.codec.encode(path, state);
		const temporary = join(dirname(path), `.state.${process.pid}.${Date.now()}.tmp`);
		const file = await open(temporary, "wx");
		try {
			await file.writeFile(content, "utf8");
			await file.sync();
		} finally {
			await file.close();
		}
		await rename(temporary, path);
		await syncDirectory(dirname(path));
		return Buffer.byteLength(content);
	}

	private async withWriterLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
		const lockPath = `${path}.writer.lock`;
		await this.claimWriterLock(path, lockPath);
		try {
			return await operation();
		} finally {
			await unlink(lockPath).catch((error) => {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			});
		}
	}

	private async claimWriterLock(path: string, lockPath: string): Promise<void> {
		const identity = await processIdentity(process.pid);
		if (!identity) throw new Error("Cannot determine the Run writer process identity");
		const temporary = `${lockPath}.${process.pid}.${randomUUID()}.tmp`;
		const lock = await open(temporary, "wx", 0o600);
		try {
			await lock.writeFile(
				`${JSON.stringify({ pid: process.pid, processIdentity: identity, createdAt: Date.now() })}\n`,
				"utf8",
			);
			await lock.sync();
		} finally {
			await lock.close();
		}
		const deadline = Date.now() + this.writerLockTimeoutMs;
		try {
			while (true) {
				try {
					await link(temporary, lockPath);
					return;
				} catch (error) {
					if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
					if (await staleWriterLock(lockPath, this.staleLockMs)) continue;
					const remaining = deadline - Date.now();
					if (remaining <= 0) throw new Error(`Run writer conflict: ${path}`);
					await delay(Math.min(25, remaining));
				}
			}
		} finally {
			await unlink(temporary).catch(() => {});
		}
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
