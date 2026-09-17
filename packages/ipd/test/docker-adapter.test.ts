import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DockerCli } from "../src/index.ts";

describe("DockerCli", () => {
	const roots: string[] = [];

	afterEach(async () => {
		await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
	});

	it("runs management commands without inheriting the host environment", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-docker-cli-"));
		roots.push(root);
		process.env.IPD_SYNTHETIC_SECRET = "must-not-reach-docker-cli";
		try {
			const docker = new DockerCli({ executable: "/usr/bin/env", dockerConfigDirectory: join(root, "config") });
			const result = await docker.run([]);
			const environment = result.stdout.toString("utf8");
			expect(environment).toContain(`DOCKER_CONFIG=${join(root, "config")}`);
			expect(environment).toContain("PATH=");
			expect(environment).not.toContain("IPD_SYNTHETIC_SECRET");
			expect(environment).not.toContain("must-not-reach-docker-cli");
		} finally {
			delete process.env.IPD_SYNTHETIC_SECRET;
		}
	});

	it("returns a typed timeout instead of retrying an unbounded CLI call", async () => {
		const root = await mkdtemp(join(tmpdir(), "pi-ipd-docker-timeout-"));
		roots.push(root);
		const docker = new DockerCli({ executable: "/bin/sleep", dockerConfigDirectory: join(root, "config") });
		await expect(docker.run(["10"], { timeoutMs: 10 })).rejects.toMatchObject({ code: "process_timeout" });
	});

	it("streams tool output past the capture limit without killing the command", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-stream-output-"));
		roots.push(root);
		const docker = new DockerCli({
			executable: process.execPath,
			dockerConfigDirectory: join(root, "config"),
			maxOutputBytes: 8,
		});
		let output = "";
		const result = await docker.run(["-e", 'process.stdout.write("0123456789")'], {
			streamOutput: true,
			onStdout: (data) => {
				output += data.toString();
			},
		});
		expect(result.exitCode).toBe(0);
		expect(output).toBe("0123456789");
		expect(result.stdout.toString()).toBe("01234567");
	});

	it("can leave command deadlines to the caller without disabling management timeouts", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-command-deadline-"));
		roots.push(root);
		const docker = new DockerCli({
			executable: "/bin/sleep",
			dockerConfigDirectory: join(root, "config"),
			managementTimeoutMs: 10,
		});
		expect((await docker.run(["0.05"], { timeoutMs: 0 })).exitCode).toBe(0);
		await expect(docker.run(["0.05"])).rejects.toMatchObject({ code: "process_timeout" });
	});

	it("does not lose cancellation while preparing the CLI config directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "ipd-cli-cancel-"));
		roots.push(root);
		const controller = new AbortController();
		const docker = new DockerCli({ executable: "/bin/sleep", dockerConfigDirectory: join(root, "config") });
		const operation = docker.run(["10"], { signal: controller.signal, timeoutMs: 0 });
		controller.abort();
		await expect(operation).rejects.toMatchObject({ code: "cancelled" });
	});
});
