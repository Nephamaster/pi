import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { promisify } from "node:util";
import { afterEach, describe, it } from "vitest";
import { withDraftWriter, writeDraftFile, writeImmutableDraftFile } from "../src/control/workflow-draft-storage.ts";

const execute = promisify(execFile);
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true }))); });
async function root() {
	const path = await mkdtemp(join(tmpdir(), "ipd-draft-files-"));
	roots.push(path);
	return path;
}

describe("authoring file ownership", () => {
	it("writes complete UTF-8 state and removes its temporary file", async () => {
		const dir = await root(); const file = join(dir, "draft.json");
		await writeDraftFile(file, '{"name":"核对🙂"}\n');
		assert.equal(await readFile(file, "utf8"), '{"name":"核对🙂"}\n');
		assert.deepEqual(await readdir(dir), ["draft.json"]);
	});
	it("does not overwrite a different or incomplete immutable candidate", async () => {
		const file = join(await root(), "candidate.json");
		await writeImmutableDraftFile(file, '{"ok":true}\n');
		await writeImmutableDraftFile(file, '{"ok":true}\n');
		await assert.rejects(writeImmutableDraftFile(file, '{"ok":false}\n'), /differs/);
		assert.equal(await readFile(file, "utf8"), '{"ok":true}\n');
	});
	it("serializes independently created writers", async () => {
		const file = join(await root(), "draft.json"); let active = 0; let maximum = 0;
		await Promise.all(Array.from({ length: 4 }, () => withDraftWriter(file, async () => {
			active++; maximum = Math.max(active, maximum); await delay(10); active--;
		})));
		assert.equal(maximum, 1);
	});
	it("releases ownership after a failed operation", async () => {
		const file = join(await root(), "draft.json");
		await assert.rejects(withDraftWriter(file, async () => { throw new Error("expected"); }), /expected/);
		assert.equal(await withDraftWriter(file, async () => 42), 42);
	});
	it("does not delete a lock whose identity changed", async () => {
		const file = join(await root(), "draft.json");
		await withDraftWriter(file, async () => { await writeFile(`${file}.authoring-lock`, "other-owner"); });
		assert.equal(await readFile(`${file}.authoring-lock`, "utf8"), "other-owner");
	});
	it("serializes writers in two actual child processes", async () => {
		const dir = await root(); const file = join(dir, "draft.json"); const trace = join(dir, "trace.txt");
		const moduleUrl = new URL("../src/control/workflow-draft-storage.ts", import.meta.url).href;
		const source = `import { withDraftWriter } from ${JSON.stringify(moduleUrl)}; import { appendFile } from 'node:fs/promises'; import { setTimeout } from 'node:timers/promises'; await withDraftWriter(${JSON.stringify(file)}, async () => { await appendFile(${JSON.stringify(trace)}, 'enter:'+process.pid+'\\n'); await setTimeout(40); await appendFile(${JSON.stringify(trace)}, 'exit:'+process.pid+'\\n'); });`;
		await Promise.all([
			execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source]),
			execute(process.execPath, ["--experimental-strip-types", "--input-type=module", "-e", source]),
		]);
		const lines = (await readFile(trace, "utf8")).trim().split("\n");
		assert.equal(lines.length, 4);
		assert.equal(lines[0].replace("enter:", "exit:"), lines[1]);
		assert.equal(lines[2].replace("enter:", "exit:"), lines[3]);
		assert.notEqual(lines[0], lines[2]);
	});
});
