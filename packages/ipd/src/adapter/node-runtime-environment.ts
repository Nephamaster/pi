// 解析节点 Skill 的运行时命令依赖，并在 Session 启动前执行确定性预检。
import { constants } from "node:fs";
import { access } from "node:fs/promises";
import { delimiter, join } from "node:path";
import type { EffectiveParticipant } from "../contracts/baseline.ts";

function commandCandidates(command: string): string[] {
	if (process.platform !== "win32") return [command];
	const extensions = (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM")
		.split(";")
		.map((item) => item.trim())
		.filter(Boolean);
	return [command, ...extensions.map((extension) => `${command}${extension.toLowerCase()}`)];
}

export async function commandAvailable(command: string, env: NodeJS.ProcessEnv = process.env): Promise<boolean> {
	if (!/^[A-Za-z0-9._+-]+$/.test(command)) return false;
	const pathEntries = (env.PATH ?? "").split(delimiter).filter(Boolean);
	for (const directory of pathEntries) {
		for (const candidate of commandCandidates(command)) {
			try {
				await access(join(directory, candidate), process.platform === "win32" ? constants.F_OK : constants.X_OK);
				return true;
			} catch {
				// Continue through PATH candidates.
			}
		}
	}
	return false;
}

export function requiredRuntimeCommands(participant: EffectiveParticipant): string[] {
	const skillCommands = participant.lockedSkills.flatMap((skill) => skill.requiredCommands ?? []);
	const sandboxCommands =
		participant.lockedTools.some((tool) => tool.id === "bash") && process.platform === "linux"
			? ["bwrap", "socat"]
			: [];
	return [...new Set([...skillCommands, ...sandboxCommands].map((command) => command.trim()))].filter(Boolean);
}

export async function missingRuntimeCommands(participant: EffectiveParticipant): Promise<string[]> {
	const missing: string[] = [];
	for (const command of requiredRuntimeCommands(participant)) {
		if (!(await commandAvailable(command))) missing.push(command);
	}
	return missing;
}
