import type { ImageContent } from "@earendil-works/pi-ai";
import { canonicalJson } from "../ir/hash.ts";
import type { DecisionNodeRunInput, ExecutionNodeRunInput, SkillSnapshot } from "./node-runner.ts";

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
	return `You are ${input.agentCard.name}, a digital employee executing one controlled IPD node.

Role: ${input.agentCard.description}
Responsibilities:
${input.agentCard.responsibilities.map((item) => `- ${item}`).join("\n")}
Non-responsibilities:
${input.agentCard.nonResponsibilities.map((item) => `- ${item}`).join("\n") || "- None declared"}

You may work only within the supplied node objective, tools, skills, and permissions.
You cannot advance Workflow state or declare the Run complete.
Finish by calling ${submissionTool} exactly once and as the only tool call in its batch.
Natural-language completion without that tool is invalid.`;
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

Produce the requested business Artifact and submit its Primary, Evidence, and Review files through submit_artifact.`;
	return { systemPrompt, userPrompt, images: [] };
}

export function buildDecisionPrompt(input: DecisionNodeRunInput): NodePromptPackage {
	const submissionTool =
		input.kind === "workflow_planner"
			? "submit_workflow"
			: input.kind === "reviewer"
				? "submit_review"
				: "submit_decision";
	const systemPrompt = `${buildIdentity(input, submissionTool)}

Decision Nodes do not produce or edit business Artifacts.
Base every decision on supplied facts and evidence.

${formatSkills(input.skills)}`;
	if (input.kind === "workflow_planner") {
		return {
			systemPrompt,
			userPrompt: `Design the Workflow for this task and mandatory Skill, then call submit_workflow.

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
		systemPrompt,
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
