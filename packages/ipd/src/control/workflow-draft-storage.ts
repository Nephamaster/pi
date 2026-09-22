// Draft-local durable files and bounded exclusive writer ownership.
import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { DraftError } from "./workflow-draft-model.ts";

async function syncParent(file: string): Promise<void> {
	if (process.platform === "win32") return;
	const directory = await open(dirname(file), "r");
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}
export async function writeDraftFile(file: string, text: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	const temporary = join(dirname(file), `.workflow-draft-${randomUUID()}.tmp`);
	try {
		const handle = await open(temporary, "wx", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await rename(temporary, file);
		await syncParent(file);
	} finally {
		await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "ENOENT") throw error;
		});
	}
}
export async function writeImmutableDraftFile(file: string, text: string): Promise<void> {
	await mkdir(dirname(file), { recursive: true });
	try {
		const handle = await open(file, "wx", 0o600);
		try {
			await handle.writeFile(text, "utf8");
			await handle.sync();
		} finally {
			await handle.close();
		}
		await syncParent(file);
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		if ((await readFile(file, "utf8")) !== text)
			throw new DraftError(
				"immutable_candidate_conflict",
				file,
				"Existing immutable draft object differs or is incomplete. Do not overwrite it.",
			);
	}
}
export async function withDraftWriter<T>(file: string, operation: () => Promise<T>): Promise<T> {
	await mkdir(dirname(file), { recursive: true });
	const lock = `${file}.authoring-lock`;
	const identity = JSON.stringify({ pid: process.pid, token: randomUUID() });
	const deadline = Date.now() + 5000;
	let acquired = false;
	while (!acquired) {
		try {
			const handle = await open(lock, "wx", 0o600);
			try {
				await handle.writeFile(identity, "utf8");
				await handle.sync();
				acquired = true;
			} finally {
				await handle.close();
			}
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
			if (Date.now() >= deadline)
				throw new DraftError(
					"draft_writer_busy",
					lock,
					"Draft writer ownership is unavailable. After a crash, confirm the old writer is stopped before recovering its lock.",
				);
			await delay(20);
		}
	}
	try {
		return await operation();
	} finally {
		// Never steal an unknown owner's lock merely because a timeout elapsed.
		if ((await readFile(lock, "utf8")) === identity) {
			await unlink(lock);
			await syncParent(file);
		}
	}
}
