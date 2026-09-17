// 为编译或加载的冻结执行基线建立只读查询索引，不重复保存节点或成果内容。
import type { EffectiveNode, ExecutionBaseline } from "../contracts/baseline.ts";
import type { CriterionDefinition, ExecutionNode } from "../contracts/workflow.ts";

export interface BaselineIndex {
	nodes: ReadonlyMap<string, EffectiveNode>;
	outputs: ReadonlyMap<string, ExecutionNode["outputs"][number]>;
	criteria: ReadonlyMap<string, CriterionDefinition>;
}

const indexes = new WeakMap<ExecutionBaseline, BaselineIndex>();

export function baselineIndex(baseline: ExecutionBaseline): BaselineIndex {
	const cached = indexes.get(baseline);
	if (cached) return cached;
	const nodes = new Map(baseline.nodes.map((node) => [node.definition.node_id, node]));
	const outputs = new Map<string, ExecutionNode["outputs"][number]>();
	for (const { definition } of baseline.nodes) {
		if (definition.kind === "execution")
			for (const output of definition.outputs) outputs.set(`${definition.node_id}/${output.output_id}`, output);
	}
	const index = {
		nodes,
		outputs,
		criteria: new Map(baseline.workflow.criteria.map((c) => [c.criterion_id, c])),
	};
	// Mutable test/caller baselines must not reuse stale indexes.
	if (Object.isFrozen(baseline)) indexes.set(baseline, index);
	return index;
}
