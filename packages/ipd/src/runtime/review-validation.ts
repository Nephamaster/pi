// 校验评审提交的标准覆盖、证据和返工一致性。
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";

export function validateReviewSubmission(node: EffectiveNode, report: SubmitReview): SubmitReview {
	const definition = node.definition;
	if (definition.kind !== "review") throw new Error("Review validation requires a review node");
	const expected = new Set(definition.targets.flatMap((target) => target.criterion_refs));
	if (
		report.criteria.length !== expected.size ||
		report.criteria.some((item) => !expected.delete(item.criterion_id)) ||
		expected.size > 0
	)
		throw new Error("Review report does not cover each assigned criterion exactly once");
	const decision = report.criteria.some((item) => item.result === "BLOCKED")
		? "BLOCKED"
		: report.criteria.some((item) => item.result === "FAIL")
			? "REWORK"
			: "PASS";
	if (decision !== report.decision) throw new Error("Review decision conflicts with criterion results");
	if (report.rework_node_ids.some((id) => !definition.allowed_rework_node_ids.includes(id)))
		throw new Error("Review selected an unauthorized rework target");
	if (report.decision === "REWORK" && report.rework_node_ids.length === 0)
		throw new Error("REWORK requires at least one authorized rework target");
	if (report.decision !== "REWORK" && report.rework_node_ids.length > 0)
		throw new Error(`${report.decision} cannot include rework targets`);
	if (report.decision === "BLOCKED" && report.unresolved_issues.length === 0)
		throw new Error("BLOCKED requires at least one unresolved issue");

	const outputsByCriterion = new Map<string, Set<string>>();
	for (const target of definition.targets) {
		for (const criterionId of target.criterion_refs) {
			const outputs = outputsByCriterion.get(criterionId) ?? new Set<string>();
			outputs.add(target.output_id);
			outputsByCriterion.set(criterionId, outputs);
		}
	}
	for (const criterion of report.criteria) {
		if (criterion.evidence.length === 0) throw new Error(`Criterion ${criterion.criterion_id} requires evidence`);
		if (criterion.result === "FAIL" && criterion.required_rework.length === 0)
			throw new Error(`Failed criterion ${criterion.criterion_id} requires concrete rework`);
		if (criterion.result !== "FAIL" && criterion.required_rework.length > 0)
			throw new Error(`Criterion ${criterion.criterion_id} cannot include rework when it did not fail`);
		for (const evidence of criterion.evidence) {
			if (evidence.criterion_id && evidence.criterion_id !== criterion.criterion_id)
				throw new Error(`Evidence references another criterion: ${evidence.criterion_id}`);
			if (evidence.output_id && !outputsByCriterion.get(criterion.criterion_id)?.has(evidence.output_id))
				throw new Error(`Evidence references an unrelated output: ${evidence.output_id}`);
		}
	}
	return report;
}
