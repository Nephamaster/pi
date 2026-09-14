// 将低频聚合运行指标写入独立 NDJSON，避免扩大权威 RunState。
import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { RunMutationMetric } from "./run-store.ts";
import type { WorkflowRuntimeMetric } from "./workflow-runtime.ts";

export type IpdTelemetryMetric =
	| ({ source: "run_store" } & RunMutationMetric)
	| ({ source: "workflow_runtime" } & WorkflowRuntimeMetric);

export class FileIpdTelemetry {
	private readonly file: string;
	private readonly onError: (error: unknown) => void;
	private queue: Promise<void> = Promise.resolve();

	constructor(file: string, onError: (error: unknown) => void = () => {}) {
		this.file = file;
		this.onError = onError;
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
