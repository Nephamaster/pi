import Type, { type Static } from "typebox";

const StartCommandSchema = Type.Object(
	{
		action: Type.Literal("start"),
		task: Type.String({ minLength: 1 }),
		skillName: Type.String({ minLength: 1 }),
		workflowTemplateId: Type.Optional(Type.String({ minLength: 1 })),
		tokenBudget: Type.Optional(Type.Integer({ minimum: 4 })),
		expectedDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
		hardTokenLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const ResumeCommandSchema = Type.Object(
	{
		action: Type.Literal("resume"),
		runId: Type.String({ minLength: 1 }),
		escalationId: Type.String({ minLength: 1 }),
		answer: Type.String({ minLength: 1 }),
	},
	{ additionalProperties: false },
);

const StatusCommandSchema = Type.Object(
	{
		action: Type.Literal("status"),
		runId: Type.String({ minLength: 1 }),
		detail: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("nodes"), Type.Literal("full")])),
	},
	{ additionalProperties: false },
);

const CancelCommandSchema = Type.Object(
	{
		action: Type.Literal("cancel"),
		runId: Type.String({ minLength: 1 }),
		reason: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export const IpdToolCommandSchema = Type.Union(
	[StartCommandSchema, ResumeCommandSchema, StatusCommandSchema, CancelCommandSchema],
	{ discriminator: "action" },
);

export type IpdToolCommand = Static<typeof IpdToolCommandSchema>;
export type IpdStartCommand = Static<typeof StartCommandSchema>;
export type IpdResumeCommand = Static<typeof ResumeCommandSchema>;
export type IpdStatusCommand = Static<typeof StatusCommandSchema>;
export type IpdCancelCommand = Static<typeof CancelCommandSchema>;
