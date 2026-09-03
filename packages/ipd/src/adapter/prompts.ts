import type { ImageContent } from "@earendil-works/pi-ai";
import { canonicalJson } from "../ir/hash.ts";
import { WORKFLOW_AUTHORING_GUIDE } from "../staff/workflow-authoring-guide.ts";
import type { DecisionNodeRunInput, ExecutionNodeRunInput, SkillSnapshot } from "./node-runner.ts";
import { loadPrompt } from "./prompt-loader.ts";

const IDENTITY_RULES = loadPrompt("identity-rules");
const EXECUTION_RULES = loadPrompt("execution-rules");
const DECISION_RULES = loadPrompt("decision-rules");
const REVIEWER_RULES = loadPrompt("reviewer-rules");

export interface NodePromptPackage {
	systemPrompt: string;
	userPrompt: string;
	images: ImageContent[];
}

function formatSkills(skills: readonly SkillSnapshot[]): string {
	return skills
		.map(
			(skill) =>
				`<skill name="${skill.name}" path="${skill.path}" hash="${skill.hash}">\nReferences are relative to ${skill.baseDir}.\n\n${skill.content}\n</skill>`,
		)
		.join("\n\n");
}

function buildIdentity(input: ExecutionNodeRunInput | DecisionNodeRunInput, submissionTool: string): string {
	const knowledgeBases = input.agentCard.knowledgeBases
		.map((knowledgeBase) => {
			const paths = knowledgeBase.paths.length > 0 ? ` Sources: ${knowledgeBase.paths.join(", ")}.` : "";
			return `- ${knowledgeBase.id}: ${knowledgeBase.description}.${paths}`;
		})
		.join("\n");
	return `You are ${input.agentCard.name}, a digital employee executing one controlled IPD node.

Role: ${input.agentCard.description}
Applicable scenarios:
${input.agentCard.applicableScenarios.map((item) => `- ${item}`).join("\n") || "- No fixed scenario; rely on the assigned Node"}
Responsibilities:
${input.agentCard.responsibilities.map((item) => `- ${item}`).join("\n")}
Non-responsibilities:
${input.agentCard.nonResponsibilities.map((item) => `- ${item}`).join("\n") || "- None declared"}
Operating principles:
${input.agentCard.principles.map((item) => `- ${item}`).join("\n") || "- Follow the supplied contracts and evidence"}
Expected deliverables:
${input.agentCard.deliverables.map((item) => `- ${item}`).join("\n") || "- The assigned Artifact Contract"}
Prompt approach:
${input.agentCard.promptProfile.approach.map((item) => `- ${item}`).join("\n") || "- Use a direct evidence-based approach"}
Communication:
${input.agentCard.promptProfile.communication.map((item) => `- ${item}`).join("\n") || "- Be concise and traceable"}
Verification habits:
${input.agentCard.promptProfile.verification.map((item) => `- ${item}`).join("\n") || "- Verify the Artifact before submission"}
Knowledge bases:
${knowledgeBases || "- No fixed knowledge base; use the Run Skill and accepted inputs"}

${IDENTITY_RULES.replace("{{SUBMISSION_TOOL}}", submissionTool)}`;
}

export function buildExecutionPrompt(input: ExecutionNodeRunInput): NodePromptPackage {
	const systemPrompt = `${buildIdentity(input, "submit_artifact")}

Workspace access: ${input.node.permissions.workspace}
Read scopes: ${input.node.permissions.readScopes.join(", ")}
Write scopes: ${input.node.permissions.writeScopes.join(", ") || "none"}
External actions: ${input.node.permissions.externalActions ? "allowed" : "not allowed"}

${formatSkills(input.skills)}`;
	const userPrompt = `Run: ${input.runId}
Workflow Hash: ${input.workflowHash}
Task: ${input.task}
Node: ${input.node.id}
Objective: ${input.node.objective}

Required output contract:
${canonicalJson(input.node.output)}

Gate criteria known before execution:
${canonicalJson(input.node.gate)}

Accepted input Artifacts:
${canonicalJson(input.inputArtifacts)}

Rework instructions:
${input.reworkInstructions.length > 0 ? input.reworkInstructions.map((item) => `- ${item}`).join("\n") : "- None"}

${EXECUTION_RULES}`;
	return { systemPrompt, userPrompt, images: [] };
}

export function buildDecisionPrompt(input: DecisionNodeRunInput): NodePromptPackage {
	const submissionTool =
		input.kind === "workflow_planner"
			? "finalize_workflow"
			: input.kind === "reviewer"
				? "submit_review"
				: "submit_decision";
	const systemPrompt = `${buildIdentity(input, submissionTool)}

${DECISION_RULES}

${formatSkills(input.skills)}`;
	if (input.kind === "workflow_planner") {
		return {
			systemPrompt: `${systemPrompt}\n\n${WORKFLOW_AUTHORING_GUIDE}`,
			userPrompt: `Design the Workflow for this task and mandatory Skill. Build it section by section with the Workflow authoring tools, then call finalize_workflow.

Task: ${input.task}
Workflow context:
${canonicalJson(input.context)}`,
			images: [],
		};
	}
	if (input.kind === "staff") {
		return {
			systemPrompt,
			userPrompt: `Make one Staff Core decision and call submit_decision.

Task: ${input.task}
Allowed actions: ${input.allowedActions.join(", ")}
Control context:
${canonicalJson(input.context)}`,
			images: [],
		};
	}

	const images: ImageContent[] = [];
	const materials = input.reviewBundle.materials.map((material, index) => {
		if (material.kind === "image") {
			images.push({ type: "image", data: material.data, mimeType: material.mimeType });
			return { index, kind: "image", path: material.path, mimeType: material.mimeType, sha256: material.sha256 };
		}
		return material;
	});
	return {
		systemPrompt: `${systemPrompt}

${REVIEWER_RULES}`,
		userPrompt: `Review the actual Artifact content independently and call submit_review.

Task: ${input.task}
Gate:
${canonicalJson(input.gate)}

Review context:
${canonicalJson(input.context)}

Review materials:
${canonicalJson(materials)}`,
		images,
	};
}
