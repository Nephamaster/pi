// Explicit compatibility entry. The normal IPD entry never imports sandbox-runtime adapters.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { LegacyNodeToolAdapter } from "./adapter/pi-node-session-factory.ts";
import { createNodeFileScopeExtension } from "./legacy/node-file-scope.ts";
import { createNodeSandboxedBashTool } from "./legacy/node-sandbox.ts";
import { registerDefaultIpdExtension } from "./tool/default-ipd-extension.ts";

export * from "./legacy/node-file-scope.ts";
export * from "./legacy/node-sandbox.ts";

export const createLegacyNodeTools: LegacyNodeToolAdapter = (input, verify) => {
	const permissions = input.permissions ?? {
		read_paths: input.participant.agentCard.permissions.readScopes,
		write_paths:
			input.participant.agentCard.permissions.workspace === "write"
				? input.participant.agentCard.permissions.writeScopes
				: [],
		external_actions: input.participant.agentCard.permissions.externalActions,
	};
	const common = {
		workspace: input.workspace,
		permissions,
		additionalReadRoots: () => [
			...input.participant.lockedSkills.map((skill) => skill.baseDir),
			...(input.getAdditionalReadRoots?.() ?? []),
		],
		deniedReadRoots: input.getDeniedReadRoots,
		allowReadOwnWritePaths: input.allowReadOwnWritePaths,
	};
	return {
		nativeFileTools: true,
		tools: input.participant.lockedTools.some((tool) => tool.id === "bash")
			? [
					createNodeSandboxedBashTool({
						...common,
						sessionDirectory: input.sessionDirectory,
						nodeId: input.nodeId,
						participantId: input.participant.participantId,
						requiredCommands: [
							...new Set(input.participant.lockedSkills.flatMap((skill) => skill.requiredCommands ?? [])),
						],
						beforeExec: verify,
					}),
				]
			: [],
		extensions: [
			{
				name: "ipd-legacy-file-scope",
				hidden: true,
				factory: createNodeFileScopeExtension({ ...common, beforeRead: verify }),
			},
		],
	};
};

export function registerLegacyIpdExtension(pi: ExtensionAPI): void {
	registerDefaultIpdExtension(pi, { environmentMode: "legacy-srt", legacyToolAdapter: createLegacyNodeTools });
}
export default registerLegacyIpdExtension;
