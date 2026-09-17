// Shared by the host adapter and generated container bridges.
export const BRIDGE_VERSION = 1;

export interface CommandLaunch {
	argv: string[];
	cwd: string;
	environment: Record<string, string>;
	maxLogBytes: number;
	logPath?: string;
}

export type BridgeRequest = { version: 1 } & (
	| { operation: "hello" }
	| { operation: "exec"; launch: CommandLaunch }
	| { operation: "start" | "run"; scratch: string; processId: string; launch: CommandLaunch }
	| { operation: "status" | "stop"; scratch: string; processId: string }
	| { operation: "read" | "write" | "list" | "stat" | "mkdir"; path: string; offset?: number; length?: number }
);

function absolute(value: unknown): value is string {
	return (
		typeof value === "string" && value.startsWith("/") && !value.includes("\0") && !value.split("/").includes("..")
	);
}

export function decodeBridgeRequest(raw: string): BridgeRequest {
	const request: unknown = JSON.parse(raw);
	if (!request || typeof request !== "object") throw new Error("Invalid bridge request");
	const value = request as Record<string, unknown>;
	if (value.version !== BRIDGE_VERSION) throw new Error("Unsupported bridge protocol version");
	if (["start", "run", "status", "stop"].includes(String(value.operation))) {
		if (!absolute(value.scratch) || typeof value.processId !== "string" || !/^[a-f0-9-]{36}$/.test(value.processId))
			throw new Error("Invalid managed process identity");
	} else if (["read", "write", "list", "stat", "mkdir"].includes(String(value.operation))) {
		if (!absolute(value.path)) throw new Error("Invalid bridge file path");
		if (value.offset !== undefined && (!Number.isSafeInteger(value.offset) || Number(value.offset) < 0))
			throw new Error("Invalid file offset");
		if (
			value.length !== undefined &&
			(!Number.isSafeInteger(value.length) || Number(value.length) < 1 || Number(value.length) > 1048576)
		)
			throw new Error("Invalid file page length");
	} else if (value.operation !== "hello" && value.operation !== "exec") throw new Error("Unknown bridge operation");
	if (["exec", "start", "run"].includes(String(value.operation))) {
		const launch = value.launch as CommandLaunch | undefined;
		if (
			!launch ||
			!Array.isArray(launch.argv) ||
			launch.argv.length === 0 ||
			launch.argv.some((arg) => typeof arg !== "string" || arg.includes("\0")) ||
			!launch.argv[0] ||
			!absolute(launch.cwd) ||
			!Number.isInteger(launch.maxLogBytes) ||
			launch.maxLogBytes < 1
		)
			throw new Error("Invalid command launch");
		if (
			!launch.environment ||
			typeof launch.environment !== "object" ||
			Array.isArray(launch.environment) ||
			Object.entries(launch.environment).some(
				([key, val]) => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key) || typeof val !== "string" || val.includes("\0"),
			)
		)
			throw new Error("Invalid command environment");
		if (launch.logPath !== undefined && !absolute(launch.logPath)) throw new Error("Invalid command log path");
	}
	return value as BridgeRequest;
}

export function encodeBridgeRequest(request: BridgeRequest): string {
	const raw = JSON.stringify(request);
	decodeBridgeRequest(raw);
	return raw;
}

export function shellArgv(command: string): string[] {
	return ["/bin/bash", "--noprofile", "--norc", "-c", command];
}

export function quoteCommand(argv: readonly string[]): string {
	return argv.map((arg) => `'${arg.replaceAll("'", "'\\''")}'`).join(" ");
}
