// 将低频聚合运行指标写入独立 NDJSON，避免扩大权威 RunState。

import { randomUUID } from "node:crypto";
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type {
	SpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryContext,
	TelemetrySpan,
} from "@earendil-works/pi-telemetry";
import type { NodeSessionEventEnvelope } from "../adapter/node-session-adapter.ts";
import type { RunMutationMetric } from "./run-store.ts";
import type { WorkflowRuntimeMetric } from "./workflow-runtime.ts";

export type IpdTelemetryMetric =
	| ({ source: "run_store" } & RunMutationMetric)
	| ({ source: "workflow_runtime" } & WorkflowRuntimeMetric)
	| (Pick<NodeSessionEventEnvelope, "runId" | "nodeId" | "participantId" | "roundId" | "sessionId" | "generation"> & {
			source: "pi_session";
			eventType: NodeSessionEventEnvelope["event"]["type"];
			data: Record<string, string | number | boolean>;
	  });

export class FileIpdTelemetry {
	private readonly starts = new Map<string, number>();
	private readonly file: string;
	private readonly onError: (error: unknown) => void;
	private queue: Promise<void> = Promise.resolve();

	constructor(file: string, onError: (error: unknown) => void = () => {}) {
		this.file = file;
		this.onError = onError;
	}

	/** Implements Pi's passive callback span contract; only approved metadata leaves the process. */
	context(tags: SpanAttributes = {}, parentId?: string): TelemetryContext {
		return {
			startSpan: <T>(options: SpanOptions, callback: (span: TelemetrySpan) => T | Promise<T>): Promise<T> => {
				const id = randomUUID();
				const startedAt = Date.now();
				let settled = false;
				let status: SpanStatus | undefined;
				let attributes: SpanAttributes = {};
				const events: Array<{ name: string; attributes: SpanAttributes }> = [];
				const safe = (values?: SpanAttributes): SpanAttributes => {
					try {
						return Object.fromEntries(
							Object.entries(values ?? {}).filter(
								([key, value]) =>
									/^(runId|nodeId|participantId|roundId|sessionId|generation|toolCallId|toolName|durationMs|eventCount|stateBytes|attempt|maxAttempts|delayMs|success|reason|aborted|willRetry|succeeded|isError|status|inputTokens|outputTokens)$/.test(
										key,
									) && ["string", "number", "boolean"].includes(typeof value),
							),
						);
					} catch {
						return {};
					}
				};
				try {
					attributes = { ...safe(tags), ...safe(options.attributes) };
				} catch {
					/* Unreadable telemetry is ignored. */
				}
				const span: TelemetrySpan = {
					...this.context(attributes, id),
					setAttributes: (values) => {
						if (!settled) attributes = { ...attributes, ...safe(values) };
					},
					setStatus: (value) => {
						if (!settled) status = value;
					},
					addEvent: (name, values) => {
						if (!settled && events.length < 64) events.push({ name, attributes: safe(values) });
					},
				};
				const finish = (failed: boolean) => {
					settled = true;
					try {
						this.append({
							source: "pi_telemetry",
							id,
							parentId,
							name: options.name,
							attributes,
							events,
							status: status?.status ?? (failed ? "error" : "ok"),
							durationMs: Date.now() - startedAt,
						});
					} catch {
						/* Recording cannot change the callback outcome. */
					}
				};
				try {
					return Promise.resolve(callback(span)).then(
						(value) => {
							finish(false);
							return value;
						},
						(error) => {
							finish(true);
							throw error;
						},
					);
				} catch (error) {
					finish(true);
					return Promise.reject(error);
				}
			},
		};
	}

	/** Project native events, never prompts, tool payloads, images, summaries or provider errors. */
	recordSessionEvent(envelope: NodeSessionEventEnvelope): void {
		const { runId, nodeId, participantId, roundId, sessionId, generation, event } = envelope;
		let data: Record<string, string | number | boolean>;
		const operation =
			event.type === "tool_execution_start" || event.type === "tool_execution_end"
				? `${sessionId}:tool:${event.toolCallId}`
				: `${sessionId}:model`;
		switch (event.type) {
			case "tool_execution_start":
				this.starts.set(operation, Date.now());
				return;
			case "message_start":
				if (event.message.role === "assistant") this.starts.set(operation, Date.now());
				return;
			case "message_end":
				if (event.message.role !== "assistant") return;
				data = {
					status: event.message.stopReason,
					inputTokens: event.message.usage.input,
					outputTokens: event.message.usage.output,
				};
				break;
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
		if (event.type === "message_end" || event.type === "tool_execution_end") {
			const start = this.starts.get(operation);
			if (start !== undefined) data.durationMs = Date.now() - start;
			this.starts.delete(operation);
		}
		if (event.type === "agent_settled")
			for (const key of this.starts.keys()) if (key.startsWith(`${sessionId}:`)) this.starts.delete(key);
		this.record({
			source: "pi_session",
			runId,
			nodeId,
			participantId,
			roundId,
			sessionId,
			generation,
			eventType: event.type,
			data,
		});
	}

	record(metric: IpdTelemetryMetric): void {
		this.append(metric);
	}

	private append(metric: object): void {
		const line = `${JSON.stringify({ timestamp: Date.now(), ...metric })}\n`;
		this.queue = this.queue
			.catch(() => {})
			.then(async () => {
				await mkdir(dirname(this.file), { recursive: true });
				await appendFile(this.file, line, "utf8");
			})
			.catch((error) => {
				try {
					this.onError(error);
				} catch {
					/* Export failures never affect execution. */
				}
			});
	}

	async flush(): Promise<void> {
		await this.queue;
	}
}
