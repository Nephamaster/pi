import Type, { type Static } from "typebox";
import { Compile } from "typebox/compile";

const StartCommandSchema = Type.Object(
	{
		action: Type.Literal("start"),
		task: Type.String({ minLength: 1 }),
		skillName: Type.String({ minLength: 1 }),
		workflowTemplateId: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateVersion: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
		ifBudget: Type.Optional(Type.Boolean()),
		tokenBudget: Type.Optional(Type.Integer({ minimum: 4 })),
		expectedDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
		timeBudgetMs: Type.Optional(Type.Integer({ minimum: 1 })),
		hardTokenLimit: Type.Optional(Type.Integer({ minimum: 1 })),
	},
	{ additionalProperties: false },
);

const ResumeRunCommandSchema = Type.Object(
	{ action: Type.Literal("resume_run"), runId: Type.String({ minLength: 1 }) },
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

const WatchCommandSchema = Type.Object(
	{
		action: Type.Literal("watch"),
		runId: Type.String({ minLength: 1 }),
		afterSequence: Type.Optional(Type.Integer({ minimum: 0 })),
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
	[StartCommandSchema, ResumeRunCommandSchema, StatusCommandSchema, WatchCommandSchema, CancelCommandSchema],
	{ discriminator: "action" },
);

export const IpdToolCommandParametersSchema = Type.Object(
	{
		action: Type.Union([
			Type.Literal("start"),
			Type.Literal("resume_run"),
			Type.Literal("status"),
			Type.Literal("watch"),
			Type.Literal("cancel"),
		]),
		task: Type.Optional(Type.String({ minLength: 1 })),
		skillName: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateId: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateVersion: Type.Optional(Type.String({ minLength: 1 })),
		workflowTemplateHash: Type.Optional(Type.String({ minLength: 64, maxLength: 64, pattern: "^[a-f0-9]{64}$" })),
		ifBudget: Type.Optional(Type.Boolean()),
		tokenBudget: Type.Optional(Type.Integer({ minimum: 4 })),
		expectedDurationMs: Type.Optional(Type.Integer({ minimum: 1 })),
		timeBudgetMs: Type.Optional(Type.Integer({ minimum: 1 })),
		hardTokenLimit: Type.Optional(Type.Integer({ minimum: 1 })),
		runId: Type.Optional(Type.String({ minLength: 1 })),
		detail: Type.Optional(Type.Union([Type.Literal("summary"), Type.Literal("nodes"), Type.Literal("full")])),
		afterSequence: Type.Optional(Type.Integer({ minimum: 0 })),
		reason: Type.Optional(Type.String({ minLength: 1 })),
	},
	{ additionalProperties: false },
);

export type IpdToolCommand = Static<typeof IpdToolCommandSchema>;
export type IpdStartCommand = Static<typeof StartCommandSchema>;
export type IpdResumeRunCommand = Static<typeof ResumeRunCommandSchema>;
export type IpdStatusCommand = Static<typeof StatusCommandSchema>;
export type IpdWatchCommand = Static<typeof WatchCommandSchema>;
export type IpdCancelCommand = Static<typeof CancelCommandSchema>;
export type IpdToolCommandParameters = Static<typeof IpdToolCommandParametersSchema>;

const commandValidator = Compile(IpdToolCommandSchema);

export function parseIpdToolCommand(value: unknown): IpdToolCommand {
	if (commandValidator.Check(value)) {
		const command = value as IpdToolCommand;
		if (command.action !== "start") return command;
		const ifBudget = command.ifBudget ?? false;
		if (!command.workflowTemplateId && (command.workflowTemplateVersion || command.workflowTemplateHash)) {
			throw new Error("Invalid IPD start command: Workflow Template version/hash require workflowTemplateId");
		}
		if (ifBudget && (command.tokenBudget === undefined || command.timeBudgetMs === undefined)) {
			throw new Error("Invalid IPD start command: ifBudget=true requires tokenBudget and timeBudgetMs");
		}
		if (
			!ifBudget &&
			(command.tokenBudget !== undefined ||
				command.timeBudgetMs !== undefined ||
				command.hardTokenLimit !== undefined)
		) {
			throw new Error("Invalid IPD start command: budget limits require ifBudget=true");
		}
		return { ...command, ifBudget };
	}
	const diagnostics = commandValidator
		.Errors(value)
		.map((error) => `${error.instancePath || "/"}: ${error.message}`)
		.join("; ");
	throw new Error(
		`Invalid IPD ${String((value as { action?: unknown } | null)?.action ?? "unknown")} command: ${diagnostics}`,
	);
}
