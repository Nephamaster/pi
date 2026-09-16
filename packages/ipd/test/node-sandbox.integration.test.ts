import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createNodeSandboxedBashTool } from "../src/adapter/node-sandbox.ts";

function commandExists(command: string): boolean {
	return spawnSync("which", [command], { stdio: "ignore" }).status === 0;
}

function canRunLinuxSandbox(): boolean {
	if (process.platform !== "linux" || !["bwrap", "rg", "socat"].every(commandExists)) return false;
	return spawnSync("bwrap", ["--ro-bind", "/", "/", "--", "/usr/bin/true"], { stdio: "ignore" }).status === 0;
}

const sandboxDescribe = canRunLinuxSandbox() ? describe : describe.skip;

sandboxDescribe("IPD node Bash sandbox integration", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("executes with seccomp while exposing only the authorized Home paths", async () => {
		const root = await mkdtemp(join(process.cwd(), ".node-sandbox-integration-"));
		roots.push(root);
		const workspace = join(root, "workspace");
		const approvedInput = join(root, "sealed", "input.txt");
		const skillFile = join(root, "skill", "SKILL.md");
		const deniedInput = join(root, "private", "secret.txt");
		const deniedLinkTarget = join(root, "private", "workflow");
		await mkdir(workspace, { recursive: true });
		await Promise.all([
			mkdir(join(root, "sealed"), { recursive: true }),
			mkdir(join(root, "skill"), { recursive: true }),
			mkdir(deniedLinkTarget, { recursive: true }),
		]);
		await symlink(deniedLinkTarget, join(root, "workflow"));
		await writeFile(approvedInput, "approved input\n");
		await writeFile(skillFile, "authorized skill\n");
		await writeFile(deniedInput, "secret\n");

		const tool = createNodeSandboxedBashTool({
			workspace,
			sessionDirectory: join(root, "sessions"),
			nodeId: "deck-production",
			participantId: "deck-producer",
			permissions: {
				read_paths: ["."],
				write_paths: ["outputs/deck-production"],
				external_actions: false,
			},
			additionalReadRoots: () => [approvedInput, dirname(skillFile)],
			allowReadOwnWritePaths: true,
			requiredCommands: ["node", "python3", "pdftoppm"],
		});
		const result = await tool.execute(
			"call-1",
			{
				command: `test ! -r '${deniedInput}' && cat '${approvedInput}' '${skillFile}' > outputs/deck-production/copied.txt && node --version && node -e 'require("pptxgenjs"); process.stdout.write("pptxgenjs-ok\\n")' && python3 --version && pdftoppm -v`,
			},
			undefined,
			undefined,
			{} as never,
		);

		expect(result.content.find((item) => item.type === "text")?.text).toMatch(/v\d+\./);
		expect(result.content.find((item) => item.type === "text")?.text).toContain("pptxgenjs-ok");
		expect(await readFile(join(workspace, "outputs", "deck-production", "copied.txt"), "utf8")).toBe(
			"approved input\nauthorized skill\n",
		);
	});
});
