// Freeze review subjects, provenance relations, and decision policy at Attempt claim time.
import { criterionSubjects, outputRefKey } from "../compiler/governance-policy.ts";
import type { EffectiveNode } from "../contracts/baseline.ts";
import type { ReviewBundleRecord } from "../contracts/governance.ts";
import type { RoundInputBindingRecord, RunState } from "../contracts/runtime.ts";
import { hashJson } from "../ir/hash.ts";
import { boundArtifact, versionRelationsSatisfied } from "./artifact-governance.ts";

export function buildReviewBundle(
	state: RunState,
	node: EffectiveNode,
	attemptId: string,
	bindings: readonly RoundInputBindingRecord[],
): ReviewBundleRecord {
	const definition = node.definition;
	if (definition.kind !== "review" || !state.baseline)
		throw new Error("Review Bundle requires a frozen review contract");
	if (!versionRelationsSatisfied(state, bindings))
		throw new Error("Review input versions have incompatible provenance");
	const inputs = bindings.flatMap((binding) => {
		const ref = boundArtifact(state, binding);
		return ref ? [ref] : [];
	});
	const refFor = (ref: { node_id: string; output_id: string }) => {
		const target = inputs.find((input) => input.nodeId === ref.node_id && input.outputId === ref.output_id);
		if (!target) throw new Error(`Review target is not bound: ${outputRefKey(ref)}`);
		return target;
	};
	const targets = definition.targets.map(refFor);
	const requiredRelations = (definition.required_relations ?? []).map((relation) => ({
		consumerRevisionId: refFor(relation.consumer).revisionId,
		basisRevisionId: refFor(relation.basis).revisionId,
	}));
	for (const relation of requiredRelations) {
		if (
			!state.governance.artifacts
				.find((item) => item.revisionId === relation.consumerRevisionId)
				?.bases.some((basis) => basis.purpose === "content_basis" && basis.revisionId === relation.basisRevisionId)
		)
			throw new Error(
				`Review required derivation is absent: ${relation.consumerRevisionId} -> ${relation.basisRevisionId}`,
			);
	}
	const criteria = node.criteria
		.filter((criterion) => criterion.kind === "semantic")
		.map((criterion) => ({
			criterionId: criterion.criterion_id,
			blocking: criterion.blocking !== false,
			subjectRevisionIds: criterionSubjects(definition, criterion.criterion_id)
				.map((ref) => refFor(ref).revisionId)
				.sort(),
			requiredParticipantIds: node.agents.map((agent) => agent.participantId),
		}));
	const contents = {
		baselineId: state.baseline.baselineId,
		reviewNodeId: definition.node_id,
		attemptId,
		targets,
		inputs,
		criteria,
		requiredRelations,
		policy: {
			aggregation: "all_required" as const,
			independentProduction: definition.decision_policy?.independent_production ?? true,
		},
		backgroundHash: hashJson({
			task: state.baseline.report.taskInputHash ?? null,
			criteria: node.criteria,
			contract: definition.contract,
		}),
	};
	const digest = hashJson(contents);
	return { ...contents, bundleId: `${attemptId}:bundle`, digest, createdAt: Date.now() };
}
