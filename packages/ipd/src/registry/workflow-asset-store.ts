// 原子保存不可覆盖的版本化 Workflow 资产。
import type { Dirent } from "node:fs";
import { access, link, mkdir, open, readdir, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type WorkflowDefinition, WorkflowDefinitionSchema } from "../contracts/workflow.ts";
import { hashJson } from "../ir/hash.ts";
import type { WorkflowAssetRecord } from "../ir/types.ts";
import { validateSchema } from "../ir/validation.ts";

export interface WorkflowAssetWriteResult {
	record: WorkflowAssetRecord;
	reused: boolean;
}

export type WorkflowAssetWriteErrorCode = "version_conflict" | "write_failed";

export class WorkflowAssetWriteError extends Error {
	readonly code: WorkflowAssetWriteErrorCode;

	constructor(code: WorkflowAssetWriteErrorCode, message: string, options?: ErrorOptions) {
		super(message, options);
		this.name = "WorkflowAssetWriteError";
		this.code = code;
	}
}

export interface WorkflowAssetStore {
	save(workflow: WorkflowDefinition, hash: string): Promise<WorkflowAssetWriteResult>;
	list(): Promise<WorkflowAssetRecord[]>;
	get(id: string, version: string): Promise<WorkflowAssetRecord | undefined>;
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
			throw new WorkflowAssetWriteError(
				"write_failed",
				`Workflow Hash mismatch: expected ${hash}, calculated ${actualHash}`,
			);
		}
		const directory = join(this.directory, workflow.workflow_id);
		await mkdir(directory, { recursive: true });
		const extension = this.format === "json" ? "json" : "yaml";
		const path = join(directory, `${workflow.workflow_version}.${extension}`);
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
					throw new WorkflowAssetWriteError("write_failed", `Failed to persist Workflow Asset: ${path}`, {
						cause: error,
					});
				}
				reused = true;
			}
		} finally {
			await unlink(tempPath).catch(() => {});
		}

		const existing = await this.read(path);
		const existingHash = hashJson(existing);
		if (existingHash !== hash) {
			throw new WorkflowAssetWriteError(
				"version_conflict",
				`Workflow version already contains ${existingHash}; increment its version before saving ${hash}`,
			);
		}
		return { record: { workflow: existing, hash, source: path }, reused };
	}

	async list(): Promise<WorkflowAssetRecord[]> {
		let directories: Dirent[];
		try {
			directories = await readdir(this.directory, { withFileTypes: true });
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
			throw error;
		}
		const records: WorkflowAssetRecord[] = [];
		const extension = this.format === "json" ? ".json" : ".yaml";
		for (const directory of directories
			.filter((entry) => entry.isDirectory())
			.sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(this.directory, directory.name);
			const files = (await readdir(path, { withFileTypes: true }))
				.filter((entry) => entry.isFile() && entry.name.endsWith(extension))
				.sort((a, b) => a.name.localeCompare(b.name));
			for (const file of files) {
				const source = join(path, file.name);
				const workflow = await this.read(source);
				records.push({ workflow, hash: hashJson(workflow), source });
			}
		}
		return records;
	}

	async get(id: string, version: string): Promise<WorkflowAssetRecord | undefined> {
		const extension = this.format === "json" ? "json" : "yaml";
		const source = join(this.directory, id, `${version}.${extension}`);
		try {
			await access(source);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
			throw error;
		}
		const workflow = await this.read(source);
		if (workflow.workflow_id !== id || workflow.workflow_version !== version)
			throw new WorkflowAssetWriteError(
				"version_conflict",
				`Workflow Asset identity does not match its path: expected ${id}@${version}`,
			);
		return { workflow, hash: hashJson(workflow), source };
	}

	private async read(path: string): Promise<WorkflowDefinition> {
		let value: unknown;
		try {
			const content = await readFile(path, "utf8");
			value = this.format === "json" ? JSON.parse(content) : parseYaml(content);
		} catch (error) {
			throw new WorkflowAssetWriteError("write_failed", `Failed to read Workflow Asset: ${path}`, { cause: error });
		}
		const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, value, path);
		if (!parsed.ok) {
			throw new WorkflowAssetWriteError(
				"version_conflict",
				`Workflow version is already occupied by an incompatible or legacy Asset; increment the Workflow version before saving. Existing Asset diagnostics: ${parsed.diagnostics.map((item) => `${item.path}: ${item.message}`).join("; ")}`,
			);
		}
		return parsed.value;
	}
}
