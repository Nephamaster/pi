// 将受信任模板中的镜像引用解析为当前 Docker Engine 的不可变内容身份。
import { readFile } from "node:fs/promises";
import { EnvironmentError, type RegisteredExecutionProfile } from "./contracts.ts";
import type { DockerCommandRunner } from "./docker-adapter.ts";
import { registerExecutionProfiles } from "./profiles.ts";

const UNRESOLVED_IMAGE_ID = "RESOLVED_BY_TRUSTED_INITIALIZATION";

interface DockerProfileTemplate {
	provider?: unknown;
	image?: { reference?: unknown; contentId?: unknown; platform?: unknown };
	[key: string]: unknown;
}

export async function loadRegisteredDockerProfile(
	templatePath: string,
	docker: DockerCommandRunner,
	signal?: AbortSignal,
	allowMissing = false,
): Promise<RegisteredExecutionProfile> {
	let template: DockerProfileTemplate;
	try {
		template = JSON.parse(await readFile(templatePath, "utf8")) as DockerProfileTemplate;
	} catch (error) {
		throw new EnvironmentError("profile_incompatible", `Cannot read ExecutionProfile template: ${templatePath}`, {
			cause: error,
		});
	}
	if (
		template.provider !== "docker" ||
		typeof template.image?.reference !== "string" ||
		template.image.contentId !== UNRESOLVED_IMAGE_ID
	)
		throw new EnvironmentError(
			"profile_incompatible",
			`Docker ExecutionProfile template must contain an unresolved trusted image reference: ${templatePath}`,
		);
	const inspection = await docker.run(
		["image", "inspect", template.image.reference, "--format", "{{.Id}}|{{.Os}}/{{.Architecture}}"],
		{ signal, acceptedExitCodes: [0, 1] },
	);
	if (inspection.exitCode !== 0) {
		const detail = inspection.stderr.toString("utf8").trim();
		if (allowMissing && /No such image|No such object/i.test(detail))
			throw new MissingDockerProfileError(template.image.reference);
		throw new EnvironmentError(
			"environment_unavailable",
			`Cannot inspect Profile image ${template.image.reference}: ${detail}`,
		);
	}
	const [contentId, platform] = inspection.stdout.toString("utf8").trim().split("|");
	const resolved = structuredClone(template);
	resolved.image = { reference: template.image.reference, contentId, platform };
	return registerExecutionProfiles([resolved])[0];
}

export class MissingDockerProfileError extends EnvironmentError {
	constructor(reference: string) {
		super("profile_incompatible", `ExecutionProfile image is not installed: ${reference}`);
	}
}
