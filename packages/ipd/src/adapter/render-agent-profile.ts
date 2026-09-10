// 将 AgentCard 分别投影为运行画像和选人画像。
import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import { wrapPromptBlock } from "../prompt/block.ts";

function section(title: string, values: readonly string[]): string {
	if (values.length === 0) return "";
	return `## ${title}\n${values.map((value) => `- ${value.trim().replace(/\n/g, "\n  ")}`).join("\n\n")}`;
}

export function renderAgentRuntimeProfile(card: CompiledAgentCard): string {
	return wrapPromptBlock(
		"professional_role",
		[
			"# Professional Role",
			`## Role\n${card.name}`,
			card.description,
			section("Responsibilities", card.responsibilities),
			section("Boundaries", card.nonResponsibilities),
			section("Professional Principles", card.principles),
			section("Working Method", card.promptProfile.approach),
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}

export function renderAgentSelectionProfile(card: CompiledAgentCard): string {
	const permissions = [
		`- Workspace: ${card.permissions.workspace}`,
		`- Read scopes: ${card.permissions.readScopes.join(", ") || "None"}`,
		`- Write scopes: ${card.permissions.writeScopes.join(", ") || "None"}`,
		`- External actions: ${card.permissions.externalActions}`,
	].join("\n");
	return wrapPromptBlock(
		"agent_selection_profile",
		[
			"# Agent Selection Profile",
			`## Role\n${card.name}`,
			`- ID: ${card.id}`,
			`- Version: ${card.version}`,
			card.description,
			section("Applicable Scenarios", card.applicableScenarios),
			section("Responsibilities", card.responsibilities),
			section("Boundaries", card.nonResponsibilities),
			section("Capabilities", card.capabilities),
			section("Professional Principles", card.principles),
			section("Working Method", card.promptProfile.approach),
			section("Generic Deliverables", card.deliverables),
			section("Verification References", card.promptProfile.verification),
			section("Default Skills", card.skills),
			section("Allowed Tools", card.tools),
			`## Permission Envelope\n${permissions}`,
		]
			.filter(Boolean)
			.join("\n\n"),
	);
}
