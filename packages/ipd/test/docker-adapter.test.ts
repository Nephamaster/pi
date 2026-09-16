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
});
