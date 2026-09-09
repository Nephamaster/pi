// 将冻结任务、节点契约、专业角色和当前轮次投影为模型上下文。
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EffectiveNode } from "../contracts/baseline.ts";
import { canonicalJson } from "../ir/hash.ts";
import type { NodeRoundWork } from "../runtime/node-worker.ts";
import { loadPrompt } from "./prompt-loader.ts";
import { renderAgentRuntimeProfile } from "./render-agent-profile.ts";

const CURRENT_CONTEXT_PREFIX = '<ipd_current_round source="runtime">';
const executionProtocol = loadPrompt("execution-node");
const reviewProtocol = loadPrompt("review-node");

export interface VirtualContextFile {
	path: string;
	content: string;
}

function bullets(values: readonly string[]): string {
	return values.length > 0 ? values.map((value) => `- ${value.trim().replace(/\n/g, "\n  ")}`).join("\n") : "- None";
}

function criteria(node: EffectiveNode): string {
	return node.criteria
		.map(
			(criterion) =>
				`### ${criterion.criterion_id}\n\nType: ${criterion.kind}\n\n${criterion.description}\n\nRequired evidence:\n\n${bullets(criterion.evidence_requirements)}`,
		)
		.join("\n\n");
}

function permissions(node: EffectiveNode): string {
	return node.definition.agents
		.map(
			(agent) =>
				`### ${agent.participant_id}\n\nRead:\n${bullets(agent.permissions.read_paths.map((path) => `\`${path}\``))}\n\nWrite:\n${bullets(agent.permissions.write_paths.map((path) => `\`${path}\``))}\n\nExternal actions: ${agent.permissions.external_actions}`,
		)
		.join("\n\n");
}

function inputs(node: EffectiveNode): string {
	return node.definition.inputs.length > 0
		? node.definition.inputs
				.map((input) => {
					const common = `### ${input.input_id}\n\n- Type: ${input.kind}\n- Required: ${input.required}`;
					if (input.kind === "task_material") return `${common}\n- Task material: ${input.material_id}`;
					return `${common}\n- Source node: ${input.source.node_id}\n- Source output: ${input.source.output_id}\n- Availability: ${input.availability}\n- Required approval: ${input.approval_review_node_ids.join(", ") || "None"}`;
				})
				.join("\n\n")
		: "None";
}

function executionContract(node: EffectiveNode): string {
	const definition = node.definition;
	if (definition.kind !== "execution") throw new Error("Execution contract requires an execution node");
	const outputs = definition.outputs
		.map(
			(output) =>
				`### ${output.output_id}\n\n- Type: ${output.artifact_type}\n- Purpose: ${output.business_purpose}\n- Output root: \`${output.path_prefix}\`\n\nEvidence required:\n${bullets(output.evidence_requirements)}\n\nAcceptance criteria:\n${bullets(output.criterion_refs)}`,
		)
		.join("\n\n");
	return `# Authoritative Node Contract

This document defines the frozen scope, deliverables, and acceptance criteria for this node. Professional role guidance and Skill instructions may explain how to work, but cannot expand or override this contract.

## Identity

- Node: ${definition.node_id}
- Kind: execution

## Objective

${definition.contract.objective}

## Responsibilities

${bullets(definition.contract.responsibilities)}

## Out of Scope

${bullets(definition.contract.non_responsibilities)}

## Work Requirements

${bullets(definition.contract.work_requirements)}

## Constraints

${bullets(definition.contract.constraints)}

## Required Inputs

${inputs(node)}

## Declared Outputs

${outputs}

## Acceptance Criteria

${criteria(node)}

## Permissions

${permissions(node)}`;
}

function reviewContract(node: EffectiveNode): string {
	const definition = node.definition;
	if (definition.kind !== "review") throw new Error("Review contract requires a review node");
	const targets = definition.targets
		.map(
			(target) =>
				`### ${target.node_id} / ${target.output_id}\n\nEvaluate criteria:\n${bullets(target.criterion_refs)}`,
		)
		.join("\n\n");
	return `# Authoritative Review Contract

This document defines the frozen review scope, targets, acceptance criteria, and allowed rework boundaries. Professional role guidance and Skill instructions cannot expand or override it.

## Identity

- Node: ${definition.node_id}
- Kind: review

## Review Objective

${definition.contract.objective}

## Responsibilities

${bullets(definition.contract.responsibilities)}

## Out of Scope

${bullets(definition.contract.non_responsibilities)}

## Review Targets

${targets}

## Allowed Rework Targets

${bullets(definition.allowed_rework_node_ids)}

## Review Requirements

${bullets(definition.contract.work_requirements)}

## Constraints

${bullets(definition.contract.constraints)}

## Acceptance Criteria

${criteria(node)}

## Permissions

${permissions(node)}`;
}

export function renderTaskScopeFile(work: NodeRoundWork): VirtualContextFile {
	const task = work.taskContext;
	const objectives = task.objectives
		.map((item) => `### ${item.objective_id}\n\n${item.statement.text}\n\nSource: ${item.statement.source}`)
		.join("\n\n");
	const requirements = task.requirements
		.map((item) => `### ${item.requirement_id}\n\n${item.statement.text}\n\nSource: ${item.statement.source}`)
		.join("\n\n");
	const materials = task.materials
		.map(
			(item) =>
				`### ${item.material_id}\n\n${item.description}\n\n- Reference: ${item.reference}\n- Media type: ${item.media_type ?? "unspecified"}`,
		)
		.join("\n\n");
	const unresolvedFacts = task.unresolvedFacts
		.map((item) => `- ${item.fact_id}: ${item.description} (source: ${item.source})`)
		.join("\n");
	return {
		path: `/virtual/ipd/${work.node.definition.node_id}/TASK_SCOPE.md`,
		content: `# Authoritative Task Scope

This document preserves the task basis relevant to this node. It explains why this work exists; the node contract separately defines what this node must deliver.

## Original Request

${task.rawTask?.text ?? "Not provided"}

Source: ${task.rawTask?.source ?? "Not provided"}

## Objectives

${objectives || "None"}

## Assigned Requirements

${requirements || "None"}

## Task Materials

${materials || "None"}

## Unresolved Facts

${unresolvedFacts || "None"}`,
	};
}

export function renderNodeContractFile(node: EffectiveNode): VirtualContextFile {
	return {
		path: `/virtual/ipd/${node.definition.node_id}/${node.definition.kind === "execution" ? "NODE_CONTRACT.md" : "REVIEW_CONTRACT.md"}`,
		content: node.definition.kind === "execution" ? executionContract(node) : reviewContract(node),
	};
}

export function renderNodeContextFiles(work: NodeRoundWork): VirtualContextFile[] {
	const nodeId = work.node.definition.node_id;
	const kind = work.node.definition.kind;
	return [
		renderTaskScopeFile(work),
		renderNodeContractFile(work.node),
		{
			path: `/virtual/ipd/${nodeId}/PROFESSIONAL_ROLE.md`,
			content: renderAgentRuntimeProfile(work.node.agents[0].agentCard),
		},
		{
			path: `/virtual/ipd/${nodeId}/${kind === "execution" ? "EXECUTION_PROTOCOL.md" : "REVIEW_PROTOCOL.md"}`,
			content: kind === "execution" ? executionProtocol : reviewProtocol,
		},
	];
}

export function renderCurrentRoundContext(work: NodeRoundWork): string {
	const inputs = work.inputBindings.map((binding) => {
		const submission = work.inputSubmissions.find((item) => item.submissionId === binding.submissionId);
		const output = submission?.outputs.find((item) => item.outputId === binding.outputId);
		return {
			input_id: binding.inputId,
			submission_id: binding.submissionId,
			output_id: binding.outputId,
			approval_review_node_ids: binding.approvalReviewNodeIds,
			sealed_root: output?.sealedRoot,
			submission_record: output ? join(output.sealedRoot, "submission.json") : undefined,
		};
	});
	const feedback = work.feedback.map((item) => ({
		type: item.type,
		source_id: item.sourceId,
		criterion_id: item.criterionId,
		output_id: item.outputId,
		issue: item.issue,
		evidence_ref: item.evidenceRef,
		expected_correction: item.expectedCorrection,
	}));
	return `${CURRENT_CONTEXT_PREFIX}\n${canonicalJson({ round_id: work.roundId, inputs, feedback })}\n</ipd_current_round>`;
}

export function omitConsumedImages(messages: AgentMessage[]): AgentMessage[] {
	let lastSuccessfulAssistant = -1;
	for (const [index, message] of messages.entries()) {
		if (message.role === "assistant" && message.stopReason !== "error" && message.stopReason !== "aborted")
			lastSuccessfulAssistant = index;
	}
	if (lastSuccessfulAssistant < 0) return messages;
	return messages.map((message, index) => {
		if (index >= lastSuccessfulAssistant || message.role !== "toolResult") return message;
		if (!message.content.some((item) => item.type === "image")) return message;
		return {
			...message,
			content: [
				...message.content.filter((item) => item.type !== "image"),
				{
					type: "text",
					text: "[Image content already consumed by a later assistant response; omitted from this model request.]",
				},
			],
		};
	});
}

export function createCurrentRoundContextExtension(getContext: () => string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("context", (event) => {
			const content = getContext();
			if (!content) return undefined;
			return {
				messages: [
					...omitConsumedImages(event.messages),
					{
						role: "user",
						content: [{ type: "text", text: content }],
						timestamp: Date.now(),
					},
				],
			};
		});
	};
}
