/** Render published professional content into Pi's existing prompt assembly.
 * No histories, tools, permissions or model calls are implemented here.
 */
export interface ProfessionalProfile {
  name: string;
  description: string;
  responsibilities: readonly string[];
  nonResponsibilities: readonly string[];
  applicableScenarios?: readonly string[];
  principles?: readonly string[];
  deliverables?: readonly string[];
  promptProfile?: {
    approach: readonly string[];
    communication: readonly string[];
    verification: readonly string[];
  };
}

function section(title: string, values: readonly string[] | undefined): string {
  if (!values?.length) return "";
  return `## ${title}\n${values.map((value, index) =>
    `${index + 1}. ${value.trim().replace(/\n/g, "\n   ")}`
  ).join("\n\n")}`;
}

export function renderAgentProfile(card: ProfessionalProfile): string {
  const profile = card.promptProfile;
  return [
    `# Professional role: ${card.name}`,
    card.description,
    "This is professional guidance, not an additional authority or permission source. " +
      "The frozen task and node contract determine the assigned scope and acceptance criteria. " +
      "Source example targets are not automatic gates. Runtime alone controls submissions and transitions.",
    section("Responsibilities", card.responsibilities),
    section("Non-responsibilities", card.nonResponsibilities),
    section("Applicable scenarios", card.applicableScenarios),
    section("Professional principles", card.principles),
    section("Methods and advanced capabilities", profile?.approach),
    section("Deliverables and templates", card.deliverables),
    section("Communication", profile?.communication),
    section("Verification and reference targets", profile?.verification),
  ].filter(Boolean).join("\n\n");
}
