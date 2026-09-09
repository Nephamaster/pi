// 定义节点交付物的基础业务契约。
import Type, { type Static } from "typebox";
import { IdentifierSchema, NonEmptyStringSchema } from "./primitives.ts";

export const ArtifactContractSchema = Type.Object(
	{
		id: IdentifierSchema,
		artifactType: IdentifierSchema,
		description: NonEmptyStringSchema,
		businessPurpose: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export type ArtifactContract = Static<typeof ArtifactContractSchema>;
