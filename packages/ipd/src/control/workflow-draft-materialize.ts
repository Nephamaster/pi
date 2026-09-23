// Deterministic projection only: no model calls, resource grants, or workflow execution.
import type { JsonValue } from "../contracts/primitives.ts";
import type { NodeOutputRef } from "../contracts/workflow.ts";
import { hashJson, toJsonValue } from "../ir/hash.ts";
import { draftCompleteness } from "./workflow-draft-completeness.ts";
import {
	type AuthoringDraft,
	type DraftDiagnostic,
	DraftError,
	type DraftInput,
	type DraftNode,
	outputKey,
} from "./workflow-draft-model.ts";

const lexical = (left: string, right: string) => (left < right ? -1 : left > right ? 1 : 0);
const sortedIds = (ids: readonly string[]) => [...new Set(ids)].sort(lexical);
export const reviewInputId = (ref: NodeOutputRef) => `reviewin-${hashJson(ref).slice(0, 32)}`;
function inputProjection(input: DraftInput): JsonValue {
	if (input.kind === "task_material") return toJsonValue(input);
	const { access, omit_default_purpose, ...value } = input;
	if (omit_default_purpose && value.purpose === "content_basis") delete value.purpose;
	return toJsonValue({
		...value,
		...(access
			? {
					availability: access.mode === "approved" ? "approved" : "submitted",
					approval_review_node_ids: access.mode === "approved" ? sortedIds(access.review_node_ids) : [],
				}
			: {}),
	});
}
export function reviewProjection(node: DraftNode) {
	const plan = node.review_plan;
	const groups = new Map<string, { node_id: string; output_id: string; criterion_refs: string[] }>();
	for (const assignment of plan?.assignments ?? [])
		for (const ref of assignment.subjects) {
			const group = groups.get(outputKey(ref)) ?? { ...ref, criterion_refs: [] };
			group.criterion_refs.push(assignment.criterion_id);
			groups.set(outputKey(ref), group);
		}
	const targets = [...groups.values()]
		.sort((a, b) => lexical(outputKey(a), outputKey(b)))
		.map((target) => ({ ...target, criterion_refs: sortedIds(target.criterion_refs) }));
	const generatedInputs: DraftInput[] = [];
	for (const target of targets) {
		const explicit = node.inputs.filter(
			(input) =>
				input.kind === "node_output" &&
				outputKey(input.source) === outputKey(target) &&
				input.access?.mode === "review_candidate",
		);
		if (explicit.some((input) => input.required === false))
			throw new DraftError(
				"review_input_not_required",
				`review:${node.node_id}.inputs`,
				"An explicit target input must be required=true.",
			);
		if (explicit.length) continue;
		const source = { node_id: target.node_id, output_id: target.output_id };
		const id = reviewInputId(source);
		if (node.inputs.some((input) => input.input_id === id))
			throw new DraftError(
				"generated_input_collision",
				`review:${node.node_id}.inputs`,
				`Reserved generated ID collision: ${id}`,
			);
		generatedInputs.push({
			kind: "node_output",
			input_id: id,
			source,
			required: true,
			purpose: "test_subject",
			access: { mode: "review_candidate" },
		});
	}
	const subjects = (plan?.assignments ?? [])
		.filter(
			(assignment) =>
				assignment.mode === "composite" || plan?.explicit_subject_criteria?.includes(assignment.criterion_id),
		)
		.map((assignment) => ({
			criterion_id: assignment.criterion_id,
			targets: [...assignment.subjects].sort((a, b) => lexical(outputKey(a), outputKey(b))),
		}));
	return { targets, generatedInputs, subjects };
}
export interface MaterializedDraft {
	candidate: JsonValue;
	sourceMap: Record<string, string>;
	diagnostics: DraftDiagnostic[];
}
export function materializeDraft(draft: AuthoringDraft): MaterializedDraft {
	const sourceMap: Record<string, string> = {};
	const nodes = draft.nodes.map((node, index) => {
		const path = `/nodes/${index}`;
		sourceMap[path] = `node:${node.node_id}`;
		for (const field of ["contract", "agents", "environment_ref"])
			sourceMap[`${path}/${field}`] = `node:${node.node_id}.${field === "agents" ? "agent" : field}`;
		const base = {
			kind: node.kind,
			node_id: node.node_id,
			name: node.name,
			...(node.environment_ref ? { environment_ref: node.environment_ref } : {}),
			...(node.contract ? { contract: node.contract } : {}),
			agents: node.agent ? [node.agent] : [],
		};
		node.inputs.forEach((input, inputIndex) => {
			sourceMap[`${path}/inputs/${inputIndex}`] = `node:${node.node_id}.inputs[${input.input_id}]`;
		});
		if (node.kind === "execution")
			return {
				...base,
				inputs: node.inputs.map(inputProjection),
				outputs: node.outputs.map((output, outputIndex) => {
					sourceMap[`${path}/outputs/${outputIndex}`] = `output:${node.node_id}/${output.output_id}`;
					return {
						...output,
						criterion_refs: draft.criteria
							.filter((criterion) =>
								criterion.output_bindings.some(
									(ref) => outputKey(ref) === `${node.node_id}/${output.output_id}`,
								),
							)
							.map((criterion) => criterion.criterion_id),
					};
				}),
			};
		const projected = reviewProjection(node);
		projected.targets.forEach((target, targetIndex) => {
			sourceMap[`${path}/targets/${targetIndex}`] =
				`review:${node.node_id}.assignments[${target.criterion_refs.join(",")}]`;
		});
		projected.generatedInputs.forEach((_input, inputIndex) => {
			sourceMap[`${path}/inputs/${node.inputs.length + inputIndex}`] = `review:${node.node_id}.assignments`;
		});
		const {
			assignments: _assignments,
			explicit_subject_criteria: _explicit,
			...reviewFields
		} = node.review_plan ?? {};
		return {
			...base,
			inputs: [...node.inputs, ...projected.generatedInputs].map(inputProjection),
			...reviewFields,
			targets: projected.targets,
			...(projected.subjects.length || node.review_plan?.explicit_subject_criteria
				? { criterion_subjects: projected.subjects }
				: {}),
		};
	});
	const criteria = draft.criteria.map((item, index) => {
		sourceMap[`/criteria/${index}`] = `criterion:${item.criterion_id}`;
		return { criterion_id: item.criterion_id, ...item.definition };
	});
	const stages = draft.stage_plans.map((stage, index) => {
		sourceMap[`/stages/${index}`] = `stage:${stage.stage_id}`;
		const internal_uses = draft.nodes.flatMap((node) =>
			node.inputs
				.filter(
					(input) =>
						input.kind === "node_output" &&
						input.access?.mode === "stage_candidate" &&
						input.access.stage_id === stage.stage_id,
				)
				.map((input) => ({ consumer_node_id: node.node_id, input_id: input.input_id })),
		);
		return { ...stage, internal_uses };
	});
	draft.process_coverage.forEach((item, index) => {
		sourceMap[`/requirement_coverage/${index}`] = `coverage:${item.source}/${item.requirement_id}`;
	});
	sourceMap["/completion"] = "completion";
	sourceMap["/prerequisites"] = "governance.prerequisites";
	draft.requirements.forEach((item, index) => {
		sourceMap[`/requirements/${index}`] = `requirement:${item.requirement_id}`;
	});
	draft.decisions.forEach((item, index) => {
		sourceMap[`/decisions/${index}`] = `decision:${item.decision_id}`;
	});
	for (const [index, node] of draft.nodes.entries())
		for (const [path, target] of Object.entries({ ...sourceMap }))
			if (path === `/nodes/${index}` || path.startsWith(`/nodes/${index}/`)) {
				const alias = `/nodes/${node.node_id}${path.slice(`/nodes/${index}`.length)}`;
				if (!Object.hasOwn(sourceMap, alias)) sourceMap[alias] = target;
			}
	const include = (name: "stages" | "requirements" | "decisions", length: number) =>
		length > 0 || draft.emptyOptionalSections?.includes(name);
	return {
		candidate: toJsonValue({
			schema_version: 3,
			...draft.metadata,
			...draft.trustedReferences,
			nodes,
			criteria,
			...(draft.prerequisites ? { prerequisites: draft.prerequisites } : {}),
			...(include("stages", stages.length) ? { stages } : {}),
			...(include("requirements", draft.requirements.length) ? { requirements: draft.requirements } : {}),
			...(include("decisions", draft.decisions.length) ? { decisions: draft.decisions } : {}),
			requirement_coverage: draft.process_coverage,
			...(draft.completion ? { completion: draft.completion } : {}),
		}),
		sourceMap,
		diagnostics: draftCompleteness(draft),
	};
}
export function locateDiagnostic(diagnostic: DraftDiagnostic, sourceMap: Record<string, string>): DraftDiagnostic {
	const prefix = Object.keys(sourceMap)
		.filter((path) => diagnostic.path === path || diagnostic.path.startsWith(`${path}/`))
		.sort((a, b) => b.length - a.length)[0];
	const authoringPath = prefix
		? `${sourceMap[prefix]}${diagnostic.path.slice(prefix.length).replaceAll("/", ".")}`
		: diagnostic.path;
	const reviewDiagnostic = /^(review_|remediation_)/u.test(diagnostic.code ?? "");
	const coverageDiagnostic =
		diagnostic.path === "/requirement_coverage" || diagnostic.path.startsWith("/requirement_coverage/");
	const domain =
		reviewDiagnostic || authoringPath.startsWith("review:")
			? "reviews"
			: authoringPath.startsWith("output:")
				? "outputs"
				: authoringPath.startsWith("criterion:")
					? "criteria"
					: coverageDiagnostic || authoringPath.startsWith("coverage:")
						? "coverage"
						: authoringPath.startsWith("stage:")
							? "stages"
							: authoringPath.startsWith("completion")
								? "completion"
								: authoringPath.includes(".inputs")
									? "inputs"
									: authoringPath.startsWith("node:")
										? "configure_nodes"
										: "governance";
	return {
		code: diagnostic.code,
		path: diagnostic.path,
		message: diagnostic.message,
		nodeId: diagnostic.nodeId,
		processRequirementId: diagnostic.processRequirementId,
		category: diagnostic.category,
		authoringPath,
		suggestedTool: `workflow_draft_${domain}`,
	};
}
