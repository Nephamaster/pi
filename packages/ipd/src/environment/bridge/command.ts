import { launchCommand } from "./launch.ts";
import { BRIDGE_VERSION, decodeBridgeRequest } from "./protocol.ts";

try {
	const request = decodeBridgeRequest(process.argv[2] ?? "");
	if (request.operation === "hello") process.stdout.write(JSON.stringify({ version: BRIDGE_VERSION }));
	else if (request.operation === "exec") process.exitCode = await (await launchCommand(request.launch, true)).exited;
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
