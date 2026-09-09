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

interface BindingRecord {
	runId: string;
	nodeId: string;
	participantId: string;
	session: NodeSessionHandle;
	status: NodeSessionBindingStatus;
	activeRoundId?: string;
	unsubscribe: () => void;
}

const bindingKey = (runId: string, nodeId: string, participantId: string) => `${runId}\0${nodeId}\0${participantId}`;

export class NodeSessionAdapter<TCreateInput> {
	private readonly bindings = new Map<string, BindingRecord>();
	private readonly creations = new Map<string, Promise<BindingRecord>>();
	private readonly factory: NodeSessionFactory<TCreateInput>;
	private readonly onEvent: (event: NodeSessionEventEnvelope) => void;

	constructor(
		factory: NodeSessionFactory<TCreateInput>,
		onEvent: (event: NodeSessionEventEnvelope) => void = () => {},
	) {
		this.factory = factory;
		this.onEvent = onEvent;
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
				unsubscribe: () => {},
			};
			record.unsubscribe = session.subscribe((event) => {
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
		try {
			await record.session.prompt(prompt);
		} finally {
			if (record.status === "active" && record.activeRoundId === roundId) {
				record.status = "idle";
				record.activeRoundId = undefined;
			}
		}
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
