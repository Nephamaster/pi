import { describe, expect, it } from "vitest";
import type { DockerCommandRunner } from "../src/environment/docker-adapter.ts";
import { loadRegisteredDockerProfile, MissingDockerProfileError } from "../src/environment/profile-loader.ts";

describe("optional Profile availability", () => {
	const template = new URL("../environments/office-pptx/profile.template.json", import.meta.url).pathname;
	it("distinguishes an uninstalled optional image from a broken Docker Engine", async () => {
		const runner = (message: string): DockerCommandRunner => ({
			run: async () => ({ exitCode: 1, stdout: Buffer.alloc(0), stderr: Buffer.from(message) }),
		});
		await expect(
			loadRegisteredDockerProfile(template, runner("Error: No such image: office"), undefined, true),
		).rejects.toBeInstanceOf(MissingDockerProfileError);
		await expect(
			loadRegisteredDockerProfile(template, runner("Cannot connect to the Docker daemon"), undefined, true),
		).rejects.toMatchObject({ code: "environment_unavailable" });
	});
});
