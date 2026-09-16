// IPD selects policy fields; Pi owns their defaults, execution and persistence.
import { SettingsManager } from "@earendil-works/pi-coding-agent";

type PiSettings = ReturnType<SettingsManager["getGlobalSettings"]>;

export type IpdSessionSettings = Pick<PiSettings, "retry" | "compaction" | "httpIdleTimeoutMs" | "images">;

/** Never carry resource loading, shell commands, credentials or project trust into a node. */
export function projectIpdSessionSettings(settings: PiSettings = {}): IpdSessionSettings {
	const { retry, compaction, httpIdleTimeoutMs, images } = settings;
	return structuredClone({
		...(retry === undefined ? {} : { retry }),
		...(compaction === undefined ? {} : { compaction }),
		...(httpIdleTimeoutMs === undefined ? {} : { httpIdleTimeoutMs }),
		...(images === undefined ? {} : { images }),
	});
}

export function loadIpdSessionSettings(cwd: string, agentDir: string): IpdSessionSettings {
	const settings = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const errors = settings.drainErrors();
	if (errors.length > 0)
		throw new AggregateError(
			errors.map((item) => item.error),
			"Cannot load trusted Pi session settings",
		);
	return projectIpdSessionSettings(settings.getGlobalSettings());
}
