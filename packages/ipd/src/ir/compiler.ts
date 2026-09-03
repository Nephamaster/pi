import { InMemoryCheckRegistry } from "../registry/check-registry.ts";
import { topologicalSort } from "./graph.ts";
import { freezeDeep, hashJson } from "./hash.ts";
import { allocateReviewers } from "./reviewer-allocation.ts";
import {
	type AgentCardRef,
	type CompiledAgentCard,
	type ExecutionNodeDefinition,
	type GateDefinition,
	type WorkflowDefinition,
	WorkflowDefinitionSchema,
} from "./schemas.ts";
import { normalizeScope, scopeContains } from "./scopes.ts";
import type { CompileWorkflowResult, IpdDiagnostic, WorkflowCompileContext } from "./types.ts";
import { validateSchema } from "./validation.ts";

function cardKey(ref: AgentCardRef): string {
	return `${ref.id}@${ref.version}#${ref.hash}`;
}

function workflowAssetKey(id: string, version: string, hash: string): string {
	return `${id}@${version}#${hash}`;
}

function diagnostic(code: IpdDiagnostic["code"], path: string, message: string): IpdDiagnostic {
	return { code, path, message };
}

function duplicateDiagnostics(values: readonly string[], path: string, label: string): IpdDiagnostic[] {
	const seen = new Set<string>();
	const duplicates = new Set<string>();
	for (const value of values) {
		if (seen.has(value)) duplicates.add(value);
		seen.add(value);
	}
	return Array.from(duplicates)
		.sort()
		.map((value) => diagnostic("duplicate_id", path, `Duplicate ${label}: ${value}`));
}

function normalizeNodeScopes(
	node: ExecutionNodeDefinition,
	path: string,
	diagnostics: IpdDiagnostic[],
): { readScopes: string[]; writeScopes: string[] } {
	const normalize = (values: readonly string[], field: string): string[] => {
		const normalized: string[] = [];
		for (const [index, value] of values.entries()) {
			const scope = normalizeScope(value);
			if (scope === undefined) {
				diagnostics.push(
					diagnostic(
						"invalid_scope",
						`${path}/permissions/${field}/${index}`,
						`Invalid workspace scope: ${value}`,
					),
				);
				continue;
			}
			normalized.push(scope);
		}
		return normalized;
	};
	return {
		readScopes: normalize(node.permissions.readScopes, "readScopes"),
		writeScopes: normalize(node.permissions.writeScopes, "writeScopes"),
	};
}

function validateNodePermissions(
	node: ExecutionNodeDefinition,
	card: CompiledAgentCard,
	path: string,
	diagnostics: IpdDiagnostic[],
): { readScopes: string[]; writeScopes: string[] } {
	const scopes = normalizeNodeScopes(node, path, diagnostics);
	if (node.permissions.workspace === "write" && card.permissions.workspace !== "write") {
		diagnostics.push(
			diagnostic("permission_exceeded", `${path}/permissions/workspace`, `AgentCard ${card.id} is read-only`),
		);
	}
	if (node.permissions.workspace === "read" && scopes.writeScopes.length > 0) {
		diagnostics.push(
			diagnostic("permission_exceeded", `${path}/permissions/writeScopes`, "Read-only nodes cannot write"),
		);
	}
	if (node.permissions.workspace === "write" && scopes.writeScopes.length === 0) {
		diagnostics.push(
			diagnostic("invalid_scope", `${path}/permissions/writeScopes`, "Writable nodes require write scopes"),
		);
	}
	if (node.permissions.externalActions && !card.permissions.externalActions) {
		diagnostics.push(
			diagnostic(
				"permission_exceeded",
				`${path}/permissions/externalActions`,
				`AgentCard ${card.id} does not allow external actions`,
			),
		);
	}
	for (const [index, scope] of scopes.readScopes.entries()) {
		if (!card.permissions.readScopes.some((allowed) => scopeContains(allowed, scope))) {
			diagnostics.push(
				diagnostic(
					"permission_exceeded",
					`${path}/permissions/readScopes/${index}`,
					`Read scope ${scope} exceeds AgentCard ${card.id}`,
				),
			);
		}
	}
	for (const [index, scope] of scopes.writeScopes.entries()) {
		if (!card.permissions.writeScopes.some((allowed) => scopeContains(allowed, scope))) {
			diagnostics.push(
				diagnostic(
					"permission_exceeded",
					`${path}/permissions/writeScopes/${index}`,
					`Write scope ${scope} exceeds AgentCard ${card.id}`,
				),
			);
		}
	}
	return scopes;
}

function validateGate(
	gate: GateDefinition,
	path: string,
	context: WorkflowCompileContext,
	cards: readonly CompiledAgentCard[],
	excludedCardKeys: ReadonlySet<string>,
	nodeIds: ReadonlySet<string>,
	acceptanceIds: ReadonlySet<string>,
	isFinal: boolean,
	diagnostics: IpdDiagnostic[],
): void {
	diagnostics.push(
		...duplicateDiagnostics(
			gate.mechanicalCriteria.map((criterion) => criterion.id),
			`${path}/mechanicalCriteria`,
			"mechanical criterion id",
		),
		...duplicateDiagnostics(
			gate.semanticCriteria.map((criterion) => criterion.id),
			`${path}/semanticCriteria`,
			"semantic criterion id",
		),
		...duplicateDiagnostics(
			gate.reviewers.map((reviewer) => reviewer.id),
			`${path}/reviewers`,
			"reviewer requirement id",
		),
	);

	const checkRegistry = new InMemoryCheckRegistry();
	for (const check of context.checks) {
		const collision = checkRegistry.add(check);
		if (collision) diagnostics.push(collision);
	}
	for (const [index, criterion] of gate.mechanicalCriteria.entries()) {
		diagnostics.push(
			...checkRegistry.validate(
				criterion.checkId,
				criterion.parameters,
				`${path}/mechanicalCriteria/${index}/parameters`,
			),
		);
	}

	diagnostics.push(...allocateReviewers(gate, cards, excludedCardKeys, path).diagnostics);

	for (const [index, criterionId] of gate.objectiveCoverage.entries()) {
		if (!acceptanceIds.has(criterionId)) {
			diagnostics.push(
				diagnostic(
					"final_coverage_incomplete",
					`${path}/objectiveCoverage/${index}`,
					`Unknown acceptance criterion: ${criterionId}`,
				),
			);
		}
	}
	if (isFinal) {
		for (const acceptanceId of acceptanceIds) {
			if (!gate.objectiveCoverage.includes(acceptanceId)) {
				diagnostics.push(
					diagnostic(
						"final_coverage_incomplete",
						`${path}/objectiveCoverage`,
						`Final Gate does not cover acceptance criterion ${acceptanceId}`,
					),
				);
			}
		}
	}

	if (isFinal && gate.routes.pass !== "final") {
		diagnostics.push(diagnostic("gate_route_invalid", `${path}/routes/pass`, "Final Gate pass route must be final"));
	} else if (
		!isFinal &&
		gate.routes.pass !== "continue" &&
		gate.routes.pass !== "final" &&
		!nodeIds.has(gate.routes.pass)
	) {
		diagnostics.push(
			diagnostic("gate_route_invalid", `${path}/routes/pass`, `Unknown Gate pass route: ${gate.routes.pass}`),
		);
	}
	if (!nodeIds.has(gate.routes.rework)) {
		diagnostics.push(
			diagnostic("gate_route_invalid", `${path}/routes/rework`, `Unknown Gate rework route: ${gate.routes.rework}`),
		);
	}
}

function validateBudget(workflow: WorkflowDefinition, diagnostics: IpdDiagnostic[]): void {
	if (workflow.globalBudget.mode === "unbounded") {
		for (const [index, node] of workflow.nodes.entries()) {
			if (node.budget.mode !== "unbounded") {
				diagnostics.push(
					diagnostic(
						"budget_invalid",
						`/nodes/${index}/budget`,
						"Unbounded Workflows require unbounded Node budgets",
					),
				);
			}
		}
		return;
	}
	if (workflow.nodes.some((node) => node.budget.mode !== "bounded")) {
		for (const [index, node] of workflow.nodes.entries()) {
			if (node.budget.mode === "unbounded") {
				diagnostics.push(
					diagnostic("budget_invalid", `/nodes/${index}/budget`, "Bounded Workflows require bounded Node budgets"),
				);
			}
		}
		return;
	}
	let nodeTokens = 0;
	for (const node of workflow.nodes) {
		if (node.budget.mode === "bounded") nodeTokens += node.budget.tokens;
	}
	const reserved =
		workflow.globalBudget.staffTokens + workflow.globalBudget.reviewerTokens + workflow.globalBudget.reworkTokens;
	if (nodeTokens + reserved > workflow.globalBudget.tokens) {
		diagnostics.push(
			diagnostic(
				"budget_invalid",
				"/globalBudget/tokens",
				`Node budgets (${nodeTokens}) and reserved budgets (${reserved}) exceed global tokens (${workflow.globalBudget.tokens})`,
			),
		);
	}
	if (
		workflow.globalBudget.hardTokenLimit !== undefined &&
		workflow.globalBudget.hardTokenLimit < workflow.globalBudget.tokens
	) {
		diagnostics.push(
			diagnostic(
				"budget_invalid",
				"/globalBudget/hardTokenLimit",
				"Hard token limit cannot be lower than the planned global token budget",
			),
		);
	}
}

function findNodesReachingFinalArtifacts(workflow: WorkflowDefinition): Set<string> {
	const reachable = new Set<string>();
	const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
	const pending = [...workflow.finalArtifactNodeIds];
	while (pending.length > 0) {
		const nodeId = pending.pop();
		if (nodeId === undefined || reachable.has(nodeId)) continue;
		reachable.add(nodeId);
		const node = nodesById.get(nodeId);
		if (node) pending.push(...node.dependsOn);
	}
	return reachable;
}

export function compileWorkflow(value: unknown, context: WorkflowCompileContext): CompileWorkflowResult {
	const parsed = validateSchema<WorkflowDefinition>(WorkflowDefinitionSchema, value);
	if (!parsed.ok) return { ok: false, diagnostics: parsed.diagnostics };
	const workflow = structuredClone(parsed.value);
	const diagnostics: IpdDiagnostic[] = [];

	if (!context.skillNames.has(context.runSkill.name)) {
		diagnostics.push(
			diagnostic("unknown_skill", "/skill/name", `Required Run Skill is not registered: ${context.runSkill.name}`),
		);
	}
	if (workflow.skill.name !== context.runSkill.name || workflow.skill.hash !== context.runSkill.hash) {
		diagnostics.push(
			diagnostic(
				"skill_mismatch",
				"/skill",
				`Workflow Skill ${workflow.skill.name}#${workflow.skill.hash} does not match the Run Skill`,
			),
		);
	}
	if (
		workflow.source === "template" &&
		(!workflow.sourceTemplateId || !workflow.sourceTemplateVersion || !workflow.sourceTemplateHash)
	) {
		diagnostics.push(
			diagnostic(
				"schema_invalid",
				"/sourceTemplateId",
				"Template workflows require sourceTemplateId, sourceTemplateVersion, and sourceTemplateHash",
			),
		);
	} else if (
		workflow.source === "template" &&
		workflow.sourceTemplateId !== undefined &&
		workflow.sourceTemplateVersion !== undefined &&
		workflow.sourceTemplateHash !== undefined &&
		!context.workflowAssetRefs.has(
			workflowAssetKey(workflow.sourceTemplateId, workflow.sourceTemplateVersion, workflow.sourceTemplateHash),
		)
	) {
		diagnostics.push(
			diagnostic(
				"schema_invalid",
				"/sourceTemplateId",
				`Unknown source Workflow Asset: ${workflow.sourceTemplateId}`,
			),
		);
	} else if (
		workflow.source === "generated" &&
		(workflow.sourceTemplateId !== undefined ||
			workflow.sourceTemplateVersion !== undefined ||
			workflow.sourceTemplateHash !== undefined)
	) {
		diagnostics.push(
			diagnostic("schema_invalid", "/sourceTemplateId", "Generated workflows cannot declare sourceTemplateId"),
		);
	}

	const cardMap = new Map(context.agentCards.map((card) => [cardKey(card), card]));
	const fixedStaffCoreKeys = context.fixedStaffCore.map(cardKey);
	const workflowStaffCoreKeys = workflow.staff.core.map(cardKey);
	if (
		fixedStaffCoreKeys.length !== workflowStaffCoreKeys.length ||
		fixedStaffCoreKeys.some((key, index) => workflowStaffCoreKeys[index] !== key)
	) {
		diagnostics.push(
			diagnostic(
				"staff_core_mismatch",
				"/staff/core",
				"Workflow Staff Core must exactly match the fixed Staff Core supplied by the Runtime",
			),
		);
	}
	const fixedStaffCoreKeySet = new Set(fixedStaffCoreKeys);
	const nodeIds = new Set(workflow.nodes.map((node) => node.id));
	const acceptanceIds = new Set(workflow.acceptanceCriteria.map((criterion) => criterion.id));
	diagnostics.push(
		...duplicateDiagnostics(
			workflow.nodes.map((node) => node.id),
			"/nodes",
			"node id",
		),
		...duplicateDiagnostics(
			workflow.acceptanceCriteria.map((criterion) => criterion.id),
			"/acceptanceCriteria",
			"acceptance criterion id",
		),
		...duplicateDiagnostics(
			workflow.nodes.map((node) => node.output.id),
			"/nodes",
			"artifact contract id",
		),
		...duplicateDiagnostics(
			[...workflow.nodes.map((node) => node.gate.id), workflow.finalGate.id],
			"/nodes",
			"gate id",
		),
	);

	for (const [index, ref] of workflow.staff.core.entries()) {
		if (!cardMap.has(cardKey(ref))) {
			diagnostics.push(
				diagnostic("unknown_agent_card", `/staff/core/${index}`, `Unknown Staff AgentCard: ${ref.id}`),
			);
		}
	}

	const nodesById = new Map(workflow.nodes.map((node) => [node.id, node]));
	for (const [index, node] of workflow.nodes.entries()) {
		const path = `/nodes/${index}`;
		const card = cardMap.get(cardKey(node.agentCardRef));
		if (!card) {
			diagnostics.push(
				diagnostic("unknown_agent_card", `${path}/agentCardRef`, `Unknown AgentCard: ${node.agentCardRef.id}`),
			);
		} else {
			const scopes = validateNodePermissions(node, card, path, diagnostics);
			if (fixedStaffCoreKeySet.has(cardKey(card))) {
				diagnostics.push(
					diagnostic(
						"employee_role_conflict",
						`${path}/agentCardRef`,
						`Fixed Staff Core member ${card.id} cannot produce a business Artifact`,
					),
				);
			}
			for (const [capabilityIndex, capability] of node.requiredCapabilities.entries()) {
				if (!card.capabilities.includes(capability)) {
					diagnostics.push(
						diagnostic(
							"required_capability_missing",
							`${path}/requiredCapabilities/${capabilityIndex}`,
							`AgentCard ${card.id} does not provide required capability ${capability}`,
						),
					);
				}
			}
			const knowledgeBases = new Map(card.knowledgeBases.map((knowledgeBase) => [knowledgeBase.id, knowledgeBase]));
			for (const [knowledgeIndex, knowledgeBaseRef] of node.knowledgeBaseRefs.entries()) {
				const knowledgeBase = knowledgeBases.get(knowledgeBaseRef);
				if (!knowledgeBase) {
					diagnostics.push(
						diagnostic(
							"knowledge_base_unknown",
							`${path}/knowledgeBaseRefs/${knowledgeIndex}`,
							`AgentCard ${card.id} does not provide knowledge base ${knowledgeBaseRef}`,
						),
					);
					continue;
				}
				for (const knowledgePath of knowledgeBase.paths) {
					if (!scopes.readScopes.some((readScope) => scopeContains(readScope, knowledgePath))) {
						diagnostics.push(
							diagnostic(
								"knowledge_base_permission_exceeded",
								`${path}/knowledgeBaseRefs/${knowledgeIndex}`,
								`Node read scopes do not cover knowledge base ${knowledgeBaseRef} path ${knowledgePath}`,
							),
						);
					}
				}
			}
			for (const [toolIndex, tool] of node.tools.entries()) {
				if (!context.toolNames.has(tool)) {
					diagnostics.push(diagnostic("unknown_tool", `${path}/tools/${toolIndex}`, `Unknown tool: ${tool}`));
				} else if (!card.tools.includes(tool)) {
					diagnostics.push(
						diagnostic(
							"permission_exceeded",
							`${path}/tools/${toolIndex}`,
							`Tool ${tool} is not allowed by AgentCard ${card.id}`,
						),
					);
				}
			}
			const allowedSkills = new Set([context.runSkill.name, ...card.skills]);
			for (const [skillIndex, skill] of node.skills.entries()) {
				if (!context.skillNames.has(skill)) {
					diagnostics.push(diagnostic("unknown_skill", `${path}/skills/${skillIndex}`, `Unknown skill: ${skill}`));
				} else if (!allowedSkills.has(skill)) {
					diagnostics.push(
						diagnostic(
							"permission_exceeded",
							`${path}/skills/${skillIndex}`,
							`Skill ${skill} is neither the Run Skill nor an AgentCard skill`,
						),
					);
				}
			}
		}

		for (const [dependencyIndex, dependency] of node.dependsOn.entries()) {
			if (!nodeIds.has(dependency)) {
				diagnostics.push(
					diagnostic(
						"unknown_dependency",
						`${path}/dependsOn/${dependencyIndex}`,
						`Unknown dependency: ${dependency}`,
					),
				);
			}
		}
		for (const [inputIndex, input] of node.inputs.entries()) {
			const producer = nodesById.get(input.fromNodeId);
			if (!producer) {
				diagnostics.push(
					diagnostic(
						"artifact_producer_invalid",
						`${path}/inputs/${inputIndex}/fromNodeId`,
						`Unknown Artifact producer: ${input.fromNodeId}`,
					),
				);
				continue;
			}
			if (!node.dependsOn.includes(input.fromNodeId)) {
				diagnostics.push(
					diagnostic(
						"artifact_producer_invalid",
						`${path}/inputs/${inputIndex}/fromNodeId`,
						`Artifact producer ${input.fromNodeId} must be a direct dependency`,
					),
				);
			}
			if (producer.output.artifactType !== input.artifactType) {
				diagnostics.push(
					diagnostic(
						"artifact_type_mismatch",
						`${path}/inputs/${inputIndex}/artifactType`,
						`Expected ${input.artifactType}, producer emits ${producer.output.artifactType}`,
					),
				);
			}
		}

		if (!nodeIds.has(node.rework.targetNodeId) || node.gate.routes.rework !== node.rework.targetNodeId) {
			diagnostics.push(
				diagnostic(
					"rework_route_invalid",
					`${path}/rework/targetNodeId`,
					"Node rework target must exist and match the Gate rework route",
				),
			);
		}

		validateGate(
			node.gate,
			`${path}/gate`,
			context,
			context.agentCards,
			new Set([cardKey(node.agentCardRef)]),
			nodeIds,
			acceptanceIds,
			false,
			diagnostics,
		);
	}

	const topological = topologicalSort(workflow.nodes);
	if (topological.cycle.length > 0) {
		diagnostics.push(
			diagnostic(
				"success_graph_cycle",
				"/nodes",
				`Successful Artifact dependency graph contains a cycle: ${topological.cycle.join(", ")}`,
			),
		);
	}
	const nodesReachingFinalArtifacts = findNodesReachingFinalArtifacts(workflow);
	for (const [index, node] of workflow.nodes.entries()) {
		if (!nodesReachingFinalArtifacts.has(node.id)) {
			diagnostics.push(
				diagnostic(
					"unreachable_node",
					`/nodes/${index}`,
					`Node ${node.id} does not contribute to a final Artifact`,
				),
			);
		}
	}

	for (const [index, nodeId] of workflow.finalArtifactNodeIds.entries()) {
		if (!nodeIds.has(nodeId)) {
			diagnostics.push(
				diagnostic(
					"final_artifact_invalid",
					`/finalArtifactNodeIds/${index}`,
					`Unknown final Artifact node: ${nodeId}`,
				),
			);
		}
	}
	const finalProducerCards = new Set(workflow.nodes.map((node) => cardKey(node.agentCardRef)));
	validateGate(
		workflow.finalGate,
		"/finalGate",
		context,
		context.agentCards,
		finalProducerCards,
		nodeIds,
		acceptanceIds,
		true,
		diagnostics,
	);
	validateBudget(workflow, diagnostics);

	if (diagnostics.length > 0) {
		return {
			ok: false,
			diagnostics: diagnostics.sort(
				(left, right) => left.path.localeCompare(right.path) || left.code.localeCompare(right.code),
			),
		};
	}

	freezeDeep(workflow);
	return {
		ok: true,
		value: {
			definition: workflow,
			hash: hashJson(workflow),
			topologicalOrder: topological.order,
			agentCards: cardMap,
		},
	};
}
