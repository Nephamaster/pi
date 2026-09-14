// 校验评审提交的标准覆盖、证据和返工一致性。
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { SubmissionRecord } from "../contracts/runtime.ts";

const outputKey = (nodeId: string, outputId: string) => `${nodeId}/${outputId}`;

export function validateReviewSubmission(
	node: EffectiveNode,
	report: SubmitReview,
	submissions: readonly SubmissionRecord[],
): SubmitReview {
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
	if (report.decision === "BLOCKED" && report.unresolved_issues.length === 0)
		throw new Error("BLOCKED requires at least one unresolved issue");

	const targetsByCriterion = new Map<string, Set<string>>();
	for (const target of definition.targets) {
		for (const criterionId of target.criterion_refs) {
			const targets = targetsByCriterion.get(criterionId) ?? new Set<string>();
			targets.add(outputKey(target.node_id, target.output_id));
			targetsByCriterion.set(criterionId, targets);
		}
	}
	for (const criterion of report.criteria) {
		if (criterion.evidence.length === 0) throw new Error(`Criterion ${criterion.criterion_id} requires evidence`);
		if (criterion.result === "FAIL") {
			if (criterion.required_rework.length === 0)
				throw new Error(`Failed criterion ${criterion.criterion_id} requires concrete rework`);
			if (criterion.rework_targets.length === 0)
				throw new Error(`Failed criterion ${criterion.criterion_id} requires an affected rework target`);
		} else if (criterion.required_rework.length > 0 || criterion.rework_targets.length > 0) {
			throw new Error(`Criterion ${criterion.criterion_id} cannot include rework when it did not fail`);
		}
		for (const target of criterion.rework_targets) {
			const key = outputKey(target.node_id, target.output_id);
			if (!targetsByCriterion.get(criterion.criterion_id)?.has(key))
				throw new Error(`Criterion ${criterion.criterion_id} selected an unrelated rework target: ${key}`);
			if (!definition.allowed_rework_node_ids.includes(target.node_id))
				throw new Error(`Criterion ${criterion.criterion_id} selected an unauthorized rework target: ${key}`);
		}
		for (const evidence of criterion.evidence) {
			if (evidence.criterion_id !== criterion.criterion_id)
				throw new Error(`Evidence references another criterion: ${evidence.criterion_id}`);
			const key = outputKey(evidence.node_id, evidence.output_id);
			if (!targetsByCriterion.get(criterion.criterion_id)?.has(key))
				throw new Error(`Evidence references an unrelated output: ${key}`);
			const submission = submissions.find((item) => item.submissionId === evidence.submission_id);
			if (
				!submission ||
				submission.nodeId !== evidence.node_id ||
				!submission.outputs.some((output) => output.outputId === evidence.output_id)
			)
				throw new Error(`Evidence references an unavailable Submission output: ${evidence.submission_id}:${key}`);
		}
	}
	return report;
}
