import type { CompiledAgentCard } from "../contracts/agent-card.ts";

function section(title: string, values: readonly string[]): string {
	if (values.length === 0) return "";
	return `## ${title}\n${values
		.map((value, index) => `${index + 1}. ${value.trim().replace(/\n/g, "\n   ")}`)
		.join("\n\n")}`;
}

/** Maps a compiled professional asset into Pi's existing system-prompt extension point. */
export function renderAgentProfile(card: CompiledAgentCard): string {
	return [
		`# Professional role: ${card.name}`,
		card.description,
		"This is professional guidance, not an additional authority or permission source. The frozen task and node contract determine the assigned scope and acceptance criteria. Source example targets are not automatic gates. Runtime alone controls submissions and transitions.",
		section("Responsibilities", card.responsibilities),
		section("Non-responsibilities", card.nonResponsibilities),
		section("Applicable scenarios", card.applicableScenarios),
		section("Professional principles", card.principles),
		section("Methods and advanced capabilities", card.promptProfile.approach),
		section("Deliverables and templates", card.deliverables),
		section("Communication", card.promptProfile.communication),
		section("Verification and reference targets", card.promptProfile.verification),
	]
		.filter(Boolean)
		.join("\n\n");
}
