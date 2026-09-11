// 定义外部 Pi 可调用的 IPD 创建和只读查询工具。
import { defineTool, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { NonEmptyStringSchema } from "../contracts/primitives.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import type { IpdService } from "../runtime/ipd-service.ts";

const CreateRunSchema = Type.Object(
	{
		request_id: NonEmptyStringSchema,
		skill_name: NonEmptyStringSchema,
		task: Type.String({
			minLength: 1,
			description:
				"The user's complete task request copied verbatim. Do not summarize, rewrite, expand, interpret, or add Skill instructions.",
		}),
		materials: Type.Optional(
			Type.Array(
				Type.Object(
					{
						material_id: NonEmptyStringSchema,
						description: NonEmptyStringSchema,
						reference: NonEmptyStringSchema,
						media_type: Type.Optional(NonEmptyStringSchema),
					},
					{ additionalProperties: false },
				),
				{
					description:
						"Task materials explicitly supplied or referenced by the user. Never include Skill files, Skill scripts, or inferred materials.",
				},
			),
		),
	},
	{ additionalProperties: false },
);

type CreateRunInput = Static<typeof CreateRunSchema>;

function taskInput(input: CreateRunInput): TaskInput {
	return {
		schema_version: 2,
		task_input_id: input.request_id,
		raw_task: { text: input.task, source: "external-agent-request" },
		materials: input.materials ?? [],
		unresolved_facts: [],
	};
}

export type IpdServiceProvider = (context: ExtensionContext) => Promise<IpdService>;

export function registerIpdCreateRunTool(pi: ExtensionAPI, serviceProvider: IpdServiceProvider): void {
	pi.registerTool(
		defineTool({
			name: "ipd",
			label: "IPD",
			description:
				"Create one governed IPD Run from the user's preserved task. Internal planning and execution continue without outer-agent orchestration.",
			promptSnippet:
				"Use IPD create_run for long tasks that require structured delivery and independent review. Pass request_id, skill_name, the user's complete verbatim task, and only user-supplied task materials when present.",
			promptGuidelines: [
				"Copy the user's complete task request verbatim into task. Do not summarize, rewrite, expand, interpret, classify, or extract requirements before handing the task to IPD.",
				"skill_name binds the task Skill separately. Do not repeat Skill instructions, files, scripts, inferred requirements, materials, or unresolved facts in task.",
				"materials is optional and contains only task materials explicitly supplied or referenced by the user. Never include the bound Skill, Skill files, Skill scripts, or Agent-inferred materials.",
				"This Tool only creates a Run. IPD owns task interpretation, process selection, Workflow design, execution, and review after creation.",
			],
			parameters: CreateRunSchema,
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const service = await serviceProvider(context);
				const receipt = await service.createRun(input.request_id, taskInput(input), input.skill_name);
				const lines = [
					`IPD Run ${receipt.runId} accepted=${receipt.accepted}; phase=${receipt.phase}; status=${receipt.status}`,
				];
				if (receipt.visualization) {
					lines.push(`Visualization: ${receipt.visualization.url}`);
					lines.push(`Snapshot: ${receipt.visualization.snapshotUrl}`);
					if (receipt.visualization.shareHint) lines.push(receipt.visualization.shareHint);
				} else if (receipt.visualizationError) {
					lines.push(`Visualization unavailable: ${receipt.visualizationError}`);
				}
				return {
					content: [
						{
							type: "text",
							text: wrapPromptBlock("ipd_run_receipt", lines.join("\n")),
						},
					],
					details: receipt,
				};
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "ipd_get_run",
			label: "Get IPD Run",
			description: "Read the current registered state of one IPD Run without advancing it.",
			parameters: Type.Object({ run_id: NonEmptyStringSchema }, { additionalProperties: false }),
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const state = await (await serviceProvider(context)).getRun(input.run_id);
				const view = {
					run_id: state.runId,
					phase: state.phase,
					status: state.status,
					revision: state.revision,
					last_event_sequence: state.events.at(-1)?.sequence ?? 0,
					nodes: state.nodes,
					failure: state.failure,
				};
				return {
					content: [{ type: "text", text: wrapPromptBlock("ipd_run_status", JSON.stringify(view)) }],
					details: view,
				};
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "ipd_read_events",
			label: "Read IPD Events",
			description: "Read registered IPD Run events after a sequence cursor without advancing the Run.",
			parameters: Type.Object(
				{ run_id: NonEmptyStringSchema, after_sequence: Type.Optional(Type.Integer({ minimum: 0 })) },
				{ additionalProperties: false },
			),
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const events = await (await serviceProvider(context)).readEvents(input.run_id, input.after_sequence ?? 0);
				return {
					content: [{ type: "text", text: wrapPromptBlock("ipd_run_events", JSON.stringify(events)) }],
					details: { events },
				};
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "ipd_get_result",
			label: "Get IPD Result",
			description: "Read the terminal result and Runtime-materialized user delivery of one IPD Run.",
			parameters: Type.Object({ run_id: NonEmptyStringSchema }, { additionalProperties: false }),
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const result = await (await serviceProvider(context)).getResult(input.run_id);
				const view = {
					run_id: result.state.runId,
					phase: result.state.phase,
					status: result.state.status,
					final_submission_ids: result.finalSubmissionIds,
					final_submission: result.finalSubmission,
					failure: result.state.failure,
				};
				return {
					content: [{ type: "text", text: wrapPromptBlock("ipd_run_result", JSON.stringify(view)) }],
					details: view,
				};
			},
		}),
	);
}

export function createIpdExtension(service: IpdService): (pi: ExtensionAPI) => void {
	return (pi) => registerIpdCreateRunTool(pi, async () => service);
}
