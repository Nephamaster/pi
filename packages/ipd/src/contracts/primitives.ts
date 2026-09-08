import Type, { type Static } from "typebox";

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const JsonValueRecursiveSchema = Type.Cyclic(
	{
		JsonValue: Type.Union([
			Type.Null(),
			Type.Boolean(),
			Type.Number(),
			Type.String(),
			Type.Array(Type.Ref("JsonValue")),
			Type.Record(Type.String(), Type.Ref("JsonValue")),
		]),
	},
	"JsonValue",
);

export const JsonValueSchema = Type.Unsafe<JsonValue>(JsonValueRecursiveSchema);

export const IdentifierSchema = Type.String({
	minLength: 1,
	maxLength: 128,
	pattern: "^[A-Za-z][A-Za-z0-9._-]*$",
});

export const OpaqueIdSchema = Type.String({
	minLength: 1,
	maxLength: 256,
	pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
});

export const VersionSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$",
});

export const NonEmptyStringSchema = Type.String({ minLength: 1 });

export const ThinkingLevelSchema = Type.Union([
	Type.Literal("off"),
	Type.Literal("minimal"),
	Type.Literal("low"),
	Type.Literal("medium"),
	Type.Literal("high"),
	Type.Literal("xhigh"),
	Type.Literal("max"),
]);

export type ThinkingLevel = Static<typeof ThinkingLevelSchema>;
