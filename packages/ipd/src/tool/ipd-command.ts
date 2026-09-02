import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

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

export const IpdToolCommandParametersSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("start"),
			Type.Literal("resume"),
			Type.Literal("status"),
			Type.Literal("cancel"),
		]),
		task: Type.Optional(Type.String({ minLength: 1 })),
		skillName: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateId: Type.Optional(Type.String({ minLength: 1 })),
		tokenBudget: Type.Optional(Type.Integer({ minimum: 4 })),
		expectedDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
		hardTokenLimit: Type.Optional(Type.Integer({ minimum: 1 })),
		runId: Type.Optional(Type.String({ minLength: 1 })),
		escalationId: Type.Optional(Type.String({ minLength: 1 })),
		answer: Type.Optional(Type.String({ minLength: 1 })),
		detail: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("nodes"), Type.Literal("full")])),
		reason: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type IpdToolCommand = Static<typeof IpdToolCommandSchema>;
export type IpdStartCommand = Static<typeof StartCommandSchema>;
export type IpdResumeCommand = Static<typeof ResumeCommandSchema>;
export type IpdStatusCommand = Static<typeof StatusCommandSchema>;
export type IpdCancelCommand = Static<typeof CancelCommandSchema>;
export type IpdToolCommandParameters = Static<typeof IpdToolCommandParametersSchema>;

const commandValidator = Compile(IpdToolCommandSchema);

export function parseIpdToolCommand(value: unknown): IpdToolCommand {
	if (commandValidator.Check(value)) return value as IpdToolCommand;
	const diagnostics = commandValidator
		.Errors(value)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new Error(
		`Invalid IPD ${String((value as { action?: unknown } | null)?.action ?? "unknown")} command: ${diagnostics}`,
	);
}
