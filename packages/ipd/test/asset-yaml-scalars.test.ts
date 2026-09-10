import { readFile, readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const packageRoot = join(dirname(fileURLToPath(import.meta.url)), "..");
const cardDirectories = [
	join(packageRoot, "assets", "agency-role-library", "agent-cards"),
	join(packageRoot, "assets", "agent-cards"),
];

const topLevelStringLists = [
	"responsibilities",
	"nonResponsibilities",
	"applicableScenarios",
	"principles",
	"deliverables",
] as const;
const profileStringLists = ["approach", "communication", "verification"] as const;

describe("AgentCard YAML scalar encoding", () => {
	it("keeps human-readable AgentCard list entries as strings", async () => {
		for (const directory of cardDirectories) {
			for (const filename of (await readdir(directory)).filter((name) => name.endsWith(".yaml")).sort()) {
				const document = parse(await readFile(join(directory, filename), "utf8")) as Record<string, unknown>;
				for (const field of topLevelStringLists) {
					const values = document[field];
					if (values === undefined) continue;
					expect(Array.isArray(values), `${filename}:${field}`).toBe(true);
					for (const [index, value] of (values as unknown[]).entries())
						expect(typeof value, `${filename}:${field}[${index}]`).toBe("string");
				}
				const profile = document.promptProfile as Record<string, unknown> | undefined;
				if (!profile) continue;
				for (const field of profileStringLists) {
					const values = profile[field];
					if (values === undefined) continue;
					expect(Array.isArray(values), `${filename}:promptProfile.${field}`).toBe(true);
					for (const [index, value] of (values as unknown[]).entries())
						expect(typeof value, `${filename}:promptProfile.${field}[${index}]`).toBe("string");
				}
			}
		}
	});
});
