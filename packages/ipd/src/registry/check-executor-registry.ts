import type { Static, TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ArtifactContract, ArtifactManifest } from "../artifact/manifest.ts";
import type { CheckDefinition, IpdDiagnostic, JsonValue } from "../ir/types.ts";
import type { CheckRegistry } from "./check-registry.ts";

export interface CheckExecutionContext {
	workspace: string;
	contract: ArtifactContract;
	manifest: ArtifactManifest;
	artifacts: Array<{ contract: ArtifactContract; manifest: ArtifactManifest }>;
}

export interface CheckExecutorResult {
	result: "PASS" | "FAIL" | "BLOCKED";
	evidence: JsonValue;
	message: string;
}

export interface CheckExecutor extends CheckDefinition {
	execute(parameters: JsonValue, context: CheckExecutionContext, signal?: AbortSignal): Promise<CheckExecutorResult>;
}

export function defineCheckExecutor<TParameters extends TSchema>(input: {
	id: string;
	parameters: TParameters;
	execute(
		parameters: Static<TParameters>,
		context: CheckExecutionContext,
		signal?: AbortSignal,
	): Promise<CheckExecutorResult>;
}): CheckExecutor {
	return {
		id: input.id,
		parameters: input.parameters,
		execute: (parameters, context, signal) => input.execute(parameters as Static<TParameters>, context, signal),
	};
}

export class CheckExecutorRegistry implements CheckRegistry {
	private readonly executors = new Map<string, CheckExecutor>();

	add(executor: CheckExecutor): IpdDiagnostic | undefined {
		if (this.executors.has(executor.id)) {
			return {
				code: "asset_collision",
				path: "/id",
				message: `Check Executor is already registered: ${executor.id}`,
			};
		}
		this.executors.set(executor.id, executor);
		return undefined;
	}

	list(): readonly CheckExecutor[] {
		return Array.from(this.executors.values()).sort((left, right) => left.id.localeCompare(right.id));
	}

	get(id: string): CheckExecutor | undefined {
		return this.executors.get(id);
	}

	validate(id: string, parameters: unknown, path: string): IpdDiagnostic[] {
		const executor = this.executors.get(id);
		if (!executor) return [{ code: "unknown_check", path, message: `Unknown mechanical check: ${id}` }];
		const validator = Compile(executor.parameters);
		if (validator.Check(parameters)) return [];
		return validator.Errors(parameters).map((error) => ({
			code: "check_parameters_invalid",
			path: `${path}${error.instancePath}`,
			message: error.message,
		}));
	}
}
