// 校验候选 replan 不改变冻结任务、标准和责任绑定。
import type { ExecutionBaseline } from "../contracts/baseline.ts";
import type { RunState } from "../contracts/runtime.ts";
import { canonicalJson } from "../ir/hash.ts";

export function validateReplan(current: ExecutionBaseline, candidate: ExecutionBaseline, state: RunState): string[] {
	const errors: string[] = [];
	if (current.runId !== candidate.runId) errors.push("Replan must stay in the same Run");
	if (canonicalJson(current.workflow.task_input_ref) !== canonicalJson(candidate.workflow.task_input_ref))
		errors.push("Replan cannot change TaskInput");
	if (canonicalJson(current.processSpecRef) !== canonicalJson(candidate.processSpecRef))
		errors.push("Replan cannot change ProcessSpec");
	if (canonicalJson(current.workflow.criteria) !== canonicalJson(candidate.workflow.criteria))
		errors.push("Replan cannot change frozen acceptance criteria");
	const currentBindings = current.workflow.nodes.map((node) => ({
		nodeId: node.node_id,
		criteria:
			node.kind === "execution"
				? node.outputs.map((output) => ({ outputId: output.output_id, criterionRefs: output.criterion_refs }))
				: node.targets.map((target) => ({ outputId: target.output_id, criterionRefs: target.criterion_refs })),
	}));
	const candidateBindings = candidate.workflow.nodes.map((node) => ({
		nodeId: node.node_id,
		criteria:
			node.kind === "execution"
				? node.outputs.map((output) => ({ outputId: output.output_id, criterionRefs: output.criterion_refs }))
				: node.targets.map((target) => ({ outputId: target.output_id, criterionRefs: target.criterion_refs })),
	}));
	if (canonicalJson(currentBindings) !== canonicalJson(candidateBindings))
		errors.push("Replan cannot change frozen acceptance criterion bindings");
	const startedNodes = new Set(state.rounds.map((round) => round.nodeId));
	for (const node of state.nodes.filter((item) => startedNodes.has(item.nodeId))) {
		const before = current.nodes.find((item) => item.definition.node_id === node.nodeId);
		const after = candidate.nodes.find((item) => item.definition.node_id === node.nodeId);
		if (!before || !after || canonicalJson(before.agents) !== canonicalJson(after.agents))
			errors.push(`Replan cannot replace responsible participants for ${node.nodeId}`);
	}
	return errors;
}
