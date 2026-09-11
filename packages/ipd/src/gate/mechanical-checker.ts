// 执行可注册的确定性质量检查并汇总逐项结果。
import Type from "typebox";
import { extname } from "node:path";
import { validateArtifactManifest } from "../artifact/manifest.ts";
import type { JsonValue } from "../contracts/primitives.ts";
import type { CriterionDefinition } from "../contracts/workflow.ts";
import { toJsonValue } from "../ir/hash.ts";
import type { IpdDiagnostic } from "../ir/types.ts";
import {
	type CheckExecutionContext,
	type CheckExecutorRegistry,
	defineCheckExecutor,
} from "../registry/check-executor-registry.ts";

export interface MechanicalCriterionOutcome {
	criterionId: string;
	checkId: string;
	result: "PASS" | "FAIL" | "ERROR";
	evidence: JsonValue;
	message: string;
	durationMs: number;
}

export interface MechanicalGateOutcome {
	result: "PASS" | "FAIL" | "ERROR";
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
		criteria: readonly Extract<CriterionDefinition, { kind: "mechanical" }>[],
		context: CheckExecutionContext,
		signal?: AbortSignal,
	): Promise<MechanicalGateOutcome> {
		const outcomes: MechanicalCriterionOutcome[] = [];
		for (const [index, criterion] of criteria.entries()) {
			signal?.throwIfAborted();
			const path = `/criteria/${index}/parameters`;
			const diagnostics = this.registry.validate(criterion.check_id, criterion.parameters, path);
			if (diagnostics.length > 0)
				throw new MechanicalCheckError("Mechanical Check configuration is invalid", diagnostics);
			const executor = this.registry.get(criterion.check_id);
			if (!executor) {
				throw new MechanicalCheckError("Mechanical Check is not registered", [
					{ code: "unknown_check", path, message: `Unknown mechanical check: ${criterion.check_id}` },
				]);
			}
			const startedAt = this.now();
			try {
				const result = await executor.execute(criterion.parameters, context, signal);
				outcomes.push({
					criterionId: criterion.criterion_id,
					checkId: criterion.check_id,
					...result,
					durationMs: Math.max(0, this.now() - startedAt),
				});
			} catch (error) {
				if (signal?.aborted) throw error;
				outcomes.push({
					criterionId: criterion.criterion_id,
					checkId: criterion.check_id,
					result: "ERROR",
					evidence: { error: error instanceof Error ? error.message : String(error) },
					message: "Mechanical Check execution failed",
					durationMs: Math.max(0, this.now() - startedAt),
				});
			}
		}
		const result = outcomes.some((outcome) => outcome.result === "ERROR")
			? "ERROR"
			: outcomes.some((outcome) => outcome.result === "FAIL")
				? "FAIL"
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

export function createArtifactFileSetCheckExecutor() {
	return defineCheckExecutor({
		id: "artifact-file-set",
		parameters: Type.Object(
			{
				exact_count: Type.Optional(Type.Integer({ minimum: 0 })),
				extensions: Type.Optional(
					Type.Array(Type.String({ pattern: "^\\.[A-Za-z0-9]+$" }), { minItems: 1, uniqueItems: true }),
				),
				file_names: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1, uniqueItems: true })),
			},
			{ additionalProperties: false },
		),
		async execute(parameters, context) {
			const files = context.manifest.files.map((file) => file.path);
			const diagnostics: string[] = [];
			if (parameters.exact_count !== undefined && files.length !== parameters.exact_count)
				diagnostics.push(`Expected exactly ${parameters.exact_count} file(s), received ${files.length}`);
			if (parameters.extensions) {
				const allowed = new Set(parameters.extensions.map((extension) => extension.toLowerCase()));
				for (const file of files) {
					const extension = extname(file).toLowerCase();
					if (!allowed.has(extension)) diagnostics.push(`File ${file} has disallowed extension ${extension || "(none)"}`);
				}
			}
			if (parameters.file_names) {
				const actualNames = new Set(files.map((file) => file.split(/[\\/]/).at(-1) ?? file));
				for (const required of parameters.file_names)
					if (!actualNames.has(required)) diagnostics.push(`Required delivery file is missing: ${required}`);
				for (const actual of actualNames)
					if (!parameters.file_names.includes(actual)) diagnostics.push(`Unexpected delivery file: ${actual}`);
			}
			return diagnostics.length === 0
				? {
						result: "PASS",
						evidence: { files: toJsonValue(files) },
						message: "Artifact file set matches the declared delivery constraint",
					}
				: {
						result: "FAIL",
						evidence: { files: toJsonValue(files), diagnostics: toJsonValue(diagnostics) },
						message: "Artifact file set violates the declared delivery constraint",
					};
		},
	});
}
