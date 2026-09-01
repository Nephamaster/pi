import { Compile } from "typebox/compile";
import type { CheckDefinition, IpdDiagnostic } from "../ir/types.ts";

export interface CheckRegistry {
	list(): readonly CheckDefinition[];
	get(id: string): CheckDefinition | undefined;
	validate(id: string, parameters: unknown, path: string): IpdDiagnostic[];
}

export class InMemoryCheckRegistry implements CheckRegistry {
	private readonly checks = new Map<string, CheckDefinition>();

	add(definition: CheckDefinition): IpdDiagnostic | undefined {
		if (this.checks.has(definition.id)) {
			return {
				code: "asset_collision",
				path: "/id",
				message: `Check ${definition.id} is already registered`,
			};
		}
		this.checks.set(definition.id, definition);
		return undefined;
	}

	list(): readonly CheckDefinition[] {
		return Array.from(this.checks.values()).sort((left, right) => left.id.localeCompare(right.id));
	}

	get(id: string): CheckDefinition | undefined {
		return this.checks.get(id);
	}

	validate(id: string, parameters: unknown, path: string): IpdDiagnostic[] {
		const definition = this.checks.get(id);
		if (!definition) {
			return [{ code: "unknown_check", path, message: `Unknown mechanical check: ${id}` }];
		}
		const validator = Compile(definition.parameters);
		if (validator.Check(parameters)) return [];
		return validator.Errors(parameters).map((error) => ({
			code: "check_parameters_invalid",
			path: `${path}${error.instancePath}`,
			message: error.message,
		}));
	}
}
