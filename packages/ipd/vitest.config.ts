import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
	resolve: {
		alias: [
			{
				find: /^@earendil-works\/pi-coding-agent$/,
				replacement: fileURLToPath(new URL("../coding-agent/src/index.ts", import.meta.url)),
			},
		],
	},
	test: {
		globals: true,
		environment: "node",
		reporters: process.env.GITHUB_ACTIONS ? ["dot", "github-actions"] : ["dot"],
	},
});
