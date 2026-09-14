// 管理节点与持续 Pi AgentSession 的唯一绑定和轮次派发。
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

export interface NodeSessionHandle {
	readonly sessionId: string;
	readonly isIdle: boolean;
	prompt(text: string): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	subscribe(listener: (event: AgentSessionEvent) => void): () => void;
}

export interface NodeSessionFactory<TCreateInput> {
	create(input: TCreateInput): Promise<NodeSessionHandle>;
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
	roundId?: string;
	event: AgentSessionEvent;
}

export type NodeSessionBindingStatus = "idle" | "active" | "lost" | "released";

export interface NodeSessionBindingSnapshot {
	runId: string;
	nodeId: string;
	participantId: string;
	sessionId: string;
	status: NodeSessionBindingStatus;
	activeRoundId?: string;
}

export interface NodeSessionRoundLimits {
	maxToolCalls?: number;
	maxToolErrors?: number;
}

interface BindingRecord {
	runId: string;
	nodeId: string;
	participantId: string;
	session: NodeSessionHandle;
	status: NodeSessionBindingStatus;
	activeRoundId?: string;
	toolCalls: number;
	toolErrors: number;
	limitError?: Error;
	unsubscribe: () => void;
}

const bindingKey = (runId: string, nodeId: string, participantId: string) => `${runId}\0${nodeId}\0${participantId}`;

export class NodeSessionAdapter<TCreateInput> {
	private readonly bindings = new Map<string, BindingRecord>();
	private readonly creations = new Map<string, Promise<BindingRecord>>();
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

	async create(input: NodeSessionBindingInput<TCreateInput>): Promise<NodeSessionBindingSnapshot> {
		const key = bindingKey(input.runId, input.nodeId, input.participantId);
		const existing = this.bindings.get(key);
		if (existing) {
			if (existing.status === "lost" || existing.status === "released")
				throw new Error(
					`Node Session ${input.runId}/${input.nodeId}/${input.participantId} is ${existing.status} and cannot be recreated`,
				);
			return this.snapshot(existing);
		}
		const pending = this.creations.get(key);
		if (pending) return this.snapshot(await pending);
		const creation = (async () => {
			const session = await this.factory.create(input.createInput);
			const record: BindingRecord = {
				runId: input.runId,
				nodeId: input.nodeId,
				participantId: input.participantId,
				session,
				status: "idle",
				toolCalls: 0,
				toolErrors: 0,
				unsubscribe: () => {},
			};
			record.unsubscribe = session.subscribe((event) => {
				if (record.activeRoundId && event.type === "tool_execution_start") {
					record.toolCalls++;
					if (this.limits.maxToolCalls !== undefined && record.toolCalls > this.limits.maxToolCalls) {
						record.limitError = new Error(
							`Round ${record.activeRoundId} exceeded ${this.limits.maxToolCalls} tool calls`,
						);
						void record.session.abort().catch(() => {});
					}
				}
				if (record.activeRoundId && event.type === "tool_execution_end" && event.isError) {
					record.toolErrors++;
					if (this.limits.maxToolErrors !== undefined && record.toolErrors > this.limits.maxToolErrors) {
						record.limitError = new Error(
							`Round ${record.activeRoundId} exceeded ${this.limits.maxToolErrors} tool errors`,
						);
						void record.session.abort().catch(() => {});
					}
				}
				this.onEvent({
					runId: record.runId,
					nodeId: record.nodeId,
					participantId: record.participantId,
					roundId: record.activeRoundId,
					event,
				});
			});
			this.bindings.set(key, record);
			return record;
		})();
		this.creations.set(key, creation);
		try {
			return this.snapshot(await creation);
		} finally {
			if (this.creations.get(key) === creation) this.creations.delete(key);
		}
	}

	async dispatch(
		runId: string,
		nodeId: string,
		participantId: string,
		roundId: string,
		prompt: string,
	): Promise<void> {
		const record = this.requireActiveBinding(runId, nodeId, participantId);
		if (record.status !== "idle" || !record.session.isIdle)
			throw new Error(`Node Session ${runId}/${nodeId}/${participantId} already has an active round`);
		record.status = "active";
		record.activeRoundId = roundId;
		record.toolCalls = 0;
		record.toolErrors = 0;
		record.limitError = undefined;
		let dispatchError: unknown;
		try {
			await record.session.prompt(prompt);
		} catch (error) {
			dispatchError = error;
		} finally {
			if (record.status === "active" && record.activeRoundId === roundId) {
				record.status = "idle";
				record.activeRoundId = undefined;
			}
		}
		if (record.limitError) throw record.limitError;
		if (dispatchError) throw dispatchError;
	}

	async stop(runId: string, nodeId: string, participantId: string, roundId: string): Promise<void> {
		const record = this.requireActiveBinding(runId, nodeId, participantId);
		if (record.activeRoundId !== roundId)
			throw new Error(`Round ${roundId} is not active on ${runId}/${nodeId}/${participantId}`);
		await record.session.abort();
		if (record.status !== "lost") {
			record.status = "idle";
			record.activeRoundId = undefined;
		}
	}

	markLost(runId: string, nodeId: string, participantId: string): void {
		const record = this.requireActiveBinding(runId, nodeId, participantId);
		record.status = "lost";
		record.activeRoundId = undefined;
	}

	async release(runId: string, nodeId: string, participantId: string): Promise<void> {
		const record = this.requireActiveBinding(runId, nodeId, participantId);
		if (record.status === "active") await record.session.abort();
		record.unsubscribe();
		record.session.dispose();
		record.status = "released";
		record.activeRoundId = undefined;
	}

	inspect(runId: string, nodeId: string, participantId: string): NodeSessionBindingSnapshot | undefined {
		const record = this.bindings.get(bindingKey(runId, nodeId, participantId));
		return record ? this.snapshot(record) : undefined;
	}

	private requireActiveBinding(runId: string, nodeId: string, participantId: string): BindingRecord {
		const record = this.bindings.get(bindingKey(runId, nodeId, participantId));
		if (!record) throw new Error(`Node Session is not bound: ${runId}/${nodeId}/${participantId}`);
		if (record.status === "lost" || record.status === "released")
			throw new Error(`Node Session ${runId}/${nodeId}/${participantId} is ${record.status}`);
		return record;
	}

	private snapshot(record: BindingRecord): NodeSessionBindingSnapshot {
		return {
			runId: record.runId,
			nodeId: record.nodeId,
			participantId: record.participantId,
			sessionId: record.session.sessionId,
			status: record.status,
			activeRoundId: record.activeRoundId,
		};
	}
}
