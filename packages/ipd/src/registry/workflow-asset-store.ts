import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { hashJson } from "../ir/hash.ts";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../ir/schemas.ts";
import type { WorkflowAssetRecord } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";

export interface WorkflowAssetWriteResult {
	record: WorkflowAssetRecord;
	reused: boolean;
}

export class WorkflowAssetWriteError extends Error {
	constructor(message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowAssetWriteError";
	}
}

export interface WorkflowAssetStore {
	save(workflow: WorkflowDefinition, hash: string): Promise<WorkflowAssetWriteResult>;
}

export interface FileWorkflowAssetStoreOptions {
	directory: string;
	format?: "json" | "yaml";
}

export class FileWorkflowAssetStore implements WorkflowAssetStore {
	private readonly directory: string;
	private readonly format: "json" | "yaml";

	constructor(options: FileWorkflowAssetStoreOptions) {
		this.directory = resolve(options.directory);
		this.format = options.format ?? "json";
	}

	async save(workflow: WorkflowDefinition, hash: string): Promise<WorkflowAssetWriteResult> {
		const actualHash = hashJson(workflow);
		if (actualHash !== hash) {
			throw new WorkflowAssetWriteError(`Workflow Hash mismatch: expected ${hash}, calculated ${actualHash}`);
		}
		const directory = join(this.directory, workflow.id, workflow.version);
		await mkdir(directory, { recursive: true });
		const extension = this.format === "json" ? "json" : "yaml";
		const path = join(directory, `${hash}.${extension}`);
		const content =
			this.format === "json"
				? `${JSON.stringify(workflow, null, "\t")}\n`
				: stringifyYaml(workflow, { lineWidth: 120 });
		const tempPath = join(directory, `.${hash}.${process.pid}.${Date.now()}.tmp`);
		let reused = false;
		try {
			const temp = await open(tempPath, "wx");
			try {
				await temp.writeFile(content, "utf8");
				await temp.sync();
			} finally {
				await temp.close();
			}
			try {
				await link(tempPath, path);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
					throw new WorkflowAssetWriteError(`Failed to persist Workflow Asset: ${path}`, { cause: error });
				}
				reused = true;
			}
		} finally {
			await unlink(tempPath).catch(() => {});
		}

		const existing = await this.read(path);
		if (hashJson(existing) !== hash) {
			throw new WorkflowAssetWriteError(`Existing Workflow Asset content does not match its file Hash: ${path}`);
		}
		return { record: { workflow: existing, hash, source: path }, reused };
	}

	private async read(path: string): Promise<WorkflowDefinition> {
		let value: unknown;
		try {
			const content = await readFile(path, "utf8");
			value = this.format === "json" ? JSON.parse(content) : parseYaml(content);
		} catch (error) {
			throw new WorkflowAssetWriteError(`Failed to read Workflow Asset: ${path}`, { cause: error });
		}
		const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, value, path);
		if (!parsed.ok) {
			throw new WorkflowAssetWriteError(
				`Persisted Workflow Asset is invalid: ${parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
			);
		}
		return parsed.value;
	}
}
