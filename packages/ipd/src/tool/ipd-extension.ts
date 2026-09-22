// 定义外部 Pi 可调用的 IPD 创建和只读查询工具。
import {
	defineTool,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import Type, { type Static } from "typebox";
import { NonEmptyStringSchema } from "../contracts/primitives.ts";
import type { RunState } from "../contracts/runtime.ts";
import type { TaskInput } from "../contracts/task-input.ts";
import { wrapPromptBlock } from "../prompt/block.ts";
import type { IpdService } from "../runtime/ipd-service.ts";
import { completionProblems } from "../runtime/runtime-state.ts";

const CreateRunSchema = Type.Object(
	{
		request_id: NonEmptyStringSchema,
		skill_name: Type.Optional(NonEmptyStringSchema),
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

const AUTOMATIC_PROCESS = "由 IPD 自动选择流程规范";
const AUTOMATIC_WORKFLOW = "由 IPD 设计工作流";

function runControlView(state: RunState) {
	return {
		controller: state.controller,
		active_attempts: (state.attempts ?? []).filter((attempt) =>
			["claimed", "dispatching", "active", "paused"].includes(attempt.status),
		),
		pending_dispatches: (state.dispatchIntents ?? []).filter((dispatch) =>
			["pending", "delivering", "started", "outcome_unknown"].includes(dispatch.status),
		),
		waits: (state.waits ?? []).filter((wait) => wait.state === "waiting"),
		external_operations: (state.externalOperations ?? []).filter((operation) =>
			["pending", "unknown"].includes(operation.outcome),
		),
		active_resources: state.activeResources ?? [],
		findings: state.governance?.findings.filter((finding) => ["open", "addressed"].includes(finding.status)) ?? [],
		stage_releases: state.governance?.releases.filter((release) => release.status === "active") ?? [],
		adoption_holds: state.governance?.adoptions.filter((adoption) => adoption.status === "held") ?? [],
		completion_obligations: state.baseline && state.governance ? completionProblems(state) : [],
	};
}

async function collectMaterials(
	context: ExtensionCommandContext,
	requiredMaterialIds: readonly string[],
): Promise<TaskInput["materials"] | undefined> {
	const materials: TaskInput["materials"] = [];
	const collect = async (materialId: string): Promise<boolean> => {
		const description = await context.ui.input(`材料 ${materialId} 的说明`, "例如：用户提供的需求文档");
		if (description === undefined) return false;
		const reference = await context.ui.input(`材料 ${materialId} 的位置`, "文件路径、URL 或其他可解析引用");
		if (reference === undefined) return false;
		if (!description.trim() || !reference.trim()) {
			context.ui.notify("材料说明和材料位置不能为空", "error");
			return false;
		}
		const mediaType = await context.ui.input(`材料 ${materialId} 的媒体类型（可选）`, "例如：text/markdown");
		if (mediaType === undefined) return false;
		materials.push({
			material_id: materialId,
			description: description.trim(),
			reference: reference.trim(),
			...(mediaType.trim() ? { media_type: mediaType.trim() } : {}),
		});
		return true;
	};
	for (const materialId of requiredMaterialIds) {
		context.ui.notify(`工作流模板要求提供材料：${materialId}`, "info");
		if (!(await collect(materialId))) return undefined;
	}
	while (await context.ui.confirm("任务材料", materials.length === 0 ? "是否添加任务材料？" : "是否继续添加材料？")) {
		const materialId = `material-${materials.length + 1}`;
		if (!(await collect(materialId))) return undefined;
	}
	return materials;
}

async function chooseRunSkill(
	context: ExtensionCommandContext,
	service: IpdService,
	workflow?: Awaited<ReturnType<IpdService["listWorkflowTemplates"]>>[number],
): Promise<string | null | undefined> {
	const available = service
		.listRunSkills()
		.filter((skill) => !["process-selection", "workflow-design"].includes(skill.id));
	const workflowSkillIds = new Set(
		workflow?.workflow.nodes.flatMap((node) =>
			node.agents.flatMap((agent) => agent.skills.map((skill) => skill.id)),
		) ?? [],
	);
	const candidates =
		workflowSkillIds.size > 0 ? available.filter((skill) => workflowSkillIds.has(skill.id)) : available;
	if (candidates.length === 0) return null;
	const labels = candidates.map((skill) => `${skill.id} · ${skill.description}`);
	const skip = "不使用业务 Skill，直接根据任务设计";
	const selected = await context.ui.select("选择任务 Skill（可选）", [skip, ...labels]);
	if (selected === skip) return null;
	return selected === undefined ? undefined : candidates[labels.indexOf(selected)]?.id;
}

function registerIpdCommand(pi: ExtensionAPI, serviceProvider: IpdServiceProvider): void {
	pi.registerCommand("ipd", {
		description: "通过交互界面创建 IPD Run，可选择流程规范和已保存的工作流模板",
		handler: async (args, context) => {
			if (!context.hasUI) {
				context.ui.notify("/ipd 需要可交互的 Pi 界面", "error");
				return;
			}
			try {
				const service = await serviceProvider(context);
				const processSpecs = service.listProcessSpecTemplates();
				const processLabels = processSpecs.map((spec) => `${spec.name} · ${spec.process_spec_id}@${spec.version}`);
				const processChoice = await context.ui.select("选择 IPD 模板", [AUTOMATIC_PROCESS, ...processLabels]);
				if (processChoice === undefined) return;
				const processSpec =
					processChoice === AUTOMATIC_PROCESS ? undefined : processSpecs[processLabels.indexOf(processChoice)];

				let workflowTemplate: Awaited<ReturnType<IpdService["listWorkflowTemplates"]>>[number] | undefined;
				if (processSpec) {
					const workflows = await service.listWorkflowTemplates(processSpec.process_spec_id, processSpec.version);
					const workflowLabels = workflows.map(
						(template) =>
							`${template.workflow.name} · ${template.workflow.workflow_id}@${template.workflow.workflow_version}`,
					);
					const workflowChoice = await context.ui.select("选择工作流模板", [
						AUTOMATIC_WORKFLOW,
						...workflowLabels,
					]);
					if (workflowChoice === undefined) return;
					if (workflowChoice !== AUTOMATIC_WORKFLOW)
						workflowTemplate = workflows[workflowLabels.indexOf(workflowChoice)];
				}

				const runSkillId = await chooseRunSkill(context, service, workflowTemplate);
				if (runSkillId === undefined) return;
				const task = await context.ui.editor("输入任务描述", args.trim());
				if (task === undefined) return;
				if (!task.trim()) {
					context.ui.notify("任务描述不能为空", "error");
					return;
				}
				const requiredMaterialIds = [
					...new Set(
						workflowTemplate?.workflow.nodes.flatMap((node) =>
							node.inputs
								.filter((input) => input.kind === "task_material" && input.required)
								.map((input) => (input.kind === "task_material" ? input.material_id : "")),
						) ?? [],
					),
				].filter(Boolean);
				const materials = await collectMaterials(context, requiredMaterialIds);
				if (materials === undefined) return;
				const requestId = `ipd-command-${Date.now()}`;
				const input: TaskInput = {
					schema_version: 2,
					task_input_id: requestId,
					raw_task: { text: task, source: "user-command:/ipd" },
					materials,
					unresolved_facts: [],
				};
				const receipt = processSpec
					? await service.createRunFromTemplates(requestId, input, runSkillId ?? undefined, {
							processSpecId: processSpec.process_spec_id,
							processSpecVersion: processSpec.version,
							...(workflowTemplate
								? {
										workflowId: workflowTemplate.workflow.workflow_id,
										workflowVersion: workflowTemplate.workflow.workflow_version,
									}
								: {}),
						})
					: await service.createRun(requestId, input, runSkillId ?? undefined);
				const visualization = receipt.visualization ? `\n看板：${receipt.visualization.url}` : "";
				context.ui.notify(`IPD Run ${receipt.runId} 已启动${visualization}`, "info");
			} catch (error) {
				context.ui.notify(`IPD 启动失败：${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}

export type IpdServiceProvider = (context: ExtensionContext, runId?: string) => Promise<IpdService>;

export function registerIpdCreateRunTool(pi: ExtensionAPI, serviceProvider: IpdServiceProvider): void {
	registerIpdCommand(pi, serviceProvider);
	for (const action of ["pause", "resume"] as const) {
		pi.registerTool(
			defineTool({
				name: `ipd_${action}_run`,
				label: `${action === "pause" ? "Pause" : "Resume"} IPD Run`,
				description:
					action === "pause"
						? "Pause a managed execution Run and retain its Session and work. Use only when the user requests a pause."
						: "Resume a paused or blocked execution Run after its original Session, environment, inputs and approvals are verified. Use only when the user requests continuation.",
				parameters: Type.Object({ run_id: NonEmptyStringSchema }, { additionalProperties: false }),
				async execute(_toolCallId, input, _signal, _onUpdate, context) {
					const service = await serviceProvider(context, input.run_id);
					const state = await (action === "pause"
						? service.pauseRun(input.run_id)
						: service.resumeRun(input.run_id));
					const view = {
						run_id: state.runId,
						phase: state.phase,
						status: state.status,
						generation: state.generation,
						interruption: state.interruption,
						cleanup: state.cleanup,
						...runControlView(state),
					};
					return {
						content: [{ type: "text", text: wrapPromptBlock("ipd_run_status", JSON.stringify(view)) }],
						details: view,
					};
				},
			}),
		);
	}
	pi.registerTool(
		defineTool({
			name: "ipd",
			label: "IPD",
			description:
				"Create one governed IPD Run from the user's preserved task. Internal planning and execution continue without outer-agent orchestration.",
			promptSnippet:
				"Use IPD create_run for long tasks that require structured delivery and independent review. Pass request_id, the user's complete verbatim task, and optional skill_name and user-supplied materials.",
			promptGuidelines: [
				"Copy the user's complete task request verbatim into task. Do not summarize, rewrite, expand, interpret, classify, or extract requirements before handing the task to IPD.",
				"skill_name is optional method guidance, not a prerequisite for workflow design. Omit it when no suitable business Skill exists. Do not repeat Skill instructions, files, scripts, inferred requirements, materials, or unresolved facts in task.",
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
					terminate: true,
				};
			},
		}),
	);
	pi.registerTool(
		defineTool({
			name: "ipd_reconcile_external_operation",
			label: "Reconcile IPD External Operation",
			description:
				"Record a verified succeeded/failed outcome for one previously unknown external operation. Use only after the user or an authorized operator has obtained reliable evidence; this never replays the action.",
			parameters: Type.Object(
				{
					run_id: NonEmptyStringSchema,
					operation_id: NonEmptyStringSchema,
					outcome: Type.Union([Type.Literal("succeeded"), Type.Literal("failed")]),
					receipt_ref: Type.Optional(NonEmptyStringSchema),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const state = await (await serviceProvider(context, input.run_id)).reconcileExternalOperation(
					input.run_id,
					input.operation_id,
					input.outcome,
					input.receipt_ref,
				);
				const view = {
					run_id: state.runId,
					status: state.status,
					operation: state.externalOperations.find((operation) => operation.operationId === input.operation_id),
				};
				return {
					content: [
						{ type: "text", text: wrapPromptBlock("ipd_external_operation_reconciled", JSON.stringify(view)) },
					],
					details: view,
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
				const state = await (await serviceProvider(context, input.run_id)).getRun(input.run_id);
				const view = {
					run_id: state.runId,
					phase: state.phase,
					status: state.status,
					revision: state.revision,
					last_event_sequence: state.events.at(-1)?.sequence ?? 0,
					nodes: state.nodes,
					failure: state.failure,
					generation: state.generation,
					interruption: state.interruption,
					work_progress: state.workProgress,
					cleanup: state.cleanup,
					...runControlView(state),
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
			name: "ipd_cancel_run",
			label: "Cancel IPD Run",
			description:
				"Cancel a running, paused or blocked IPD Run, revoke submission eligibility, and attempt bounded cleanup. Use only when the user explicitly requests cancellation.",
			parameters: Type.Object(
				{
					run_id: NonEmptyStringSchema,
					reason: Type.Optional(NonEmptyStringSchema),
				},
				{ additionalProperties: false },
			),
			async execute(_toolCallId, input, _signal, _onUpdate, context) {
				const state = await (await serviceProvider(context, input.run_id)).cancelRun(input.run_id, input.reason);
				const view = {
					run_id: state.runId,
					phase: state.phase,
					status: state.status,
					revision: state.revision,
				};
				return {
					content: [{ type: "text", text: wrapPromptBlock("ipd_run_cancelled", JSON.stringify(view)) }],
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
				const events = await (await serviceProvider(context, input.run_id)).readEvents(
					input.run_id,
					input.after_sequence ?? 0,
				);
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
				const result = await (await serviceProvider(context, input.run_id)).getResult(input.run_id);
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
