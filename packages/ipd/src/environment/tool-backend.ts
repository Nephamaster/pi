// 将 Pi 内置文件、搜索和 Bash 工具映射到同一个 EnvironmentLease 文件系统。
import { createHash } from "node:crypto";
import { isAbsolute, join, relative, resolve } from "node:path";
import {
	createBashTool,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	defineTool,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import Type from "typebox";
import { quoteCommand } from "./bridge/protocol.ts";
import type {
	EnvironmentBinding,
	EnvironmentLease,
	EnvironmentProbe,
	EnvironmentProvider,
	EnvironmentSearchMatch,
	ProcessHandle,
	RoundBinding,
} from "./contracts.ts";
import { EnvironmentError } from "./contracts.ts";

export interface EnvironmentToolContext {
	provider: EnvironmentProvider;
	lease: EnvironmentLease;
	round: RoundBinding;
	binding: EnvironmentBinding;
}

export interface EnvironmentToolBackendOptions {
	hostWorkspace: string;
	getContext(): EnvironmentToolContext;
	getExternalOperationRecorder?(): EnvironmentExternalOperationRecorder | undefined;
}

export interface EnvironmentExternalOperationRecorder {
	begin(intent: {
		operationKey: string;
		intentRef: string;
		requestHash: string;
		authorizationRef: string;
		targetRef: string;
	}): Promise<string>;
	settle(operationId: string, outcome: "succeeded" | "failed" | "unknown", receiptRef?: string): Promise<void>;
}

const emptySchema = Type.Object({}, { additionalProperties: false });
const processStartSchema = Type.Object(
	{ command: Type.String({ minLength: 1 }), cwd: Type.Optional(Type.String({ minLength: 1 })) },
	{ additionalProperties: false },
);
const processIdSchema = Type.Object({ process_id: Type.String({ minLength: 1 }) }, { additionalProperties: false });
const processLogsSchema = Type.Object(
	{ process_id: Type.String({ minLength: 1 }), cursor: Type.Optional(Type.Integer({ minimum: 0 })) },
	{ additionalProperties: false },
);

function jsonResult(value: unknown) {
	return { content: [{ type: "text" as const, text: JSON.stringify(value) }], details: undefined };
}

function contentDigest(value: unknown): string {
	return `sha256:${createHash("sha256").update(JSON.stringify(value)).digest("hex")}`;
}

function failedOutcomeIsKnown(error: unknown): boolean {
	if (error instanceof EnvironmentError)
		return ["policy_denied", "profile_incompatible", "path_not_found", "command_failed", "output_limit"].includes(
			error.code,
		);
	return error instanceof Error && /Command exited with code \d+/.test(error.message);
}

async function observeExternalOperation<T>(
	options: Pick<EnvironmentToolBackendOptions, "getContext" | "getExternalOperationRecorder">,
	input: { operationKey: string; intentRef: string; request: unknown },
	execute: () => Promise<T>,
): Promise<T> {
	const current = options.getContext();
	const recorder = options.getExternalOperationRecorder?.();
	if (current.binding.network.mode === "none" || !recorder) return execute();
	const operationId = await recorder.begin({
		operationKey: input.operationKey,
		intentRef: input.intentRef,
		requestHash: contentDigest(input.request),
		authorizationRef: `environment:${current.binding.bindingId}:${current.binding.policyHash}`,
		targetRef: `network:${[...current.binding.network.allowedEndpoints].sort().join(",")}`,
	});
	try {
		const result = await execute();
		await recorder.settle(operationId, "succeeded", contentDigest(result));
		return result;
	} catch (error) {
		const outcome = failedOutcomeIsKnown(error) ? "failed" : "unknown";
		try {
			await recorder.settle(
				operationId,
				outcome,
				contentDigest({ error: error instanceof Error ? error.message : String(error) }),
			);
		} catch (settlementError) {
			throw new EnvironmentError(
				"external_outcome_unknown",
				`External operation ${operationId} finished without a durable outcome receipt`,
				{ cause: new AggregateError([error, settlementError]) },
			);
		}
		if (outcome === "unknown")
			throw new EnvironmentError(
				"external_outcome_unknown",
				`External operation ${operationId} may have affected its remote target`,
				{ cause: error },
			);
		throw error;
	}
}

function createEnvironmentProcessTools(
	getContext: () => EnvironmentToolContext,
	getExternalOperationRecorder?: () => EnvironmentExternalOperationRecorder | undefined,
): ToolDefinition[] {
	const handles = new Map<string, ProcessHandle>();
	return [
		defineTool({
			name: "environment_describe",
			label: "Describe Environment",
			description: "Describe the current controlled execution environment, capabilities, paths, and limits.",
			parameters: emptySchema,
			async execute() {
				const current = getContext();
				return jsonResult(await current.provider.describe(current.lease));
			},
		}),
		defineTool({
			name: "environment_process_start",
			label: "Start Managed Process",
			description:
				"Start a long-running process inside the current environment and return an opaque process handle.",
			parameters: processStartSchema,
			async execute(toolCallId, input, signal) {
				const current = getContext();
				const process = await observeExternalOperation(
					{ getContext, getExternalOperationRecorder },
					{
						operationKey: `process-start:${toolCallId}`,
						intentRef: "environment:managed-process-start",
						request: input,
					},
					() =>
						current.provider.startProcess(
							current.lease,
							current.round,
							{ command: input.command, cwd: input.cwd ?? current.binding.paths.workspace },
							signal,
						),
				);
				handles.set(process.processId, process);
				return jsonResult(process);
			},
		}),
		defineTool({
			name: "environment_process_status",
			label: "Managed Process Status",
			description: "Return the current state of a managed process owned by this environment round.",
			parameters: processIdSchema,
			async execute(_toolCallId, input, signal) {
				const current = getContext();
				const process = handles.get(input.process_id);
				if (!process) throw new Error(`Unknown managed process: ${input.process_id}`);
				const status = await current.provider.processStatus(current.lease, process, signal);
				handles.set(status.processId, status);
				return jsonResult(status);
			},
		}),
		defineTool({
			name: "environment_process_logs",
			label: "Managed Process Logs",
			description: "Read a bounded page of logs from a managed process using an opaque cursor.",
			parameters: processLogsSchema,
			async execute(_toolCallId, input, signal) {
				const current = getContext();
				const process = handles.get(input.process_id);
				if (!process) throw new Error(`Unknown managed process: ${input.process_id}`);
				const logs = await current.provider.processLogs(current.lease, process, input.cursor ?? 0, signal);
				return jsonResult({ text: logs.data.toString("utf8"), cursor: logs.cursor, eof: logs.eof });
			},
		}),
		defineTool({
			name: "environment_process_stop",
			label: "Stop Managed Process",
			description: "Stop a managed process owned by this environment round.",
			parameters: processIdSchema,
			async execute(_toolCallId, input, signal) {
				const current = getContext();
				const process = handles.get(input.process_id);
				if (!process) throw new Error(`Unknown managed process: ${input.process_id}`);
				const stopped = await current.provider.stopProcess(current.lease, process, signal);
				handles.set(stopped.processId, stopped);
				return jsonResult(stopped);
			},
		}),
	];
}

export function createEnvironmentToolDescriptors(): ToolDefinition[] {
	return createEnvironmentProcessTools(() => {
		throw new Error("Environment process tools require an active controlled environment");
	});
}

function contains(root: string, target: string): boolean {
	const value = relative(root, target);
	return value === "" || (!value.startsWith("..") && !isAbsolute(value));
}

function virtualPath(path: string, hostWorkspace: string, environmentWorkspace: string): string {
	const virtual = path.replaceAll("\\", "/");
	if (virtual === environmentWorkspace || virtual.startsWith(`${environmentWorkspace}/`)) return virtual;
	const absolute = resolve(path);
	const workspace = resolve(hostWorkspace);
	if (contains(workspace, absolute)) {
		const child = relative(workspace, absolute).replaceAll("\\", "/");
		return child ? `${environmentWorkspace}/${child}` : environmentWorkspace;
	}
	return virtual;
}

function hostDisplayPath(path: string, hostWorkspace: string, environmentWorkspace: string): string {
	if (path === environmentWorkspace) return resolve(hostWorkspace);
	if (path.startsWith(`${environmentWorkspace}/`))
		return join(resolve(hostWorkspace), path.slice(environmentWorkspace.length + 1));
	return path;
}

function imageMimeType(content: Buffer): string | undefined {
	if (content.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
	if (content[0] === 0xff && content[1] === 0xd8 && content[2] === 0xff) return "image/jpeg";
	if (content.subarray(0, 6).toString("ascii") === "GIF87a" || content.subarray(0, 6).toString("ascii") === "GIF89a")
		return "image/gif";
	if (content.subarray(0, 2).toString("ascii") === "BM") return "image/bmp";
	if (content.subarray(0, 4).toString("ascii") === "RIFF" && content.subarray(8, 12).toString("ascii") === "WEBP")
		return "image/webp";
	return undefined;
}

export function createEnvironmentToolDefinitions(options: EnvironmentToolBackendOptions): ToolDefinition[] {
	const context = () => options.getContext();
	const path = (value: string) => {
		const current = context();
		return virtualPath(value, options.hostWorkspace, current.binding.paths.workspace);
	};
	const displayPath = (value: string) => {
		const current = context();
		return hostDisplayPath(value, options.hostWorkspace, current.binding.paths.workspace);
	};
	const stat = async (value: string, signal?: AbortSignal) => {
		const current = context();
		return current.provider.stat(current.lease, current.round, path(value), signal);
	};
	const read = async (value: string, signal?: AbortSignal) => {
		const current = context();
		return current.provider.readFile(current.lease, current.round, path(value), signal);
	};
	const exists = async (value: string, signal?: AbortSignal) => {
		try {
			await stat(value, signal);
			return true;
		} catch (error) {
			if (error instanceof EnvironmentError && error.code === "path_not_found") return false;
			throw error;
		}
	};

	return [
		defineTool(
			createReadToolDefinition(options.hostWorkspace, {
				operations: {
					resolvePath: (requested, cwd) => (isAbsolute(requested) ? requested : resolve(cwd, requested)),
					readFile: (value) => read(value),
					readFileWithSignal: read,
					access: async (value) => {
						await stat(value);
					},
					accessWithSignal: async (value, signal) => {
						await stat(value, signal);
					},
					detectImageMimeType: async (value) => imageMimeType(await read(value)),
					detectImageMimeTypeWithSignal: async (value, signal) => imageMimeType(await read(value, signal)),
				},
			}),
		),
		defineTool(
			createWriteToolDefinition(options.hostWorkspace, {
				operations: {
					mkdir: async (value) => {
						const current = context();
						await current.provider.makeDirectory(current.lease, current.round, path(value));
					},
					mkdirWithSignal: async (value, signal) => {
						const current = context();
						await current.provider.makeDirectory(current.lease, current.round, path(value), signal);
					},
					writeFile: async (value, content) => {
						const current = context();
						await current.provider.writeFile(current.lease, current.round, path(value), Buffer.from(content));
					},
					writeFileWithSignal: async (value, content, signal) => {
						const current = context();
						await current.provider.writeFile(
							current.lease,
							current.round,
							path(value),
							Buffer.from(content),
							signal,
						);
					},
				},
			}),
		),
		defineTool(
			createEditToolDefinition(options.hostWorkspace, {
				operations: {
					access: async (value) => {
						await stat(value);
					},
					accessWithSignal: async (value, signal) => {
						await stat(value, signal);
					},
					readFile: (value) => read(value),
					readFileWithSignal: read,
					writeFile: async (value, content) => {
						const current = context();
						await current.provider.writeFile(current.lease, current.round, path(value), Buffer.from(content));
					},
					writeFileWithSignal: async (value, content, signal) => {
						const current = context();
						await current.provider.writeFile(
							current.lease,
							current.round,
							path(value),
							Buffer.from(content),
							signal,
						);
					},
				},
			}),
		),
		defineTool(
			createGrepToolDefinition(options.hostWorkspace, {
				operations: {
					isDirectory: async (value) => (await stat(value)).type === "directory",
					isDirectoryWithSignal: async (value, signal) => (await stat(value, signal)).type === "directory",
					readFile: async (value) => (await read(value)).toString("utf8"),
					readFileWithSignal: async (value, signal) => (await read(value, signal)).toString("utf8"),
					search: async (request, signal) => {
						const current = context();
						const matches = await current.provider.search(
							current.lease,
							current.round,
							{
								path: path(request.path),
								pattern: request.pattern,
								glob: request.glob,
								maxResults: request.limit,
								ignoreCase: request.ignoreCase,
								literal: request.literal,
							},
							signal,
						);
						return matches.map((match: EnvironmentSearchMatch) => ({
							filePath: displayPath(match.path),
							lineNumber: match.line ?? 1,
							lineText: match.text,
						}));
					},
				},
			}),
		),
		defineTool(
			createFindToolDefinition(options.hostWorkspace, {
				operations: {
					exists: (value) => exists(value),
					existsWithSignal: exists,
					glob: async (pattern, cwd, findOptions) => {
						const current = context();
						const files = await current.provider.findFiles(current.lease, current.round, {
							path: path(cwd),
							glob: pattern,
							maxResults: findOptions.limit,
						});
						return files.map(displayPath);
					},
					globWithSignal: async (pattern, cwd, findOptions, signal) => {
						const current = context();
						const files = await current.provider.findFiles(
							current.lease,
							current.round,
							{ path: path(cwd), glob: pattern, maxResults: findOptions.limit },
							signal,
						);
						return files.map(displayPath);
					},
				},
			}),
		),
		defineTool(
			createLsToolDefinition(options.hostWorkspace, {
				operations: {
					exists: (value) => exists(value),
					existsWithSignal: exists,
					stat: async (value) => {
						const result = await stat(value);
						return { isDirectory: () => result.type === "directory" };
					},
					statWithSignal: async (value, signal) => {
						const result = await stat(value, signal);
						return { isDirectory: () => result.type === "directory" };
					},
					readdir: async (value) => {
						const current = context();
						return (await current.provider.list(current.lease, current.round, path(value))).map(
							(entry) => entry.name,
						);
					},
					readdirWithSignal: async (value, signal) => {
						const current = context();
						return (await current.provider.list(current.lease, current.round, path(value), signal)).map(
							(entry) => entry.name,
						);
					},
				},
			}),
		),
		observedBashTool(options),
		...createEnvironmentProcessTools(options.getContext, options.getExternalOperationRecorder),
	];
}

function observedBashTool(options: EnvironmentToolBackendOptions) {
	const tool = createBashToolDefinition(options.hostWorkspace, environmentBashOptions(options));
	return defineTool({
		...tool,
		execute: (toolCallId, input, signal, onUpdate, context) =>
			observeExternalOperation(
				options,
				{ operationKey: `bash:${toolCallId}`, intentRef: "environment:bash", request: input },
				() => tool.execute(toolCallId, input, signal, onUpdate, context),
			),
	});
}

function environmentBashOptions(
	options: EnvironmentToolBackendOptions,
): NonNullable<Parameters<typeof createBashToolDefinition>[1]> {
	return {
		exposeSessionEnvironment: false,
		remoteFullOutputPath: (toolCallId) =>
			`${options.getContext().binding.paths.scratch}/logs/${createHash("sha256").update(toolCallId).digest("hex")}.log`,
		operations: {
			exec: async (command, cwd, execution) => {
				const current = options.getContext();
				return current.provider.exec(
					current.lease,
					current.round,
					{
						command,
						cwd: virtualPath(cwd, options.hostWorkspace, current.binding.paths.workspace),
						timeoutSeconds: execution.timeout,
						onData: execution.onData,
						fullOutputPath: execution.fullOutputPath,
					},
					execution.signal,
				);
			},
		},
	};
}

export async function verifyEnvironmentProbes(
	options: EnvironmentToolBackendOptions,
	probes: readonly EnvironmentProbe[],
	signal?: AbortSignal,
): Promise<void> {
	const tool = createBashTool(options.hostWorkspace, environmentBashOptions(options));
	for (const probe of probes) {
		try {
			await tool.execute(
				`preflight:${probe.id}`,
				{ command: quoteCommand(probe.command), timeout: probe.timeoutSeconds },
				signal,
			);
		} catch (error) {
			if (signal?.aborted)
				throw new EnvironmentError("cancelled", "Environment preflight was cancelled", { cause: error });
			if (error instanceof EnvironmentError) throw error;
			throw new EnvironmentError(
				"profile_incompatible",
				`Environment probe failed through the Bash tool: ${probe.id}: ${error instanceof Error ? error.message : String(error)}`,
				{ cause: error },
			);
		}
	}
}
