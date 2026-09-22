// Persist create-run request identity before Run preparation so retries cannot create duplicate Runs.
import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { RunRequestRecord, RunTemplateSelectionRecord } from "../contracts/runtime.ts";
import { syncDirectory } from "./durable-file.ts";

export interface ClaimRunRequestInput {
	requestId: string;
	requestHash: string;
	proposedRunId: string;
	runSkillId?: string;
	templates?: RunTemplateSelectionRecord;
}

export interface RunRequestClaim {
	record: RunRequestRecord;
	reused: boolean;
}

export interface RunRequestRegistry {
	claim(input: ClaimRunRequestInput): Promise<RunRequestClaim>;
}

function requestFileName(requestId: string): string {
	return `${createHash("sha256").update(requestId).digest("hex")}.json`;
}

export class FileRunRequestRegistry implements RunRequestRegistry {
	private readonly directory: string;

	constructor(directory: string) {
		this.directory = resolve(directory);
	}

	async claim(input: ClaimRunRequestInput): Promise<RunRequestClaim> {
		await mkdir(this.directory, { recursive: true, mode: 0o700 });
		const target = join(this.directory, requestFileName(input.requestId));
		const record: RunRequestRecord = {
			requestId: input.requestId,
			requestHash: input.requestHash,
			runId: input.proposedRunId,
			runSkillId: input.runSkillId,
			...(input.templates ? { templates: structuredClone(input.templates) } : {}),
			acceptedAt: Date.now(),
		};
		const temporary = join(this.directory, `.${requestFileName(input.requestId)}.${process.pid}.${randomUUID()}.tmp`);
		let reused = false;
		try {
			const file = await open(temporary, "wx", 0o600);
			try {
				await file.writeFile(`${JSON.stringify(record, null, "\t")}\n`, "utf8");
				await file.sync();
			} finally {
				await file.close();
			}
			try {
				await link(temporary, target);
				await syncDirectory(this.directory);
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
				reused = true;
			}
		} finally {
			await unlink(temporary).catch(() => {});
		}
		if (!reused) return { record, reused: false };
		let existing: RunRequestRecord;
		try {
			existing = JSON.parse(await readFile(target, "utf8")) as RunRequestRecord;
		} catch (error) {
			throw new Error(`Stored create-run request is unreadable: ${input.requestId}`, { cause: error });
		}
		if (existing.requestId !== input.requestId)
			throw new Error(`Create-run request digest collision: ${input.requestId}`);
		if (existing.requestHash !== input.requestHash)
			throw new Error(`create_run request ID conflict: ${input.requestId}`);
		return { record: existing, reused: true };
	}
}
