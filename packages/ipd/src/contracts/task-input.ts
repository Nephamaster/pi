// 定义保留来源的任务、要求、材料和未决事实契约。
import Type, { type Static } from "typebox";
import { IdentifierSchema, NonEmptyStringSchema, OpaqueIdSchema } from "./primitives.ts";

export const SourcedStatementSchema = Type.Object(
	{
		text: NonEmptyStringSchema,
		source: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const TaskObjectiveSchema = Type.Object(
	{
		objective_id: IdentifierSchema,
		statement: SourcedStatementSchema,
	},
	{ additionalProperties: false },
);

export const TaskRequirementSchema = Type.Object(
	{
		requirement_id: IdentifierSchema,
		statement: SourcedStatementSchema,
	},
	{ additionalProperties: false },
);

export const TaskMaterialSchema = Type.Object(
	{
		material_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		reference: NonEmptyStringSchema,
		media_type: Type.Optional(NonEmptyStringSchema),
	},
	{ additionalProperties: false },
);

export const UnresolvedFactSchema = Type.Object(
	{
		fact_id: IdentifierSchema,
		description: NonEmptyStringSchema,
		source: NonEmptyStringSchema,
	},
	{ additionalProperties: false },
);

export const TaskInputSchema = Type.Object(
	{
		schema_version: Type.Literal(1),
		task_input_id: OpaqueIdSchema,
		raw_task: SourcedStatementSchema,
		objectives: Type.Array(TaskObjectiveSchema),
		requirements: Type.Array(TaskRequirementSchema),
		materials: Type.Array(TaskMaterialSchema),
		unresolved_facts: Type.Array(UnresolvedFactSchema),
	},
	{ additionalProperties: false },
);

export type TaskInput = Static<typeof TaskInputSchema>;
