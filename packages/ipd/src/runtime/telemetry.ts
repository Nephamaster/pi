// 将低频聚合运行指标写入独立 NDJSON，避免扩大权威 RunState。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NodeSessionEventEnvelope } from "../adapter/node-session-adapter.ts";
import type { RunMutationMetric } from "./run-store.ts";
import type { WorkflowRuntimeMetric } from "./workflow-runtime.ts";

export type IpdTelemetryMetric =
	| ({ source: "run_store" } & RunMutationMetric)
	| ({ source: "workflow_runtime" } & WorkflowRuntimeMetric)
	| (Pick<NodeSessionEventEnvelope, "runId" | "nodeId" | "participantId" | "roundId"> & {
			source: "pi_session";
			eventType: NodeSessionEventEnvelope["event"]["type"];
			data: Record<string, string | number | boolean>;
	  });

export class FileIpdTelemetry {
	private readonly file: string;
	private readonly onError: (error: unknown) => void;
	private queue: Promise<void> = Promise.resolve();

	constructor(file: string, onError: (error: unknown) => void = () => {}) {
		this.file = file;
		this.onError = onError;
	}

	/** Project native events, never prompts, tool payloads, images, summaries or provider errors. */
	recordSessionEvent(envelope: NodeSessionEventEnvelope): void {
		const { runId, nodeId, participantId, roundId, event } = envelope;
		let data: Record<string, string | number | boolean>;
		switch (event.type) {
			case "agent_start":
			case "agent_settled":
				data = {};
				break;
			case "auto_retry_start":
				data = { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs };
				break;
			case "auto_retry_end":
				data = { success: event.success, attempt: event.attempt };
				break;
			case "compaction_start":
				data = { reason: event.reason };
				break;
			case "compaction_end":
				data = {
					reason: event.reason,
					aborted: event.aborted,
					willRetry: event.willRetry,
					succeeded: event.result !== undefined,
				};
				break;
			case "tool_execution_end":
				data = { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError };
				break;
			default:
				return;
		}
		this.record({ source: "pi_session", runId, nodeId, participantId, roundId, eventType: event.type, data });
	}

	record(metric: IpdTelemetryMetric): void {
		const line = `${JSON.stringify({ timestamp: Date.now(), ...metric })}\n`;
		this.queue = this.queue
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				await appendFile(this.file, line, "utf8");
			})
			.catch((error) => this.onError(error));
	}

	async flush(): Promise<void> {
		await this.queue;
	}
}
