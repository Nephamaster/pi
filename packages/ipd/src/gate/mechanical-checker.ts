import Type, { type Static } from "typebox";
import { validateArtifactManifest } from "../artifact/manifest.ts";
import { toJsonValue } from "../ir/hash.ts";
import type { GateDefinition, MechanicalCriterionSchema } from "../ir/schemas.ts";
import type { IpdDiagnostic, JsonValue } from "../ir/types.ts";
import {
	type CheckExecutionContext,
	type CheckExecutorRegistry,
	defineCheckExecutor,
} from "../registry/check-executor-registry.ts";

type MechanicalCriterion = Static<typeof MechanicalCriterionSchema>;

export interface MechanicalCriterionOutcome {
	criterionId: string;
	checkId: string;
	result: "PASS" | "FAIL" | "BLOCKED";
	evidence: JsonValue;
	message: string;
	durationMs: number;
}

export interface MechanicalGateOutcome {
	result: "PASS" | "FAIL" | "BLOCKED";
	criteria: MechanicalCriterionOutcome[];
}

export class MechanicalCheckError extends Error {
	readonly diagnostics: IpdDiagnostic[];

	constructor(message: string, diagnostics: IpdDiagnostic[]) {
		super(message);
		this.name = "MechanicalCheckError";
		this.diagnostics = diagnostics;
	}
}

export class MechanicalChecker {
	private readonly registry: CheckExecutorRegistry;
	private readonly now: () => number;

	constructor(registry: CheckExecutorRegistry, now: () => number = Date.now) {
		this.registry = registry;
		this.now = now;
	}

	async evaluate(
		criteria: readonly MechanicalCriterion[],
		context: CheckExecutionContext,
		signal?: AbortSignal,
	): Promise<MechanicalGateOutcome> {
		const outcomes: MechanicalCriterionOutcome[] = [];
		for (const [index, criterion] of criteria.entries()) {
			signal?.throwIfAborted();
			const path = `/mechanicalCriteria/${index}/parameters`;
			const diagnostics = this.registry.validate(criterion.checkId, criterion.parameters, path);
			if (diagnostics.length > 0)
				throw new MechanicalCheckError("Mechanical Check configuration is invalid", diagnostics);
			const executor = this.registry.get(criterion.checkId);
			if (!executor) {
				throw new MechanicalCheckError("Mechanical Check is not registered", [
					{ code: "unknown_check", path, message: `Unknown mechanical check: ${criterion.checkId}` },
				]);
			}
			const startedAt = this.now();
			try {
				const result = await executor.execute(criterion.parameters, context, signal);
				outcomes.push({
					criterionId: criterion.id,
					checkId: criterion.checkId,
					...result,
					durationMs: Math.max(0, this.now() - startedAt),
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				outcomes.push({
					criterionId: criterion.id,
					checkId: criterion.checkId,
					result: "BLOCKED",
					evidence: { error: error instanceof Error ? error.message : String(error) },
					message: "Mechanical Check execution failed",
					durationMs: Math.max(0, this.now() - startedAt),
				});
			}
		}
		const result = outcomes.some((outcome) => outcome.result === "FAIL")
			? "FAIL"
			: outcomes.some((outcome) => outcome.result === "BLOCKED")
				? "BLOCKED"
				: "PASS";
		return { result, criteria: outcomes };
	}
}

export function createArtifactIntegrityCheckExecutor() {
	return defineCheckExecutor({
		id: "artifact-integrity",
		parameters: Type.Object({}, { additionalProperties: false }),
		async execute(_parameters, context) {
			const validations = await Promise.all(
				context.artifacts.map((artifact) =>
					validateArtifactManifest({
						workspace: context.workspace,
						contract: artifact.contract,
						manifest: artifact.manifest,
					}),
				),
			);
			const diagnostics = validations.flatMap((validation) => validation.diagnostics);
			return diagnostics.length === 0
				? { result: "PASS", evidence: { diagnostics: [] }, message: "Artifact files match the Manifest" }
				: {
						result: "FAIL",
						evidence: { diagnostics: toJsonValue(diagnostics) },
						message: "Artifact integrity validation failed",
					};
		},
	});
}

export function gateMechanicalCriteria(gate: GateDefinition): readonly MechanicalCriterion[] {
	return gate.mechanicalCriteria;
}
