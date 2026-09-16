// 统一登记原生 Session、节点业务绑定和正在派发的轮次。
import type { AgentSession, AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { NodeWorkerError } from "../runtime/node-worker.ts";

export type NodeSessionHandle = Pick<
	AgentSession,
	"sessionId" | "sessionFile" | "messages" | "isIdle" | "prompt" | "abort" | "dispose" | "subscribe"
>;

export interface NodeSessionFactory<TCreateInput> {
	create(input: TCreateInput): Promise<NodeSessionHandle>;
	validate?(input: TCreateInput): Promise<void>;
}

export interface NodeSessionBindingInput<TCreateInput> {
	runId: string;
	nodeId: string;
	participantId: string;
	createInput: TCreateInput;
}

export interface NodeSessionEventEnvelope {
	runId: string;
	nodeId: string;
	participantId: string;
	sessionId: string;
	sessionFile?: string;
	roundId?: string;
	event: AgentSessionEvent;
}

export type NodeSessionBindingStatus = "idle" | "active" | "lost" | "released";

export interface NodeSessionBindingSnapshot {
	runId: string;
	nodeId: string;
	participantId: string;
	sessionId: string;
	sessionFile?: string;
	status: NodeSessionBindingStatus;
	activeRoundId?: string;
}

export interface NodeSessionRoundLimits {
	maxToolCalls?: number;
	maxToolErrors?: number;
}

interface ActiveDispatch {
	roundId: string;
	cancelled: boolean;
	toolCalls: number;
	toolErrors: number;
	limitError?: Error;
}

interface BindingRecord<TState> {
	runId: string;
	nodeId: string;
	participantId: string;
	state?: TState;
	session?: NodeSessionHandle;
	creation?: Promise<void>;
	validate?: () => Promise<void>;
	unavailable?: "lost" | "released";
	active?: ActiveDispatch;
	unsubscribe?: () => void;
	cleanup?: Promise<void>;
	cleanupDone?: boolean;
}

interface RoundCallbacks<T> {
	prepare?(): void;
	result(): T;
}

const bindingKey = (runId: string, nodeId: string, participantId: string) => `${runId}\0${nodeId}\0${participantId}`;

export class NodeSessionAdapter<TCreateInput, TState = never> {
	private readonly bindings = new Map<string, BindingRecord<TState>>();
	private readonly factory: NodeSessionFactory<TCreateInput>;
	private readonly onEvent: (event: NodeSessionEventEnvelope) => void;
	private readonly limits: NodeSessionRoundLimits;

	constructor(
		factory: NodeSessionFactory<TCreateInput>,
		onEvent: (event: NodeSessionEventEnvelope) => void = () => {},
		limits: NodeSessionRoundLimits = {},
	) {
		this.factory = factory;
		this.onEvent = onEvent;
		this.limits = limits;
		for (const [name, value] of Object.entries(limits))
			if (value !== undefined && (!Number.isInteger(value) || value < 1))
				throw new Error(`${name} must be a positive integer`);
	}

	getState(runId: string, nodeId: string, participantId: string): TState | undefined {
		return this.bindings.get(bindingKey(runId, nodeId, participantId))?.state;
	}

	bindState(runId: string, nodeId: string, participantId: string, create: () => TState): TState {
		const record = this.register(runId, nodeId, participantId);
		if (record.active)
			throw new Error(`Node Session ${runId}/${nodeId}/${participantId} already has an active round`);
		record.state ??= create();
		return record.state;
	}

	async create(input: NodeSessionBindingInput<TCreateInput>): Promise<NodeSessionBindingSnapshot> {
		const record = this.register(input.runId, input.nodeId, input.participantId);
		if (!record.session) {
			if (!record.creation) {
				record.validate = () => this.factory.validate?.(input.createInput) ?? Promise.resolve();
				record.creation = this.factory.create(input.createInput).then((session) => {
					if (record.unavailable) {
						session.dispose();
						throw new NodeWorkerError(
							"session_lost",
							`Node Session is ${record.unavailable} and cannot be recreated`,
						);
					}
					record.session = session;
					record.unsubscribe = session.subscribe((event) => {
						const active = record.active;
						if (active) {
							if (event.type === "tool_execution_start") active.toolCalls++;
							if (event.type === "tool_execution_end" && event.isError) active.toolErrors++;
							if (!active.limitError) {
								if (this.limits.maxToolCalls !== undefined && active.toolCalls > this.limits.maxToolCalls)
									active.limitError = new Error(
										`Round ${active.roundId} exceeded ${this.limits.maxToolCalls} tool calls`,
									);
								if (this.limits.maxToolErrors !== undefined && active.toolErrors > this.limits.maxToolErrors)
									active.limitError = new Error(
										`Round ${active.roundId} exceeded ${this.limits.maxToolErrors} tool errors`,
									);
								if (active.limitError) void session.abort().catch(() => {});
							}
						}
						try {
							this.onEvent({
								runId: record.runId,
								nodeId: record.nodeId,
								participantId: record.participantId,
								sessionId: session.sessionId,
								sessionFile: session.sessionFile,
								roundId: active?.roundId,
								event,
							});
						} catch {
							// A diagnostic consumer cannot change native execution or submission outcomes.
						}
					});
				});
			}
			const creation = record.creation;
			try {
				await creation;
			} finally {
				if (record.creation === creation) record.creation = undefined;
			}
		}
		return this.snapshot(record);
	}

	dispatch(runId: string, nodeId: string, participantId: string, roundId: string, prompt: string): Promise<void>;
	dispatch<T>(
		runId: string,
		nodeId: string,
		participantId: string,
		roundId: string,
		prompt: string,
		callbacks: RoundCallbacks<T>,
	): Promise<T>;
	async dispatch<T>(
		runId: string,
		nodeId: string,
		participantId: string,
		roundId: string,
		prompt: string,
		callbacks?: RoundCallbacks<T>,
	): Promise<T | undefined> {
		const record = this.requireBinding(runId, nodeId, participantId);
		const session = record.session;
		if (!session) throw new NodeWorkerError("session_lost", "Node Session has not been created");
		if (record.active || !session.isIdle)
			throw new Error(`Node Session ${runId}/${nodeId}/${participantId} already has an active round`);
		const active: ActiveDispatch = { roundId, cancelled: false, toolCalls: 0, toolErrors: 0 };
		record.active = active;
		try {
			callbacks?.prepare?.();
			await record.validate?.();
			if (active.cancelled || record.unavailable)
				throw new NodeWorkerError("cancelled", `Round ${roundId} was cancelled before dispatch`);
			await session.prompt(prompt);
			if (active.limitError) throw active.limitError;
			if (active.cancelled || record.unavailable)
				throw new NodeWorkerError("cancelled", `Round ${roundId} was cancelled`);
			const last = session.messages.at(-1);
			if (last?.role === "assistant" && last.stopReason === "error")
				throw new NodeWorkerError(
					"transient",
					last.errorMessage ?? "Model request failed without an error message",
				);
			if (last?.role === "assistant" && last.stopReason === "aborted")
				throw new NodeWorkerError("cancelled", last.errorMessage ?? "Model request aborted");
			return callbacks?.result();
		} catch (error) {
			throw active.limitError ?? error;
		} finally {
			if (record.active === active) record.active = undefined;
		}
	}

	async stop(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void> {
		const record = this.requireBinding(runId, nodeId, participantId);
		if (record.active?.roundId !== roundId)
			throw new Error(`Round ${roundId} is not active on ${runId}/${nodeId}/${participantId}`);
		record.active.cancelled = true;
		await record.session?.abort();
	}

	markLost(runId: string, nodeId: string, participantId: string): void {
		this.requireBinding(runId, nodeId, participantId).unavailable = "lost";
	}

	async release(runId: string, nodeId: string, participantId: string): Promise<void> {
		const record = this.bindings.get(bindingKey(runId, nodeId, participantId));
		if (!record || record.cleanupDone) return;
		record.unavailable = "released";
		if (record.active) record.active.cancelled = true;
		record.cleanup ??= (async () => {
			await record.creation?.catch(() => {});
			await record.session?.abort();
			record.unsubscribe?.();
			record.session?.dispose();
			record.state = undefined;
			record.cleanupDone = true;
		})();
		const cleanup = record.cleanup;
		try {
			await cleanup;
		} finally {
			if (record.cleanup === cleanup) record.cleanup = undefined;
		}
	}

	async releaseRun(runId: string): Promise<void> {
		for (const record of this.bindings.values())
			if (record.runId === runId) await this.release(runId, record.nodeId, record.participantId);
	}

	inspect(runId: string, nodeId: string, participantId: string): NodeSessionBindingSnapshot | undefined {
		const record = this.bindings.get(bindingKey(runId, nodeId, participantId));
		return record?.session ? this.snapshot(record) : undefined;
	}

	private register(runId: string, nodeId: string, participantId: string): BindingRecord<TState> {
		const key = bindingKey(runId, nodeId, participantId);
		if (!this.bindings.has(key)) this.bindings.set(key, { runId, nodeId, participantId });
		return this.requireBinding(runId, nodeId, participantId);
	}

	private requireBinding(runId: string, nodeId: string, participantId: string): BindingRecord<TState> {
		const record = this.bindings.get(bindingKey(runId, nodeId, participantId));
		if (!record)
			throw new NodeWorkerError("session_lost", `Node Session is not bound: ${runId}/${nodeId}/${participantId}`);
		if (record.unavailable)
			throw new NodeWorkerError(
				"session_lost",
				`Node Session ${runId}/${nodeId}/${participantId} is ${record.unavailable} and cannot be recreated`,
			);
		return record;
	}

	private snapshot(record: BindingRecord<TState>): NodeSessionBindingSnapshot {
		if (!record.session) throw new NodeWorkerError("session_lost", "Node Session has not been created");
		return {
			runId: record.runId,
			nodeId: record.nodeId,
			participantId: record.participantId,
			sessionId: record.session.sessionId,
			sessionFile: record.session.sessionFile,
			status: record.unavailable ?? (record.active ? "active" : "idle"),
			activeRoundId: record.active?.roundId,
		};
	}
}
