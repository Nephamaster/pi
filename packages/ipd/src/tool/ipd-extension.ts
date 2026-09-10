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
		task: NonEmptyStringSchema,
		objectives: Type.Optional(Type.Array(NonEmptyStringSchema)),
		requirements: Type.Array(NonEmptyStringSchema),
		unresolved_facts: Type.Optional(Type.Array(NonEmptyStringSchema)),
		materials: Type.Array(
			Type.Object(
				{
					material_id: NonEmptyStringSchema,
					description: NonEmptyStringSchema,
					reference: NonEmptyStringSchema,
					media_type: Type.Optional(NonEmptyStringSchema),
				},
				{ additionalProperties: false },
			),
		),
	},
	{ additionalProperties: false },
);

type CreateRunInput = Static<typeof CreateRunSchema>;

function taskInput(input: CreateRunInput): TaskInput {
	return {
		schema_version: 1,
		task_input_id: input.request_id,
		raw_task: { text: input.task, source: "external-agent-request" },
		objectives: (input.objectives ?? []).map((text, index) => ({
			objective_id: `objective-${index + 1}`,
			statement: { text, source: "external-agent-request" },
		})),
		requirements: input.requirements.map((text, index) => ({
			requirement_id: `requirement-${index + 1}`,
			statement: { text, source: "external-agent-request" },
		})),
		materials: input.materials,
		unresolved_facts: (input.unresolved_facts ?? []).map((description, index) => ({
			fact_id: `fact-${index + 1}`,
			description,
			source: "external-agent-request",
		})),
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
			promptSnippet: "Use IPD create_run for long tasks that require structured delivery and independent review.",
			promptGuidelines: [
				"Preserve the user's original task and explicit requirements; do not invent missing business facts.",
				"This Tool only creates a Run. It cannot approve outputs, answer internal roles, skip review, or mutate Run state.",
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
							text: wrapPromptBlock(
								"ipd_run_receipt",
								`IPD Run ${receipt.runId} accepted=${receipt.accepted}; phase=${receipt.phase}; status=${receipt.status}`,
							),
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
