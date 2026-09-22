// 将冻结任务、节点契约、专业角色和当前轮次投影为模型上下文。
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { EnvironmentBinding, EnvironmentPaths } from "../environment/contracts.ts";
import { resolveEnvironmentLayout } from "../environment/paths.ts";
import { DEFAULT_ENVIRONMENT_PATHS } from "../environment/profiles.ts";
import { canonicalJson } from "../ir/hash.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import { nodeDispatchKind } from "../runtime/node-prompts.ts";
import type { NodeRoundWork } from "../runtime/node-worker.ts";
import { loadPrompt } from "./prompt-loader.ts";
import { renderAgentRuntimeProfile } from "./render-agent-profile.ts";

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

function permissions(node: EffectiveNode, environment?: EnvironmentBinding): string {
	const declared = node.definition.agents
		.map(
			(agent) =>
				`### ${agent.participant_id}\n\nDeclared read scopes:\n${bullets(agent.permissions.read_paths.map((path) => `\`${path}\``))}\n\nDeclared output ownership scopes:\n${bullets(agent.permissions.write_paths.map((path) => `\`${path}\``))}\n\nExternal actions: ${agent.permissions.external_actions}`,
		)
		.join("\n\n");
	if (!environment) return declared;
	const layout = resolveEnvironmentLayout(environment.paths);
	return `${declared}\n\n### Controlled Environment Layout\n\n- Default working directory: \`${layout.defaultCwd}\`\n- Node-private writable workspace: \`${environment.paths.workspace}\`\n- Read-only task data: \`${environment.paths.context}\`, \`${environment.paths.skills}\`, \`${environment.paths.inputs}\`\n- Export root: \`${layout.exportRoot}\`; only files declared by an output contract can be sealed\n- Runtime-private support paths: \`${environment.paths.scratch}\`, \`${environment.paths.cache}\`, \`${environment.paths.home}\`, \`${environment.paths.temporary}\` (never exported by default)
- Network: ${environment.network.mode === "restricted" ? `HTTP/HTTPS through the enforced proxy; allowed hosts: ${environment.network.allowedEndpoints.join(", ")}` : "container egress disabled; separately authorized Pi service tools may still be available"}.
- Project dependencies may be installed in /workspace using npm or a private Python virtual environment (python3 -m venv --system-site-packages /workspace/.venv). Use the chosen interpreter explicitly in later commands. Keep dependency lockfiles or installed version records. Preserve the configured proxy variables; never modify host or global system packages.
- Intermediate files need no Artifact declaration. Reviews may build/test an inspection copy under /workspace when the required tools are authorized; sealed inputs remain read-only.
- Command failures are feedback to repair locally. Use managed process tools for persistent services. Pause stops processes but retains files and the original Session; restart services after resume.
- Project dependency checks required before submission: ${node.agents.flatMap((agent) => agent.lockedSkills.flatMap((skill) => (skill.environmentRequirements?.projectProbes ?? []).map((probe) => `${skill.id}:${probe.id}`))).join(", ") || "none declared"}.`;
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

function executionContract(node: EffectiveNode, environment?: EnvironmentBinding): string {
	const definition = node.definition;
	if (definition.kind !== "execution") throw new Error("Execution contract requires an execution node");
	const outputs = definition.outputs
		.map(
			(output) =>
				`### ${output.output_id}\n\n- Type: ${output.artifact_type}\n- Purpose: ${output.business_purpose}\n- Output root: \`${output.path_prefix}\`\n\nEvidence required:\n${bullets(output.evidence_requirements)}\n\nAcceptance criteria:\n${bullets(output.criterion_refs)}`,
		)
		.join("\n\n");
	return wrapPromptBlock(
		"execution_contract",
		`# Authoritative Node Contract

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

${permissions(node, environment)}`,
	);
}

function reviewContract(node: EffectiveNode, environment?: EnvironmentBinding): string {
	const definition = node.definition;
	if (definition.kind !== "review") throw new Error("Review contract requires a review node");
	const targets = definition.targets
		.map(
			(target) =>
				`### ${target.node_id} / ${target.output_id}\n\nEvaluate criteria:\n${bullets(target.criterion_refs)}`,
		)
		.join("\n\n");
	return wrapPromptBlock(
		"review_contract",
		`# Authoritative Review Contract

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

${permissions(node, environment)}`,
	);
}

export function renderTaskScopeFile(work: NodeRoundWork): VirtualContextFile {
	const task = work.taskContext;
	const paths = work.environmentBinding?.paths ?? DEFAULT_ENVIRONMENT_PATHS;
	const materials = task.materials
		.map((item) => {
			const input = work.node.definition.inputs.find(
				(candidate) => candidate.kind === "task_material" && candidate.material_id === item.material_id,
			);
			const reference = input ? `${paths.inputs}/${input.input_id}` : item.reference;
			return `### ${item.material_id}\n\n${item.description}\n\n- Reference: ${reference}\n- Media type: ${item.media_type ?? "unspecified"}`;
		})
		.join("\n\n");
	const unresolvedFacts = task.unresolvedFacts
		.map((item) => `- ${item.fact_id}: ${item.description} (source: ${item.source})`)
		.join("\n");
	return {
		path: `${paths.context}/TASK_SCOPE.md`,
		content: wrapPromptBlock(
			"task_scope",
			`# Authoritative Task Scope

This document preserves the original user request and task materials relevant to this node. The original request remains natural-language task intent; the node contract separately defines this node's frozen responsibilities and deliverables.

## Original Request

${task.rawTask?.text ?? "Not provided"}

Source: ${task.rawTask?.source ?? "Not provided"}

## Task Materials

${materials || "None"}

## Unresolved Facts

${unresolvedFacts || "None"}`,
		),
	};
}

export function renderNodeContractFile(
	node: EffectiveNode,
	paths: EnvironmentPaths = DEFAULT_ENVIRONMENT_PATHS,
	environment?: EnvironmentBinding,
): VirtualContextFile {
	return {
		path: `${paths.context}/${node.definition.kind === "execution" ? "NODE_CONTRACT.md" : "REVIEW_CONTRACT.md"}`,
		content:
			node.definition.kind === "execution"
				? executionContract(node, environment)
				: reviewContract(node, environment),
	};
}

export function renderNodeContextFiles(work: NodeRoundWork): VirtualContextFile[] {
	const kind = work.node.definition.kind;
	const paths = work.environmentBinding?.paths ?? DEFAULT_ENVIRONMENT_PATHS;
	return [
		renderTaskScopeFile(work),
		renderNodeContractFile(work.node, paths, work.environmentBinding),
		{
			path: `${paths.context}/PROFESSIONAL_ROLE.md`,
			content: renderAgentRuntimeProfile(work.node.agents[0].agentCard),
		},
		{
			path: `${paths.context}/${kind === "execution" ? "EXECUTION_PROTOCOL.md" : "REVIEW_PROTOCOL.md"}`,
			content: kind === "execution" ? executionProtocol : reviewProtocol,
		},
	];
}

export function renderCurrentRoundContext(work: NodeRoundWork): string {
	const paths = work.environmentBinding?.paths ?? DEFAULT_ENVIRONMENT_PATHS;
	const inputs = work.inputBindings.map((binding) => {
		const submission = work.inputSubmissions.find((item) => item.submissionId === binding.submissionId);
		const output = submission?.outputs.find((item) => item.outputId === binding.outputId);
		return {
			input_id: binding.inputId,
			submission_id: binding.submissionId,
			output_id: binding.outputId,
			approval_review_node_ids: binding.approvalReviewNodeIds,
			sealed_root: output ? `${paths.inputs}/${binding.inputId}` : undefined,
			submission_record: output ? `${paths.inputs}/${binding.inputId}/submission.json` : undefined,
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
	return canonicalJson({
		run_id: work.runId,
		node_id: work.node.definition.node_id,
		round_id: work.roundId,
		generation: work.generation ?? 0,
		attempt_id: work.stamp.attemptId,
		dispatch: nodeDispatchKind(work),
		inputs,
		feedback,
	});
}

export function createCurrentRoundContextExtension(getContext: () => string | undefined): ExtensionFactory {
	return (pi) => {
		pi.on("before_agent_start", (event) => {
			const content = getContext();
			// One update per real dispatch; Pi retains/diffs this section across tool turns and compaction.
			if (content === undefined) delete event.systemPromptOptions.sections.ipd_current_round;
			else event.systemPromptOptions.sections.ipd_current_round = content;
		});
	};
}
