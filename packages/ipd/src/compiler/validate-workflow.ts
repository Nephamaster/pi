import type { CompiledAgentCard } from "../contracts/agent-card.ts";
import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { ExecutionNode, ReviewNode, WorkflowDefinition } from "../contracts/workflow.ts";
import { topologicalSort } from "../ir/graph.ts";
import { normalizeScope, scopeContains, scopesOverlap } from "../ir/scopes.ts";
import { addDiagnostic as add, duplicateIds as duplicates, outputKey } from "./diagnostics.ts";
import type { CompilerAssetCatalog, ValidatedWorkflow } from "./types.ts";
import { validateNodeAgent } from "./validate-node-agent.ts";
import { validateCoverageReferences } from "./validate-process-coverage.ts";

export function validateWorkflowRelations(
	workflow: WorkflowDefinition,
	task: TaskInput,
	spec: ProcessSpec,
	catalog: CompilerAssetCatalog,
): ValidatedWorkflow {
	const diagnostics: CompilerDiagnostic[] = [];
	for (const id of duplicates(workflow.nodes.map((node) => node.node_id)))
		add(diagnostics, "node_duplicate", "/nodes", `Duplicate node ${id}`);
	for (const id of duplicates(workflow.criteria.map((item) => item.criterion_id)))
		add(diagnostics, "criterion_duplicate", "/criteria", `Duplicate criterion ${id}`);
	const nodes = new Map(workflow.nodes.map((node) => [node.node_id, node]));
	const criteria = new Map(workflow.criteria.map((item) => [item.criterion_id, item]));
	const outputs = new Map<string, { node: ExecutionNode; outputIndex: number }>();
	const agentByNode = new Map<string, CompiledAgentCard>();
	for (const [index, node] of workflow.nodes.entries()) {
		for (const participantId of duplicates(node.agents.map((agent) => agent.participant_id)))
			add(
				diagnostics,
				"participant_duplicate",
				`/nodes/${index}/agents`,
				`Duplicate participant ${participantId}`,
				node.node_id,
			);
		if (node.agents.length !== 1)
			add(
				diagnostics,
				"multi_agent_node_unsupported",
				`/nodes/${index}/agents`,
				"The first release executes exactly one Agent per node",
				node.node_id,
			);
		for (const [agentIndex, agent] of node.agents.entries()) {
			const card = validateNodeAgent(node, agent, index, agentIndex, catalog, diagnostics);
			if (agentIndex === 0 && card) agentByNode.set(node.node_id, card);
		}
		for (const id of duplicates(node.inputs.map((input) => input.input_id)))
			add(diagnostics, "input_duplicate", `/nodes/${index}/inputs`, `Duplicate input ${id}`, node.node_id);
		if (node.kind === "execution") {
			for (const id of duplicates(node.outputs.map((output) => output.output_id)))
				add(diagnostics, "output_duplicate", `/nodes/${index}/outputs`, `Duplicate output ${id}`, node.node_id);
			for (const [outputIndex, output] of node.outputs.entries()) {
				const key = outputKey({ node_id: node.node_id, output_id: output.output_id });
				outputs.set(key, { node, outputIndex });
				const normalized = normalizeScope(output.path_prefix);
				if (normalized && normalized !== output.path_prefix)
					add(
						diagnostics,
						"path_not_normalized",
						`/nodes/${index}/outputs/${outputIndex}/path_prefix`,
						`Output path must use normalized form ${normalized}`,
						node.node_id,
					);
				if (
					!normalized ||
					!node.agents[0]?.permissions.write_paths.some((path) => scopeContains(path, normalized))
				) {
					add(
						diagnostics,
						"output_path_unowned",
						`/nodes/${index}/outputs/${outputIndex}/path_prefix`,
						`Output path ${output.path_prefix} is not owned by the node`,
						node.node_id,
					);
				}
				const resolved = output.criterion_refs.map((id) => criteria.get(id));
				if (resolved.some((item) => item?.kind === "mechanical") === false)
					add(
						diagnostics,
						"mechanical_criterion_missing",
						`/nodes/${index}/outputs/${outputIndex}/criterion_refs`,
						"Output requires a mechanical criterion",
						node.node_id,
					);
				if (resolved.some((item) => item?.kind === "semantic") === false)
					add(
						diagnostics,
						"semantic_criterion_missing",
						`/nodes/${index}/outputs/${outputIndex}/criterion_refs`,
						"Output requires a semantic criterion",
						node.node_id,
					);
				for (const criterionId of output.criterion_refs) {
					if (!criteria.has(criterionId))
						add(
							diagnostics,
							"criterion_unknown",
							`/nodes/${index}/outputs/${outputIndex}/criterion_refs`,
							`Unknown criterion ${criterionId}`,
							node.node_id,
						);
				}
			}
		}
	}

	const executionNodes = workflow.nodes.filter((node): node is ExecutionNode => node.kind === "execution");
	for (let left = 0; left < executionNodes.length; left++) {
		for (let right = left + 1; right < executionNodes.length; right++) {
			for (const leftPath of executionNodes[left].agents[0]?.permissions.write_paths ?? []) {
				for (const rightPath of executionNodes[right].agents[0]?.permissions.write_paths ?? []) {
					if (scopesOverlap(leftPath, rightPath))
						add(
							diagnostics,
							"output_ownership_conflict",
							"/nodes",
							`${executionNodes[left].node_id} and ${executionNodes[right].node_id} have overlapping write paths`,
							executionNodes[right].node_id,
						);
				}
			}
		}
	}

	const reviews = workflow.nodes.filter((node): node is ReviewNode => node.kind === "review");
	const reviewsByOutput: Record<string, string[]> = {};
	for (const [index, review] of reviews.entries()) {
		for (const [targetIndex, target] of review.targets.entries()) {
			const key = outputKey(target);
			if (!outputs.has(key))
				add(
					diagnostics,
					"review_target_unknown",
					`/nodes/${index}/targets/${targetIndex}`,
					`Unknown review target ${key}`,
					review.node_id,
				);
			else {
				const assignedReviews = reviewsByOutput[key] ?? [];
				assignedReviews.push(review.node_id);
				reviewsByOutput[key] = assignedReviews;
			}
			for (const criterionId of target.criterion_refs) {
				if (criteria.get(criterionId)?.kind !== "semantic")
					add(
						diagnostics,
						"review_criterion_invalid",
						`/nodes/${index}/targets/${targetIndex}/criterion_refs`,
						`Review criterion ${criterionId} must be semantic`,
						review.node_id,
					);
			}
			const matchingInput = review.inputs.some(
				(input) =>
					input.kind === "node_output" && outputKey(input.source) === key && input.availability === "submitted",
			);
			if (!matchingInput)
				add(
					diagnostics,
					"review_input_missing",
					`/nodes/${index}/inputs`,
					`Review target ${key} requires a submitted input binding`,
					review.node_id,
				);
		}
		for (const targetId of review.allowed_rework_node_ids) {
			if (nodes.get(targetId)?.kind !== "execution")
				add(
					diagnostics,
					"rework_target_invalid",
					`/nodes/${index}/allowed_rework_node_ids`,
					`Invalid execution rework target ${targetId}`,
					review.node_id,
				);
		}
	}
	for (const [key, item] of outputs) {
		const semantic = item.node.outputs[item.outputIndex].criterion_refs.filter(
			(id) => criteria.get(id)?.kind === "semantic",
		);
		const reviewed = reviews.flatMap((review) =>
			review.targets.filter((target) => outputKey(target) === key).flatMap((target) => target.criterion_refs),
		);
		for (const criterionId of semantic) {
			if (!reviewed.includes(criterionId))
				add(
					diagnostics,
					"output_review_missing",
					"/nodes",
					`${key} is not reviewed for ${criterionId}`,
					item.node.node_id,
				);
		}
	}

	const dependencies = new Map(workflow.nodes.map((node) => [node.node_id, new Set<string>()]));
	for (const [index, node] of workflow.nodes.entries()) {
		for (const [inputIndex, input] of node.inputs.entries()) {
			if (input.kind === "task_material") {
				if (!task.materials.some((material) => material.material_id === input.material_id))
					add(
						diagnostics,
						"material_unknown",
						`/nodes/${index}/inputs/${inputIndex}`,
						`Unknown task material ${input.material_id}`,
						node.node_id,
					);
				continue;
			}
			const key = outputKey(input.source);
			if (!outputs.has(key))
				add(
					diagnostics,
					"output_unknown",
					`/nodes/${index}/inputs/${inputIndex}/source`,
					`Unknown output ${key}`,
					node.node_id,
				);
			else dependencies.get(node.node_id)?.add(input.source.node_id);
			if (node.kind === "execution" && input.availability !== "approved")
				add(
					diagnostics,
					"unapproved_execution_input",
					`/nodes/${index}/inputs/${inputIndex}/availability`,
					"Execution nodes may consume only approved node outputs",
					node.node_id,
				);
			if (input.availability === "approved" && input.approval_review_node_ids.length === 0)
				add(
					diagnostics,
					"approval_missing",
					`/nodes/${index}/inputs/${inputIndex}/approval_review_node_ids`,
					"Approved input requires at least one review node",
					node.node_id,
				);
			for (const reviewId of input.approval_review_node_ids) {
				if (!(reviewsByOutput[key] ?? []).includes(reviewId))
					add(
						diagnostics,
						"approval_invalid",
						`/nodes/${index}/inputs/${inputIndex}/approval_review_node_ids`,
						`${reviewId} does not review ${key}`,
						node.node_id,
					);
				else dependencies.get(node.node_id)?.add(reviewId);
			}
		}
	}
	for (const review of reviews)
		for (const target of review.targets) dependencies.get(review.node_id)?.add(target.node_id);
	const sorted = topologicalSort(
		workflow.nodes.map((node) => ({ id: node.node_id, dependsOn: [...(dependencies.get(node.node_id) ?? [])] })),
	);
	if (sorted.cycle.length > 0)
		add(diagnostics, "forward_cycle", "/nodes", `Forward dependency cycle: ${sorted.cycle.join(", ")}`);

	for (const [index, criterion] of workflow.criteria.entries()) {
		if (criterion.kind !== "mechanical") continue;
		const checkDiagnostics = catalog.checks.validate(
			criterion.check_id,
			criterion.parameters,
			`/criteria/${index}/parameters`,
		);
		for (const diagnostic of checkDiagnostics) add(diagnostics, diagnostic.code, diagnostic.path, diagnostic.message);
	}
	validateCoverageReferences(
		workflow,
		task,
		spec,
		nodes,
		new Set(outputs.keys()),
		new Set(criteria.keys()),
		diagnostics,
	);

	for (const [index, ref] of workflow.completion.final_outputs.entries()) {
		const key = outputKey(ref);
		if (!outputs.has(key))
			add(diagnostics, "final_output_unknown", `/completion/final_outputs/${index}`, `Unknown final output ${key}`);
		const requiredReviews = workflow.completion.required_review_node_ids.filter((id) =>
			(reviewsByOutput[key] ?? []).includes(id),
		);
		if (requiredReviews.length === 0)
			add(
				diagnostics,
				"final_output_unreviewed",
				`/completion/final_outputs/${index}`,
				`Final output ${key} lacks a required completion review`,
			);
	}
	const finalOutputKeys = new Set(workflow.completion.final_outputs.map(outputKey));
	for (const [index, ref] of workflow.completion.delivery_outputs.entries()) {
		const key = outputKey(ref);
		if (!outputs.has(key))
			add(
				diagnostics,
				"delivery_output_unknown",
				`/completion/delivery_outputs/${index}`,
				`Unknown delivery output ${key}`,
			);
		if (!finalOutputKeys.has(key))
			add(
				diagnostics,
				"delivery_output_not_final",
				`/completion/delivery_outputs/${index}`,
				`Delivery output ${key} must also be a final output`,
			);
		const requiredReviews = workflow.completion.required_review_node_ids.filter((id) =>
			(reviewsByOutput[key] ?? []).includes(id),
		);
		if (requiredReviews.length === 0)
			add(
				diagnostics,
				"delivery_output_unreviewed",
				`/completion/delivery_outputs/${index}`,
				`Delivery output ${key} lacks a required completion review`,
			);
	}
	for (const nodeId of workflow.completion.required_node_ids)
		if (!nodes.has(nodeId))
			add(diagnostics, "node_unknown", "/completion/required_node_ids", `Unknown required node ${nodeId}`);
	for (const nodeId of workflow.completion.required_review_node_ids)
		if (nodes.get(nodeId)?.kind !== "review")
			add(
				diagnostics,
				"review_node_invalid",
				"/completion/required_review_node_ids",
				`Invalid required review node ${nodeId}`,
			);

	const forward: Record<string, string[]> = {};
	const reverse: Record<string, string[]> = {};
	for (const node of workflow.nodes) {
		reverse[node.node_id] = [...(dependencies.get(node.node_id) ?? [])].sort();
		forward[node.node_id] = [];
	}
	for (const [nodeId, upstream] of dependencies) for (const source of upstream) forward[source]?.push(nodeId);
	for (const values of Object.values(forward)) values.sort();
	return {
		workflow,
		diagnostics,
		agentByNode,
		graph: {
			forward,
			reverse,
			reviewsByOutput,
			reworkTargetsByReview: Object.fromEntries(
				reviews.map((node) => [node.node_id, [...node.allowed_rework_node_ids]]),
			),
		},
	};
}
