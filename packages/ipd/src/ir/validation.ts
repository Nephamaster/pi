import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { IpdDiagnostic } from "./types.ts";

export function validateSchema<T>(
	schema: TSchema,
	value: unknown,
	source?: string,
): { ok: true; value: T } | { ok: false; diagnostics: IpdDiagnostic[] } {
	const validator = Compile(schema);
	if (validator.Check(value)) {
		return { ok: true, value: value as T };
	}
	return {
		ok: false,
		diagnostics: validator.Errors(value).map((error) => ({
			code: "schema_invalid",
			path: error.instancePath || "/",
			message: error.message,
			source,
		})),
	};
}
