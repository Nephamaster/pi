// 定义受控执行环境的可信配置、冻结绑定、运行租约和 Provider 契约。
import type { LockedAssetRef, VersionedAssetRef } from "../contracts/primitives.ts";

export const ENVIRONMENT_ERROR_CODES = [
	"environment_unavailable",
	"profile_incompatible",
	"policy_denied",
	"dependency_setup_failed",
	"command_failed",
	"process_timeout",
	"environment_lost",
	"path_not_found",
	"cancelled",
	"external_outcome_unknown",
] as const;

export type EnvironmentErrorCode = (typeof ENVIRONMENT_ERROR_CODES)[number];

export class EnvironmentError extends Error {
	readonly code: EnvironmentErrorCode;
	readonly retryable: boolean;

	constructor(code: EnvironmentErrorCode, message: string, options?: ErrorOptions & { retryable?: boolean }) {
		super(message, options);
		this.name = "EnvironmentError";
		this.code = code;
		this.retryable = options?.retryable ?? false;
	}
}

export interface EnvironmentCapability {
	id: string;
	version: string;
}

export interface EnvironmentCapabilityRequirement {
	id: string;
	version?: string;
}

export interface SkillEnvironmentRequirements {
	schemaVersion: 1;
	capabilities: EnvironmentCapabilityRequirement[];
	commands: string[];
	/**
	 * none: no external network is required.
	 * restricted: requires a policy-enforced allowlist (not implemented by the Docker provider yet).
	 * internet: explicitly permits ordinary outbound Internet access from the isolated workspace.
	 */
	network?: "none" | "restricted" | "internet";
	probes?: EnvironmentProbe[];
}

export interface EnvironmentProbe {
	id: string;
	version: string;
	command: string[];
	timeoutSeconds: number;
}

export interface EnvironmentResourceLimits {
	memoryBytes: number;
	cpus: number;
	pids: number;
	logBytes: number;
}

export interface EnvironmentPaths {
	context: "/ipd/context";
	skills: "/ipd/skills";
	inputs: "/ipd/inputs";
	workspace: "/workspace";
	scratch: "/scratch";
	cache: "/cache";
	home: "/home/agent";
	temporary: "/tmp";
}

export interface EnvironmentLayout {
	defaultCwd: string;
	readOnlyRoots: string[];
	writableRoots: string[];
	exportRoot: string;
}

export interface DockerImageIdentity {
	reference: string;
	contentId: string;
	platform: string;
}

interface CommonExecutionProfile {
	schemaVersion: 1;
	id: string;
	version: string;
	capabilities: EnvironmentCapability[];
	commands: string[];
	supportedTools: string[];
	environment: Record<string, string>;
	/**
	 * Network is a trusted Profile policy, not an Agent-controlled Docker argument.
	 * internet is intentionally named as unrestricted outbound access; it must never be described as restricted egress.
	 */
	network:
		| { mode: "none" }
		| { mode: "restricted"; allowedEndpoints: string[] }
		| { mode: "internet" };
	resources: EnvironmentResourceLimits;
	probes: EnvironmentProbe[];
	paths: EnvironmentPaths;
}

export interface DockerExecutionProfile extends CommonExecutionProfile {
	provider: "docker";
	image: DockerImageIdentity;
}

export interface LegacySrtExecutionProfile extends CommonExecutionProfile {
	provider: "legacy-srt";
}

export type ExecutionProfile = DockerExecutionProfile | LegacySrtExecutionProfile;

export interface RegisteredExecutionProfile {
	profile: ExecutionProfile;
	ref: LockedAssetRef;
	probeHash: string;
}

export interface EnvironmentPolicy {
	allowedProfiles: VersionedAssetRef[];
	defaultProfile?: VersionedAssetRef;
}

export interface EnvironmentBinding {
	bindingId: string;
	nodeId: string;
	participantId: string;
	profileRef: LockedAssetRef;
	provider: ExecutionProfile["provider"];
	image?: DockerImageIdentity;
	capabilities: EnvironmentCapability[];
	commands: string[];
	supportedTools: string[];
	environment: Record<string, string>;
	network: ExecutionProfile["network"];
	resources: EnvironmentResourceLimits;
	probes: EnvironmentProbe[];
	paths: EnvironmentPaths;
	readPaths: string[];
	writePaths: string[];
	skillHashes: string[];
	probeHash: string;
	policyHash: string;
}

export type EnvironmentLeaseState =
	| "preparing"
	| "ready"
	| "active"
	| "idle"
	| "quiescing"
	| "exporting"
	| "disposing"
	| "disposed"
	| "lost";

export interface EnvironmentLease {
	leaseId: string;
	runId: string;
	nodeId: string;
	participantId: string;
	provider: ExecutionProfile["provider"];
	providerHandle: string;
	generation: number;
	state: EnvironmentLeaseState;
	image?: DockerImageIdentity;
	createdAt: string;
	disposedAt?: string;
}

export interface EnvironmentInputBinding {
	bindingId: string;
	contentHash: string;
	virtualPath: string;
	sourcePath: string;
}

export type EnvironmentOperation = "read" | "write" | "exec" | "process" | "export";

export interface RoundBinding {
	roundId: string;
	leaseId: string;
	generation: number;
	inputHash: string;
	inputs: EnvironmentInputBinding[];
	allowedOperations: EnvironmentOperation[];
}

export type ProcessState = "running" | "exited" | "stopping" | "stopped" | "lost";

export interface ProcessHandle {
	processId: string;
	leaseId: string;
	roundId: string;
	generation: number;
	state: ProcessState;
	exitCode?: number;
	signal?: string;
	logCursor: number;
	stopResult?: "exited" | "killed" | "already_stopped";
}

export interface EnvironmentExecRequest {
	command: string;
	cwd: string;
	environment?: Record<string, string>;
	timeoutSeconds?: number;
	onData?: (data: Buffer) => void;
	fullOutputPath?: string;
}

export interface EnvironmentExecResult {
	exitCode: number | null;
	signal?: string;
}

export interface EnvironmentDirectoryEntry {
	name: string;
	type: "file" | "directory" | "symlink";
	size: number;
}

export interface EnvironmentFileStat {
	type: "file" | "directory" | "symlink";
	size: number;
}

export interface EnvironmentSearchMatch {
	path: string;
	line?: number;
	text?: string;
}

export interface EnvironmentExportRequest {
	outputs: Array<{ outputId: string; outputRoot: string; logicalPath: string }>;
	destination: string;
}

export interface EnvironmentExportResult {
	root: string;
	files: Array<{ outputId: string; logicalPath: string; stagedPath: string; size: number; sha256: string }>;
}

export type EnvironmentStaticAsset =
	| { assetId: string; contentHash: string; virtualPath: string; sourcePath: string }
	| { assetId: string; contentHash: string; virtualPath: string; content: Buffer };

export interface PreparedEnvironment {
	providerHandle: string;
	image?: DockerImageIdentity;
}

export interface EnvironmentProgressReference {
	nodeId: string;
	participantId: string;
	workspace: string;
	environment: { leaseId: string; generation: number; bindingId: string; identity: string; workspaceHash: string };
}

export interface EnvironmentProvider {
	readonly kind: ExecutionProfile["provider"];
	suspend?(
		lease: EnvironmentLease,
		signal?: AbortSignal,
	): Promise<{ workspace: string; identity: string; workspaceHash: string }>;
	verifyResume?(lease: EnvironmentLease, identity: string, workspaceHash: string, signal?: AbortSignal): Promise<void>;
	prepare(
		request: { leaseId: string; runId: string; binding: EnvironmentBinding },
		signal?: AbortSignal,
	): Promise<PreparedEnvironment>;
	bindRound(lease: EnvironmentLease, binding: RoundBinding, signal?: AbortSignal): Promise<void>;
	bindStaticAssets(
		lease: EnvironmentLease,
		assets: readonly EnvironmentStaticAsset[],
		signal?: AbortSignal,
	): Promise<void>;
	exec(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExecRequest,
		signal?: AbortSignal,
	): Promise<EnvironmentExecResult>;
	readFile(lease: EnvironmentLease, binding: RoundBinding, path: string, signal?: AbortSignal): Promise<Buffer>;
	stat(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		signal?: AbortSignal,
	): Promise<EnvironmentFileStat>;
	makeDirectory(lease: EnvironmentLease, binding: RoundBinding, path: string, signal?: AbortSignal): Promise<void>;
	writeFile(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		content: Buffer,
		signal?: AbortSignal,
	): Promise<void>;
	list(
		lease: EnvironmentLease,
		binding: RoundBinding,
		path: string,
		signal?: AbortSignal,
	): Promise<EnvironmentDirectoryEntry[]>;
	search(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: {
			path: string;
			pattern: string;
			glob?: string;
			maxResults?: number;
			ignoreCase?: boolean;
			literal?: boolean;
		},
		signal?: AbortSignal,
	): Promise<EnvironmentSearchMatch[]>;
	findFiles(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: { path: string; glob: string; maxResults?: number },
		signal?: AbortSignal,
	): Promise<string[]>;
	startProcess(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExecRequest,
		signal?: AbortSignal,
	): Promise<ProcessHandle>;
	processStatus(lease: EnvironmentLease, process: ProcessHandle, signal?: AbortSignal): Promise<ProcessHandle>;
	processLogs(
		lease: EnvironmentLease,
		process: ProcessHandle,
		cursor: number,
		signal?: AbortSignal,
	): Promise<{ data: Buffer; cursor: number; eof: boolean }>;
	stopProcess(lease: EnvironmentLease, process: ProcessHandle, signal?: AbortSignal): Promise<ProcessHandle>;
	exportOutputs(
		lease: EnvironmentLease,
		binding: RoundBinding,
		request: EnvironmentExportRequest,
		signal?: AbortSignal,
	): Promise<EnvironmentExportResult>;
	describe(lease: EnvironmentLease, signal?: AbortSignal): Promise<Record<string, unknown>>;
	dispose(lease: EnvironmentLease, signal?: AbortSignal): Promise<void>;
}

export function throwIfAborted(signal?: AbortSignal): void {
	if (signal?.aborted) throw new EnvironmentError("cancelled", "Environment operation was cancelled");
}

const ENVIRONMENT_VARIABLE_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

export function buildIsolatedEnvironment(
	profileEnvironment: Readonly<Record<string, string>>,
	authorizedEnvironment: Readonly<Record<string, string>> = {},
): Record<string, string> {
	const result: Record<string, string> = {};
	for (const source of [profileEnvironment, authorizedEnvironment]) {
		for (const [name, value] of Object.entries(source)) {
			if (!ENVIRONMENT_VARIABLE_NAME.test(name))
				throw new EnvironmentError("policy_denied", `Invalid environment variable name: ${name}`);
			if (["NODE_OPTIONS", "PYTHONPATH", "LD_PRELOAD", "BASH_ENV", "ENV", "SHELLOPTS", "BASHOPTS"].includes(name))
				throw new EnvironmentError("policy_denied", `Environment variable is not authorized: ${name}`);
			result[name] = value;
		}
	}
	return result;
}
