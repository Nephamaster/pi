// 定义 IPD 契约共享的标识、版本、引用和 JSON 原语。
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

export const Sha256Schema = Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" });

export const VersionedAssetRefSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: VersionSchema,
	},
	{ additionalProperties: false },
);

export type VersionedAssetRef = Static<typeof VersionedAssetRefSchema>;

export const LockedAssetRefSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: VersionSchema,
		hash: Sha256Schema,
	},
	{ additionalProperties: false },
);

export type LockedAssetRef = Static<typeof LockedAssetRefSchema>;

export const ContentRecordRefSchema = Type.Object(
	{
		id: OpaqueIdSchema,
		hash: Sha256Schema,
	},
	{ additionalProperties: false },
);

export type ContentRecordRef = Static<typeof ContentRecordRefSchema>;

export const ResourceRefSchema = Type.Object({ id: IdentifierSchema }, { additionalProperties: false });
export type ResourceRef = Static<typeof ResourceRefSchema>;

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
