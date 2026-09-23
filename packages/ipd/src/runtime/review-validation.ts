// Collect protocol defects without changing review decisions or granting approval.
import type { SubmitReview } from "../adapter/structured-submissions.ts";
import { criterionSubjects } from "../compiler/governance-policy.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { SubmissionRecord } from "../contracts/runtime.ts";
import type { NodeOutputRef, ReviewNode } from "../contracts/workflow.ts";

const outputKey = (nodeId: string, outputId: string) => `${nodeId}/${outputId}`;

/** These are permitted evidence owners, not inferred quality or repair targets. */
export function reviewEvidenceSubjects(node: ReviewNode, criterionId: string): NodeOutputRef[] {
	if (!node.targets.some((target) => target.criterion_refs.includes(criterionId))) return [];
	const refs = [
		...criterionSubjects(node, criterionId),
		...(node.remediation_mappings ?? [])
			.filter((item) => item.criterion_id === criterionId)
			.map((item) => item.owner),
	];
	return [...new Map(refs.map((ref) => [outputKey(ref.node_id, ref.output_id), ref])).values()];
}

export function validateReviewSubmission(
	node: EffectiveNode,
	report: SubmitReview,
	submissions: readonly SubmissionRecord[],
): SubmitReview {
	const definition = node.definition;
	if (definition.kind !== "review") throw new Error("Review validation requires a review node");
	const expected = new Set(definition.targets.flatMap((target) => target.criterion_refs));
	const seen = new Set<string>();
	const diagnostics: string[] = [];
	const error = (path: string, message: string) => diagnostics.push(`${path}: ${message}`);
	for (const [index, item] of report.criteria.entries()) {
		if (!expected.has(item.criterion_id) || seen.has(item.criterion_id))
			error(
				`/criteria/${index}/criterion_id`,
				`Unknown or duplicate criterion ${item.criterion_id}. Assigned: ${[...expected].join(", ")}`,
			);
		seen.add(item.criterion_id);
	}
	const missing = [...expected].filter((id) => !seen.has(id));
	if (missing.length) error("/criteria", `Missing assigned criteria: ${missing.join(", ")}`);
	// Unknown/duplicate criteria make all subsequent ownership decisions ambiguous.
	if (diagnostics.length)
		throw new Error(`Review report does not cover each assigned criterion exactly once\n${diagnostics.join("\n")}`);

	const required = report.criteria.filter(
		(item) => node.criteria.find((criterion) => criterion.criterion_id === item.criterion_id)?.blocking !== false,
	);
	const decision = required.some((item) => item.result === "BLOCKED")
		? "BLOCKED"
		: required.some((item) => item.result === "FAIL")
			? "REWORK"
			: "PASS";
	if (decision !== report.decision)
		error(
			"/decision",
			`Review decision conflicts with criterion results. Expected ${decision}; received ${report.decision}.`,
		);
	if (report.decision === "BLOCKED" && !report.unresolved_issues.length)
		error("/unresolved_issues", "BLOCKED requires at least one unresolved issue");

	for (const [index, criterion] of report.criteria.entries()) {
		const path = `/criteria/${index}`;
		const subjects = new Set(
			criterionSubjects(definition, criterion.criterion_id).map((ref) => outputKey(ref.node_id, ref.output_id)),
		);
		const permitted = reviewEvidenceSubjects(definition, criterion.criterion_id);
		const allowed = new Set(permitted.map((ref) => outputKey(ref.node_id, ref.output_id)));
		if (!criterion.evidence.length)
			error(`${path}/evidence`, `Criterion ${criterion.criterion_id} requires evidence`);
		if (criterion.result === "FAIL") {
			if (!criterion.required_rework.length)
				error(`${path}/required_rework`, `Failed criterion ${criterion.criterion_id} requires concrete rework`);
			if (!criterion.rework_targets.length)
				error(
					`${path}/rework_targets`,
					`Failed criterion ${criterion.criterion_id} requires an affected rework target`,
				);
		} else if (criterion.required_rework.length || criterion.rework_targets.length) {
			error(path, `Criterion ${criterion.criterion_id} cannot include rework when it did not fail`);
		}
		for (const [targetIndex, target] of criterion.rework_targets.entries()) {
			const key = outputKey(target.node_id, target.output_id);
			const mapped = definition.remediation_mappings?.some(
				(mapping) =>
					mapping.criterion_id === criterion.criterion_id &&
					outputKey(mapping.owner.node_id, mapping.owner.output_id) === key,
			);
			if (!subjects.has(key) && !mapped)
				error(
					`${path}/rework_targets/${targetIndex}`,
					`Criterion ${criterion.criterion_id} selected an unrelated rework target: ${key}`,
				);
			if (
				mapped &&
				(criterion.root_cause?.status !== "supported" ||
					!criterion.evidence.some(
						(item) => item.node_id === target.node_id && item.output_id === target.output_id,
					))
			)
				error(
					`${path}/root_cause`,
					"Cross-target remediation requires supported root-cause evidence for the owner output",
				);
			if (!definition.allowed_rework_node_ids.includes(target.node_id))
				error(
					`${path}/rework_targets/${targetIndex}`,
					`Criterion ${criterion.criterion_id} selected an unauthorized rework target: ${key}`,
				);
		}
		for (const [evidenceIndex, evidence] of criterion.evidence.entries()) {
			const at = `${path}/evidence/${evidenceIndex}`;
			if (evidence.criterion_id !== criterion.criterion_id)
				error(
					`${at}/criterion_id`,
					`Evidence references another criterion: ${evidence.criterion_id}; expected ${criterion.criterion_id}`,
				);
			const key = outputKey(evidence.node_id, evidence.output_id);
			if (!allowed.has(key))
				error(
					at,
					`Evidence references an unrelated output: ${key}. Permitted for ${criterion.criterion_id}: ${[...allowed].join(", ")}. Select an exact tuple using submission_context; do not relabel a background file.`,
				);
			const submission = submissions.find((item) => item.submissionId === evidence.submission_id);
			if (
				!submission ||
				submission.nodeId !== evidence.node_id ||
				!submission.outputs.some((output) => output.outputId === evidence.output_id)
			)
				error(at, `Evidence references an unavailable Submission output: ${evidence.submission_id}:${key}`);
		}
		for (const subject of subjects)
			if (!criterion.evidence.some((item) => outputKey(item.node_id, item.output_id) === subject))
				error(
					`${path}/evidence`,
					`Composite criterion ${criterion.criterion_id} requires evidence for every subject; missing ${subject}`,
				);
	}
	if (diagnostics.length) throw new Error(diagnostics.join("\n"));
	return report;
}
