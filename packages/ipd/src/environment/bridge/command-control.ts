// Per-command cancellation acknowledgement; never restart the surrounding environment.
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { launchCommand } from "./launch.ts";
import type { CommandLaunch } from "./protocol.ts";

async function groupAlive(pid: number): Promise<boolean> {
	for (const entry of await readdir("/proc")) {
		if (!/^\d+$/.test(entry)) continue;
		try {
			const stat = await readFile(`/proc/${entry}/stat`, "utf8");
			const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
			if (Number(fields[2]) === pid && fields[0] !== "Z" && fields[0] !== "X") return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
	}
	return false;
}

async function stopGroup(pid: number): Promise<void> {
	try {
		process.kill(-pid, "SIGKILL");
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
	}
	const deadline = Date.now() + 3000;
	while (await groupAlive(pid)) {
		if (Date.now() > deadline) throw new Error("Command process group did not stop");
		await delay(20);
	}
}

export async function controlledCommand(scratch: string, id: string, launch?: CommandLaunch): Promise<number> {
	const root = `${scratch}/.ipd-commands`;
	await mkdir(root, { recursive: true });
	const prefix = `${root}/${id}`;
	const complete = async (value: { pid?: number; stopped: boolean }) => {
		await writeFile(`${prefix}.done.tmp`, JSON.stringify(value));
		await rename(`${prefix}.done.tmp`, `${prefix}.done`);
	};
	if (!launch) {
		// A tombstone also cancels a delayed docker exec that has not spawned yet.
		await writeFile(`${prefix}.cancel`, "cancelled", { flag: "wx" }).catch((error: NodeJS.ErrnoException) => {
			if (error.code !== "EEXIST") throw error;
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			try {
				const completed = JSON.parse(await readFile(`${prefix}.done`, "utf8")) as {
					pid?: number;
					stopped?: boolean;
				};
				if (completed.pid && !completed.stopped) await stopGroup(completed.pid);
				return 0;
			} catch (error) {
				if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			}
			await delay(20);
		}
		throw new Error("Command cancellation was not acknowledged");
	}
	let stopping: Promise<void> | undefined;
	const cancelled = async () => {
		try {
			await readFile(`${prefix}.cancel`);
			return true;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
			return false;
		}
	};
	if (await cancelled()) {
		await complete({ stopped: true });
		return 130;
	}
	const launched = await launchCommand(launch, true, true);
	const pid = launched.child.pid!;
	const timer = setInterval(() => {
		void cancelled()
			.then((value) => {
				if (value) stopping ??= stopGroup(pid);
			})
			.catch(() => {
				stopping ??= stopGroup(pid);
			});
		void stopping?.catch(() => {});
	}, 25);
	try {
		const exitCode = await launched.exited;
		const requested = await cancelled();
		if (stopping) await stopping;
		else if (requested) await stopGroup(pid);
		// A normal Bash exit must not silently kill intentionally backgrounded work.
		await complete({ pid, stopped: Boolean(stopping) || requested });
		return exitCode;
	} finally {
		clearInterval(timer);
	}
}
