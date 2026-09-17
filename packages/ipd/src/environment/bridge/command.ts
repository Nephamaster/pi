import { launchCommand } from "./launch.ts";
import { BRIDGE_VERSION, decodeBridgeRequest } from "./protocol.ts";

// docker exec may detach its client before the cancellation acknowledgement arrives.
process.stdout.on("error", () => {});
process.stderr.on("error", () => {});

try {
	const request = decodeBridgeRequest(process.argv[2] ?? "");
	if (request.operation === "hello")
		process.stdout.write(JSON.stringify({ version: BRIDGE_VERSION, commandCancellation: true }));
	else if (request.operation === "cancel_command") {
		await controlledCommand(request.scratch, request.processId);
		process.stdout.write(JSON.stringify({ stopped: true }));
	} else if (request.operation === "exec")
		process.exitCode =
			request.processId && request.scratch
				? await controlledCommand(request.scratch, request.processId, request.launch)
				: await (await launchCommand(request.launch, true)).exited;
	else throw new Error("Command bridge only accepts exec or hello");
} catch (error) {
	process.stderr.write(
		JSON.stringify({
			bridgeError: {
				code: (error as NodeJS.ErrnoException).code ?? "BRIDGE_ERROR",
				message: error instanceof Error ? error.message : String(error),
			},
		}),
	);
	process.exitCode = 1;
}

import { controlledCommand } from "./command-control.ts";
