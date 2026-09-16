import type { ChildProcess, SpawnOptions } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({ spawn: spawnMock }));

import { createNodeSandboxedBashTool, denyReadExcept } from "../src/adapter/node-sandbox.ts";

describe("IPD node Bash sandbox", () => {
	const roots: string[] = [];

	afterEach(async () => {
		delete process.env.IPD_SYNTHETIC_SECRET;
		spawnMock.mockReset();
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("hides siblings without hiding an explicitly allowed descendant", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-read-denies-"));
		roots.push(root);
		const allowed = join(root, "shared", "allowed");
		const deniedSibling = join(root, "sibling");
		const deniedNestedSibling = join(root, "shared", "private");
		await Promise.all([
			mkdir(allowed, { recursive: true }),
			mkdir(deniedSibling),
			mkdir(deniedNestedSibling, { recursive: true }),
		]);

		const denied = await denyReadExcept(root, [allowed]);

		expect(denied).toContain(deniedSibling);
		expect(denied).toContain(deniedNestedSibling);
		expect(denied).not.toContain(root);
		expect(denied).not.toContain(allowed);
	});

	it("canonicalizes denied symlinks and removes targets already covered by a denied parent", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-read-deny-links-"));
		roots.push(root);
		const allowed = join(root, "project", "runs", "current", "workspace");
		const deniedParent = join(root, "private");
		const linkTarget = join(deniedParent, "workflow");
		const link = join(root, "project", "workflow");
		await Promise.all([mkdir(allowed, { recursive: true }), mkdir(linkTarget, { recursive: true })]);
		await symlink(linkTarget, link);

		const denied = await denyReadExcept(root, [allowed]);

		expect(denied).toContain(deniedParent);
		expect(denied).not.toContain(link);
		expect(denied).not.toContain(linkTarget);
	});

	it("does not canonicalize a denied alias into an explicitly allowed target", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-read-allowed-alias-"));
		roots.push(root);
		const allowed = join(root, "allowed");
		const alias = join(root, "alias");
		await mkdir(allowed);
		await symlink(allowed, alias);

		const denied = await denyReadExcept(root, [allowed]);

		expect(denied).not.toContain(allowed);
	});

	it("uses a short per-command temp directory for sandbox-runtime bridge sockets", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-node-sandbox-test-"));
		roots.push(root);
		const runDirectory = join(root, ".pi", "ipd", "runs", `20260915T120000000Z-${"long-run-segment-".repeat(5)}`);
		const workspace = join(runDirectory, "workspace");
		await mkdir(join(workspace, "outputs"), { recursive: true });

		let spawnOptions: SpawnOptions | undefined;
		let settingsText: Promise<string> | undefined;
		spawnMock.mockImplementation((_executable, args: string[], options: SpawnOptions) => {
			spawnOptions = options;
			settingsText = readFile(args[2], "utf8");
			const child = Object.assign(new EventEmitter(), {
				pid: 12345,
				stdout: new PassThrough(),
				stderr: new PassThrough(),
				kill: vi.fn(() => true),
			}) as unknown as ChildProcess;
			void settingsText.then(
				() => setImmediate(() => child.emit("close", 0)),
				(error: unknown) => setImmediate(() => child.emit("error", error)),
			);
			return child;
		});

		const tool = createNodeSandboxedBashTool({
			workspace,
			sessionDirectory: join(runDirectory, "sessions"),
			nodeId: "deck-production",
			participantId: `deck-production-agent-${"long-participant-segment-".repeat(4)}`,
			permissions: {
				read_paths: ["."],
				write_paths: ["outputs"],
				external_actions: false,
			},
			allowReadOwnWritePaths: true,
		});
		process.env.IPD_SYNTHETIC_SECRET = "must-not-reach-node";
		await tool.execute("call-1", { command: "true" }, undefined, undefined, {} as never);
		delete process.env.IPD_SYNTHETIC_SECRET;

		const environment = spawnOptions?.env;
		const commandTempDirectory = environment?.TMPDIR;
		expect(commandTempDirectory?.startsWith(join(tmpdir(), "pi-ipd-srt-"))).toBe(true);
		if (process.platform !== "win32") expect(commandTempDirectory?.length).toBeLessThan(80);
		expect(environment?.TMP).toBe(commandTempDirectory);
		expect(environment?.TEMP).toBe(commandTempDirectory);
		expect(environment?.IPD_SYNTHETIC_SECRET).toBeUndefined();
		if (!settingsText) throw new Error("sandbox-runtime settings were not captured");
		const settings = JSON.parse(await settingsText) as {
			filesystem: { allowWrite: string[]; denyRead: string[] };
		};
		expect(settings.filesystem).not.toHaveProperty("allowRead");
		expect(settings.filesystem.denyRead).not.toContain(homedir());
		expect(settings.filesystem.allowWrite).toContain(commandTempDirectory);
	});

	it("fails closed when a required environment command is unavailable", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-node-sandbox-command-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		await mkdir(workspace);
		const tool = createNodeSandboxedBashTool({
			workspace,
			sessionDirectory: join(root, "sessions"),
			nodeId: "node",
			participantId: "participant",
			permissions: { read_paths: ["."], write_paths: [], external_actions: false },
			requiredCommands: ["ipd-command-that-does-not-exist"],
		});

		await expect(
			tool.execute("call-1", { command: "true" }, undefined, undefined, {} as never),
		).rejects.toMatchObject({
			code: "environment_unavailable",
		});
		expect(spawnMock).not.toHaveBeenCalled();
	});
});
