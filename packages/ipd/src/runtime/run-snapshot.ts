// 将大静态对象先原子保存为内容寻址文件，状态提交仅引用已完整落盘的对象。
import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { RunState } from "../contracts/runtime.ts";
import { freezeDeep, hashJson } from "../ir/hash.ts";
import { syncDirectory } from "./durable-file.ts";

const STATIC_FIELDS = [
	"baseline",
	"taskInput",
	"runSkill",
	"processSelection",
	"selectedProcessSpec",
	"workflowCandidate",
] as const;
type StaticField = (typeof STATIC_FIELDS)[number];
interface StoredSnapshot extends Omit<RunState, StaticField> {
	storageVersion: 1;
	staticRefs: Partial<Record<StaticField, string>>;
}

export class RunSnapshotCodec {
	private readonly objects = new Map<string, unknown>();
	private readonly hashes = new WeakMap<object, string>();

	async encode(stateFile: string, state: RunState): Promise<string> {
		const snapshot = { ...state, storageVersion: 1, staticRefs: {} } as StoredSnapshot &
			Partial<Pick<RunState, StaticField>>;
		for (const field of STATIC_FIELDS) {
			const value = state[field];
			delete snapshot[field];
			if (value === undefined) continue;
			const hash = this.hashes.get(value) ?? hashJson(value);
			const path = join(dirname(stateFile), "objects", `${hash}.json`);
			if (!this.objects.has(path)) {
				await mkdir(dirname(path), { recursive: true, mode: 0o700 });
				const temporary = `${path}.${randomUUID()}.tmp`;
				try {
					const handle = await open(temporary, "wx", 0o600);
					try {
						await handle.writeFile(JSON.stringify(value), "utf8");
						await handle.sync();
					} finally {
						await handle.close();
					}
					try {
						await link(temporary, path);
						await syncDirectory(dirname(path));
					} catch (error) {
						if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
						if (hashJson(JSON.parse(await readFile(path, "utf8"))) !== hash)
							throw new Error(`Corrupt Run object: ${hash}`);
					}
				} finally {
					await unlink(temporary).catch(() => {});
				}
				this.remember(path, hash, value);
			}
			snapshot.staticRefs[field] = hash;
		}
		return `${JSON.stringify(snapshot, null, "\t")}\n`;
	}

	async decode(stateFile: string, content: string): Promise<RunState> {
		const raw = JSON.parse(content) as StoredSnapshot;
		if (raw.storageVersion === undefined) return raw as unknown as RunState;
		if (raw.storageVersion !== 1) throw new Error("Unsupported Run snapshot storage version");
		const { storageVersion: _version, staticRefs, ...mutable } = raw;
		const state: RunState = mutable;
		for (const field of STATIC_FIELDS) {
			const hash = staticRefs[field];
			if (hash === undefined) continue;
			if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error(`Invalid Run object reference: ${field}`);
			const path = join(dirname(stateFile), "objects", `${hash}.json`);
			if (!this.objects.has(path)) {
				let value: unknown;
				try {
					value = JSON.parse(await readFile(path, "utf8"));
				} catch (error) {
					throw new Error(`Run object is missing or unreadable: ${hash}`, { cause: error });
				}
				if (hashJson(value) !== hash) throw new Error(`Corrupt Run object: ${hash}`);
				this.remember(path, hash, value);
			}
			const value = this.objects.get(path);
			Object.assign(state, { [field]: field === "baseline" ? value : structuredClone(value) });
		}
		return state;
	}

	private remember(path: string, hash: string, value: unknown): void {
		if (this.objects.size >= 128) this.objects.delete(this.objects.keys().next().value!);
		const frozen = freezeDeep(structuredClone(value));
		this.objects.set(path, frozen);
		if (typeof frozen === "object" && frozen !== null) this.hashes.set(frozen, hash);
	}
}
