// 校验节点员工能力、资源引用和权限边界。
import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import type { WorkflowNode } from "../contracts/workflow.ts";
import { normalizeScope, scopeContains } from "../ir/scopes.ts";
import { addDiagnostic, assetKey } from "./diagnostics.ts";
import type { CompilerAssetCatalog } from "./types.ts";

type NodeAgent = WorkflowNode["agents"][number];

export function validateNodeAgent(
	node: WorkflowNode,
	agent: NodeAgent,
	nodeIndex: number,
	agentIndex: number,
	catalog: CompilerAssetCatalog,
	diagnostics: CompilerDiagnostic[],
): CompiledAgentCard | undefined {
	const path = `/nodes/${nodeIndex}/agents/${agentIndex}`;
	const card = catalog.agentCards.find(
		(candidate) => candidate.id === agent.agent_ref.id && candidate.version === agent.agent_ref.version,
	);
	if (!card) {
		addDiagnostic(
			diagnostics,
			"agent_unknown",
			`${path}/agent_ref`,
			`Unknown AgentCard ${assetKey(agent.agent_ref)}`,
			node.node_id,
		);
		return undefined;
	}
	for (const capability of agent.required_capabilities) {
		if (!card.capabilities.includes(capability))
			addDiagnostic(
				diagnostics,
				"agent_capability_missing",
				`${path}/required_capabilities`,
				`AgentCard lacks ${capability}`,
				node.node_id,
			);
	}
	for (const [refIndex, ref] of agent.skills.entries()) {
		if (!catalog.skills.some((item) => item.id === ref.id))
			addDiagnostic(
				diagnostics,
				"asset_unknown",
				`${path}/skills/${refIndex}`,
				`Unknown skills asset ${ref.id}`,
				node.node_id,
			);
	}
	for (const [refIndex, ref] of agent.tools.entries()) {
		if (!catalog.tools.some((item) => item.id === ref.id))
			addDiagnostic(
				diagnostics,
				"asset_unknown",
				`${path}/tools/${refIndex}`,
				`Unknown tool asset ${ref.id}`,
				node.node_id,
			);
		if (!card.tools.includes(ref.id))
			addDiagnostic(
				diagnostics,
				"agent_permission_exceeded",
				`${path}/tools/${refIndex}`,
				`AgentCard does not allow ${ref.id}`,
				node.node_id,
			);
	}
	for (const [refIndex, ref] of agent.knowledge_bases.entries()) {
		if (!catalog.knowledgeBases.some((item) => assetKey(item) === assetKey(ref)))
			addDiagnostic(
				diagnostics,
				"asset_unknown",
				`${path}/knowledge_bases/${refIndex}`,
				`Unknown knowledge base ${assetKey(ref)}`,
				node.node_id,
			);
		if (!card.knowledgeBases.some((item) => item.id === ref.id))
			addDiagnostic(
				diagnostics,
				"agent_permission_exceeded",
				`${path}/knowledge_bases/${refIndex}`,
				`AgentCard does not allow ${ref.id}`,
				node.node_id,
			);
		addDiagnostic(
			diagnostics,
			"knowledge_base_unsupported",
			`${path}/knowledge_bases/${refIndex}`,
			"The current Pi adapter has no executable knowledge-base projection",
			node.node_id,
		);
	}
	for (const skill of agent.skills) {
		if (
			catalog.skills.some((item) => item.id === skill.id) &&
			!agent.tools.some((tool) => tool.id === "read" || tool.id === "bash")
		)
			addDiagnostic(
				diagnostics,
				"skill_unreadable",
				`${path}/skills`,
				`Skill ${skill.id} requires read or bash for Pi-native disclosure`,
				node.node_id,
			);
	}
	for (const [field, paths, allowed] of [
		["read_paths", agent.permissions.read_paths, card.permissions.readScopes],
		["write_paths", agent.permissions.write_paths, card.permissions.writeScopes],
	] as const) {
		for (const [pathIndex, value] of paths.entries()) {
			const normalized = normalizeScope(value);
			if (!normalized)
				addDiagnostic(
					diagnostics,
					"path_invalid",
					`${path}/permissions/${field}/${pathIndex}`,
					`Invalid relative path ${value}`,
					node.node_id,
				);
			else if (normalized !== value)
				addDiagnostic(
					diagnostics,
					"path_not_normalized",
					`${path}/permissions/${field}/${pathIndex}`,
					`Path must use normalized form ${normalized}`,
					node.node_id,
				);
			else if (!allowed.some((scope) => scopeContains(scope, normalized)))
				addDiagnostic(
					diagnostics,
					"agent_permission_exceeded",
					`${path}/permissions/${field}/${pathIndex}`,
					`Path ${value} exceeds AgentCard permissions`,
					node.node_id,
				);
		}
	}
	if (agent.permissions.external_actions && !card.permissions.externalActions)
		addDiagnostic(
			diagnostics,
			"agent_permission_exceeded",
			`${path}/permissions/external_actions`,
			"External actions exceed AgentCard permissions",
			node.node_id,
		);
	if (node.kind === "review" && (agent.permissions.write_paths.length > 0 || agent.permissions.external_actions))
		addDiagnostic(
			diagnostics,
			"review_not_read_only",
			`${path}/permissions`,
			"Review participants must be read-only and cannot perform external actions",
			node.node_id,
		);
	if (node.kind === "review" && agent.tools.some((tool) => ["write", "edit", "bash", "powershell"].includes(tool.id)))
		addDiagnostic(
			diagnostics,
			"review_mutation_tool_forbidden",
			`${path}/tools`,
			"Review participants cannot receive write, edit, or general-purpose Shell tools",
			node.node_id,
		);
	if (node.kind === "execution" && agent.permissions.write_paths.length === 0)
		addDiagnostic(
			diagnostics,
			"execution_output_unwritable",
			`${path}/permissions/write_paths`,
			"Execution participants require an owned output path",
			node.node_id,
		);
	return card;
}
