// Validate stage exits, explicit composite review subjects, and requirement authority.
import type { CompilerDiagnostic } from "../contracts/baseline.ts";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import type { WorkflowDefinition } from "../contracts/workflow.ts";
import { processSources } from "../ir/process-sources.ts";
import { addDiagnostic, duplicateIds } from "./diagnostics.ts";
import { candidateUseAllowed, criterionSubjects, outputRefKey } from "./governance-policy.ts";

export function validateGovernance(
	workflow: WorkflowDefinition,
	task: TaskInput,
	spec: ProcessSpec,
): CompilerDiagnostic[] {
	const diagnostics: CompilerDiagnostic[] = [];
	const error = (code: string, path: string, message: string) => addDiagnostic(diagnostics, code, path, message);
	const nodes = new Map(workflow.nodes.map((node) => [node.node_id, node]));
	const stages = workflow.stages ?? [];
	for (const id of duplicateIds(stages.map((stage) => stage.stage_id))) error("stage_duplicate", "/stages", id);
	const membership = new Map<string, string>();
	for (const stage of stages) {
		const path = `/stages/${stage.stage_id}`;
		for (const member of stage.member_node_ids) {
			if (!nodes.has(member)) error("stage_member_unknown", path, member);
			if (membership.has(member)) error("stage_membership_ambiguous", path, member);
			membership.set(member, stage.stage_id);
		}
		for (const use of stage.internal_uses) {
			const consumer = nodes.get(use.consumer_node_id);
			const input = consumer?.inputs.find((item) => item.input_id === use.input_id);
			if (
				!consumer ||
				consumer.kind !== "execution" ||
				!input ||
				!candidateUseAllowed(workflow, consumer.node_id, input)
			)
				error("stage_internal_use_invalid", path, `${use.consumer_node_id}/${use.input_id}`);
			if (consumer?.agents.some((agent) => agent.permissions.external_actions))
				error(
					"candidate_external_action",
					path,
					"Candidate consumers cannot authorize external actions before release",
				);
		}
		for (const id of duplicateIds(stage.exits.map((exit) => outputRefKey(exit.output))))
			error("stage_exit_duplicate", path, id);
		for (const exit of stage.exits) {
			const producer = nodes.get(exit.output.node_id);
			if (
				!stage.member_node_ids.includes(exit.output.node_id) ||
				producer?.kind !== "execution" ||
				!producer.outputs.some((output) => output.output_id === exit.output.output_id)
			)
				error("stage_exit_invalid", path, outputRefKey(exit.output));
			for (const gateId of exit.gate_node_ids) {
				const gate = nodes.get(gateId);
				if (
					gate?.kind !== "review" ||
					!gate.targets.some((target) => outputRefKey(target) === outputRefKey(exit.output)) ||
					!workflow.completion.required_review_node_ids.includes(gateId)
				)
					error("stage_gate_invalid", path, `${gateId} must be a required review of ${outputRefKey(exit.output)}`);
			}
		}
	}
	for (const node of workflow.nodes) {
		for (const input of node.inputs) {
			if (input.kind !== "node_output") continue;
			const stage = stages.find((item) => item.member_node_ids.includes(input.source.node_id));
			if (!stage || stage.member_node_ids.includes(node.node_id)) continue;
			const ownGate =
				node.kind === "review" && stage.exits.some((exit) => exit.gate_node_ids.includes(node.node_id));
			if (ownGate) continue;
			const exit = stage.exits.find((item) => outputRefKey(item.output) === outputRefKey(input.source));
			if (
				!exit ||
				input.availability !== "approved" ||
				!exit.gate_node_ids.every((id) => input.approval_review_node_ids.includes(id))
			)
				error(
					"stage_exit_bypass",
					`/nodes/${node.node_id}/inputs/${input.input_id}`,
					"Cross-stage use must bind the declared exit and all of its Gates",
				);
		}
		if (node.kind !== "review") continue;
		for (const id of duplicateIds((node.criterion_subjects ?? []).map((item) => item.criterion_id)))
			error("review_subject_duplicate", `/nodes/${node.node_id}`, id);
		for (const subject of node.criterion_subjects ?? []) {
			const expected = node.targets
				.filter((target) => target.criterion_refs.includes(subject.criterion_id))
				.map(outputRefKey)
				.sort();
			if (JSON.stringify(expected) !== JSON.stringify(subject.targets.map(outputRefKey).sort()))
				error(
					"review_subject_mismatch",
					`/nodes/${node.node_id}`,
					`Explicit subjects must exactly match the targets for ${subject.criterion_id}`,
				);
		}
		for (const relation of node.required_relations ?? []) {
			if (
				![relation.consumer, relation.basis].every((ref) =>
					node.targets.some((target) => outputRefKey(ref) === outputRefKey(target)),
				)
			)
				error(
					"review_relation_target_unknown",
					`/nodes/${node.node_id}`,
					"A required version relation must refer to two review targets",
				);
			const consumer = nodes.get(relation.consumer.node_id);
			if (
				!consumer?.inputs.some(
					(input) =>
						input.kind === "node_output" &&
						outputRefKey(input.source) === outputRefKey(relation.basis) &&
						(input.purpose ?? "content_basis") === "content_basis",
				)
			)
				error(
					"review_relation_not_declared",
					`/nodes/${node.node_id}`,
					"Required derivation must correspond to a declared content input",
				);
		}
		for (const id of new Set(node.targets.flatMap((target) => target.criterion_refs))) {
			if (
				criterionSubjects(node, id).length > 1 &&
				!node.criterion_subjects?.some((item) => item.criterion_id === id)
			)
				error(
					"review_criterion_target_ambiguous",
					`/nodes/${node.node_id}`,
					`Composite criterion ${id} requires explicit criterion_subjects`,
				);
		}
		for (const mapping of node.remediation_mappings ?? []) {
			const observed = nodes.get(mapping.observed.node_id);
			const owner = nodes.get(mapping.owner.node_id);
			if (
				!criterionSubjects(node, mapping.criterion_id).some(
					(target) => outputRefKey(target) === outputRefKey(mapping.observed),
				) ||
				owner?.kind !== "execution" ||
				!owner.outputs.some((output) => output.output_id === mapping.owner.output_id) ||
				!node.allowed_rework_node_ids.includes(mapping.owner.node_id) ||
				!node.inputs.some(
					(input) =>
						input.kind === "node_output" &&
						input.required &&
						outputRefKey(input.source) === outputRefKey(mapping.owner),
				) ||
				!observed?.inputs.some(
					(input) =>
						input.kind === "node_output" &&
						(input.purpose ?? "content_basis") === "content_basis" &&
						outputRefKey(input.source) === outputRefKey(mapping.owner),
				)
			)
				error(
					"remediation_mapping_invalid",
					`/nodes/${node.node_id}`,
					"Cross-target remediation requires a declared content dependency, assigned observation and bound owner output",
				);
		}
	}
	const requirements = new Map(
		(workflow.requirements ?? []).map((requirement) => [requirement.requirement_id, requirement]),
	);
	const decisions = new Map((workflow.decisions ?? []).map((decision) => [decision.decision_id, decision]));
	for (const id of duplicateIds((workflow.requirements ?? []).map((item) => item.requirement_id)))
		error("requirement_duplicate", "/requirements", id);
	for (const id of duplicateIds((workflow.decisions ?? []).map((item) => item.decision_id)))
		error("decision_duplicate", "/decisions", id);
	const sources = processSources(spec);
	for (const [requirementIndex, requirement] of (workflow.requirements ?? []).entries()) {
		const requirementPath = `/requirements/${requirementIndex}`;
		const sourceMismatch = (field: string, expected: string) =>
			error(
				"requirement_source_mismatch",
				`${requirementPath}/${field}`,
				`${requirement.requirement_id}: received source_ref=${JSON.stringify(requirement.source_ref)}. ${expected} Repair only the source fields; preserve unrelated description, authority and criteria.`,
			);
		if (requirement.authority === "recommendation" && requirement.strength === "required")
			error("recommendation_promoted", "/requirements", requirement.requirement_id);
		if (
			requirement.authority === "user" &&
			(requirement.source_ref !== task.task_input_id || !task.raw_task.text.includes(requirement.source_quote))
		)
			sourceMismatch(
				requirement.source_ref === task.task_input_id ? "source_quote" : "source_ref",
				`Use TaskInput ID ${JSON.stringify(task.task_input_id)} and an exact quote from raw_task.text.`,
			);
		if (requirement.authority === "process") {
			const entries = sources.filter((source) => source.source_ref === requirement.source_ref);
			if (entries.length !== 1 || !entries[0].source_quote.includes(requirement.source_quote)) {
				const quoteMatches = sources
					.filter((source) => source.source_quote.includes(requirement.source_quote))
					.map((source) => source.source_ref);
				sourceMismatch(
					entries.length === 1 ? "source_quote" : "source_ref",
					`Use an exact selected ProcessSpec entry ID, not a spec/version or selection ID. ${quoteMatches.length ? `This quote occurs in ${JSON.stringify(quoteMatches.slice(0, 8))}${quoteMatches.length > 8 ? " (more entries in source view)" : ""}.` : "The quote does not match a selected source entry."} Read workflow_draft_read(view=process, kind=sources) or bind with governance.requirements.from_process.`,
				);
			}
		}
		if (requirement.authority === "design" && !decisions.has(requirement.source_ref))
			error("requirement_decision_missing", "/requirements", requirement.requirement_id);
		if (
			requirement.authority === "design" &&
			!decisions.get(requirement.source_ref)?.description.includes(requirement.source_quote)
		)
			sourceMismatch(
				"source_quote",
				"Use an existing decision ID and an exact quote from that decision description.",
			);
		if (
			requirement.strength === "required" &&
			!workflow.criteria.some(
				(criterion) =>
					criterion.blocking !== false &&
					criterion.requirement_refs?.includes(requirement.requirement_id) &&
					workflow.nodes.some(
						(node) =>
							workflow.completion.required_node_ids.includes(node.node_id) &&
							(node.kind === "execution"
								? criterion.kind === "mechanical" &&
									node.outputs.some((output) => output.criterion_refs.includes(criterion.criterion_id))
								: workflow.completion.required_review_node_ids.includes(node.node_id) &&
									node.targets.some((target) => target.criterion_refs.includes(criterion.criterion_id))),
					),
			)
		)
			error("required_requirement_unchecked", "/requirements", requirement.requirement_id);
	}
	for (const decision of decisions.values())
		for (const id of decision.requirement_refs) {
			if (!requirements.has(id)) error("requirement_unknown", "/decisions", id);
			if (requirements.get(id)?.source_ref === decision.decision_id)
				error("circular_design_authority", "/decisions", id);
		}
	for (const node of workflow.nodes) {
		for (const id of node.contract.requirement_refs ?? [])
			if (!requirements.has(id)) error("requirement_unknown", `/nodes/${node.node_id}`, id);
		for (const id of node.contract.decision_refs ?? [])
			if (!decisions.has(id)) error("decision_unknown", `/nodes/${node.node_id}`, id);
	}
	for (const criterion of workflow.criteria) {
		for (const id of criterion.requirement_refs ?? []) {
			const requirement = requirements.get(id);
			if (!requirement) error("requirement_unknown", "/criteria", id);
			else if (criterion.blocking !== false && requirement.strength === "advisory")
				error("advisory_gate_blocking", "/criteria", criterion.criterion_id);
		}
		if (criterion.kind === "semantic" && criterion.process_criterion_refs.length > 0 && criterion.blocking === false)
			error("process_criterion_weakened", "/criteria", criterion.criterion_id);
	}
	const authorizedRequirement = (id: string, visiting: Set<string>): boolean => {
		const requirement = requirements.get(id);
		if (
			!requirement ||
			requirement.strength !== "required" ||
			requirement.authority === "recommendation" ||
			visiting.has(id)
		)
			return false;
		if (requirement.authority !== "design") return true;
		const next = new Set(visiting).add(id);
		const decision = decisions.get(requirement.source_ref);
		return decision?.requirement_refs.some((ref) => authorizedRequirement(ref, next)) === true;
	};
	for (const requirement of requirements.values())
		if (requirement.strength === "required" && !authorizedRequirement(requirement.requirement_id, new Set()))
			error("requirement_authority_unproven", "/requirements", requirement.requirement_id);
	return diagnostics;
}
