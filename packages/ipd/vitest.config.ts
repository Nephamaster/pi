import { defineConfig, mergeConfig } from "vitest/config";
import baseConfig, { workspaceSourcePaths } from "../../vitest.base.ts";

export default mergeConfig(
	baseConfig,
	defineConfig({
		resolve: {
			alias: [
				{ find: /^@earendil-works\/pi-coding-agent$/, replacement: workspaceSourcePaths.codingAgentIndex },
			],
		},
		test: {
			globals: true,
			environment: "node",
			reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
		},
	}),
);
