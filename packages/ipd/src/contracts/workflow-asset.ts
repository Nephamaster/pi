import Type, { type Static } from "typebox";
import { IdentifierSchema, JsonValueSchema, VersionSchema } from "./primitives.ts";

export const WorkflowAssetSchema = Type.Object(
	{
		id: IdentifierSchema,
		version: VersionSchema,
	},
	{ additionalProperties: JsonValueSchema },
);

export type WorkflowAsset = Static<typeof WorkflowAssetSchema>;
