// 解析 Skill 环境需求、注册可信 Profile 并执行确定性的静态匹配。
import Type, { type Static } from "typebox";
import { parse as parseYaml } from "yaml";
import type { LockedSkill } from "../contracts/baseline.ts";
import type { VersionedAssetRef } from "../contracts/primitives.ts";
import { hashJson } from "../ir/hash.ts";
import { validateSchema } from "../ir/validation.ts";
import {
	type DockerExecutionProfile,
	type EnvironmentBinding,
	type EnvironmentCapabilityRequirement,
	EnvironmentError,
	type EnvironmentPaths,
	type EnvironmentPolicy,
	type ExecutionProfile,
	type LegacySrtExecutionProfile,
	type RegisteredExecutionProfile,
	type SkillEnvironmentRequirements,
} from "./contracts.ts";

const IdentifierSchema = Type.String({ minLength: 1, maxLength: 128, pattern: "^[A-Za-z][A-Za-z0-9._-]*$" });
const VersionSchema = Type.String({
	minLength: 1,
	maxLength: 64,
	pattern: "^[0-9]+\\.[0-9]+\\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$",
});
const PositiveIntegerSchema = Type.Integer({ minimum: 1 });
const EnvironmentPathsSchema = Type.Object(
	{
		context: Type.Literal("/ipd/context"),
		skills: Type.Literal("/ipd/skills"),
		inputs: Type.Literal("/ipd/inputs"),
		workspace: Type.Literal("/workspace"),
		scratch: Type.Literal("/scratch"),
		cache: Type.Literal("/cache"),
		home: Type.Literal("/home/agent"),
		temporary: Type.Literal("/tmp"),
	},
	{ additionalProperties: false },
);
const CommonProfileFields = {
	schemaVersion: Type.Literal(1),
	id: IdentifierSchema,
	version: VersionSchema,
	capabilities: Type.Array(
		Type.Object({ id: IdentifierSchema, version: VersionSchema }, { additionalProperties: false }),
		{ uniqueItems: true },
	),
	commands: Type.Array(Type.String({ minLength: 1, pattern: "^[A-Za-z0-9._+-]+$" }), { uniqueItems: true }),
	supportedTools: Type.Array(IdentifierSchema, { uniqueItems: true }),
	environment: Type.Record(Type.String(), Type.String()),
	network: Type.Union([
		Type.Object({ mode: Type.Literal("none") }, { additionalProperties: false }),
		Type.Object(
			{
				mode: Type.Literal("restricted"),
				allowedEndpoints: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
			},
			{ additionalProperties: false },
		),
	]),
	resources: Type.Object(
		{
			memoryBytes: PositiveIntegerSchema,
			cpus: Type.Number({ exclusiveMinimum: 0 }),
			pids: PositiveIntegerSchema,
			logBytes: PositiveIntegerSchema,
		},
		{ additionalProperties: false },
	),
	probes: Type.Array(
		Type.Object(
			{
				id: IdentifierSchema,
				version: VersionSchema,
				command: Type.Array(Type.String({ minLength: 1 }), { minItems: 1 }),
				timeoutSeconds: PositiveIntegerSchema,
			},
			{ additionalProperties: false },
		),
	),
	paths: EnvironmentPathsSchema,
};

export const ExecutionProfileSchema = Type.Union([
	Type.Object(
		{
			...CommonProfileFields,
			provider: Type.Literal("docker"),
			image: Type.Object(
				{
					reference: Type.String({ minLength: 1 }),
					contentId: Type.String({ pattern: "^sha256:[a-f0-9]{64}$" }),
					platform: Type.String({ pattern: "^linux/(?:amd64|arm64)$" }),
				},
				{ additionalProperties: false },
			),
		},
		{ additionalProperties: false },
	),
	Type.Object(
		{
			...CommonProfileFields,
			provider: Type.Literal("legacy-srt"),
		},
		{ additionalProperties: false },
	),
]);

type ParsedExecutionProfile = Static<typeof ExecutionProfileSchema>;

const SkillEnvironmentRequirementsSchema = Type.Object(
	{
		"schema-version": Type.Literal(1),
		capabilities: Type.Optional(
			Type.Array(
				Type.Object(
					{ id: IdentifierSchema, version: Type.Optional(Type.String({ minLength: 1 })) },
					{ additionalProperties: false },
				),
			),
		),
		commands: Type.Optional(Type.Array(Type.String({ minLength: 1, pattern: "^[A-Za-z0-9._+-]+$" }))),
		network: Type.Optional(Type.Union([Type.Literal("none"), Type.Literal("restricted")])),
		probes: Type.Optional(CommonProfileFields.probes),
		"project-probes": Type.Optional(CommonProfileFields.probes),
	},
	{ additionalProperties: false },
);

type ParsedSkillEnvironmentRequirements = Static<typeof SkillEnvironmentRequirementsSchema>;

export const DEFAULT_ENVIRONMENT_PATHS: EnvironmentPaths = {
	context: "/ipd/context",
	skills: "/ipd/skills",
	inputs: "/ipd/inputs",
	workspace: "/workspace",
	scratch: "/scratch",
	cache: "/cache",
	home: "/home/agent",
	temporary: "/tmp",
};

function frontmatter(content: string): Record<string, unknown> | undefined {
	if (!content.startsWith("---")) return undefined;
	const end = content.indexOf("\n---", 3);
	if (end < 0) return undefined;
	const parsed: unknown = parseYaml(content.slice(3, end));
	return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
		? (parsed as Record<string, unknown>)
		: undefined;
}

export function parseSkillEnvironmentRequirements(
	content: string,
	skillName: string,
): SkillEnvironmentRequirements | undefined {
	const raw = frontmatter(content)?.["environment-requirements"];
	if (raw === undefined) return undefined;
	const result = validateSchema<ParsedSkillEnvironmentRequirements>(
		SkillEnvironmentRequirementsSchema,
		raw,
		`Skill:${skillName}`,
	);
	if (!result.ok)
		throw new EnvironmentError(
			"profile_incompatible",
			`Skill ${skillName} has invalid environment-requirements: ${result.diagnostics.map((item) => `${item.path} ${item.message}`).join("; ")}`,
		);
	return {
		schemaVersion: 1,
		capabilities: result.value.capabilities?.map((item) => ({ ...item })) ?? [],
		commands: [...new Set(result.value.commands ?? [])],
		network: result.value.network,
		...(result.value.probes ? { probes: result.value.probes } : {}),
		...(result.value["project-probes"] ? { projectProbes: result.value["project-probes"] } : {}),
	};
}

export function registerExecutionProfiles(values: readonly unknown[]): RegisteredExecutionProfile[] {
	const profiles = values.map((value) => {
		const result = validateSchema<ParsedExecutionProfile>(ExecutionProfileSchema, value, "ExecutionProfile");
		if (!result.ok)
			throw new EnvironmentError(
				"profile_incompatible",
				`Invalid ExecutionProfile: ${result.diagnostics.map((item) => `${item.path} ${item.message}`).join("; ")}`,
			);
		const profile = structuredClone(result.value) as ExecutionProfile;
		const hash = hashJson(profile);
		return {
			profile,
			ref: { id: profile.id, version: profile.version, hash },
			probeHash: hashJson(profile.probes),
		};
	});
	for (const [index, candidate] of profiles.entries()) {
		if (
			profiles.some(
				(other, otherIndex) =>
					otherIndex !== index &&
					other.profile.id === candidate.profile.id &&
					other.profile.version === candidate.profile.version,
			)
		)
			throw new EnvironmentError(
				"profile_incompatible",
				`Duplicate ExecutionProfile ${candidate.profile.id}@${candidate.profile.version}`,
			);
	}
	return profiles.sort((left, right) =>
		`${left.profile.id}@${left.profile.version}`.localeCompare(`${right.profile.id}@${right.profile.version}`),
	);
}

interface NumericVersion {
	major: number;
	minor: number;
	patch: number;
}

function numericVersion(value: string): NumericVersion | undefined {
	const match = /^(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(value);
	if (!match) return undefined;
	return { major: Number(match[1]), minor: Number(match[2]), patch: Number(match[3]) };
}

function compareVersions(left: NumericVersion, right: NumericVersion): number {
	return left.major - right.major || left.minor - right.minor || left.patch - right.patch;
}

function comparatorMatches(actual: NumericVersion, comparator: string): boolean {
	const match = /^(>=|<=|>|<|=|\^|~)?(\d+)\.(\d+)\.(\d+)$/.exec(comparator);
	if (!match) return false;
	const expected = { major: Number(match[2]), minor: Number(match[3]), patch: Number(match[4]) };
	const comparison = compareVersions(actual, expected);
	switch (match[1] ?? "=") {
		case ">=":
			return comparison >= 0;
		case "<=":
			return comparison <= 0;
		case ">":
			return comparison > 0;
		case "<":
			return comparison < 0;
		case "^":
			return comparison >= 0 && actual.major === expected.major;
		case "~":
			return comparison >= 0 && actual.major === expected.major && actual.minor === expected.minor;
		default:
			return comparison === 0;
	}
}

export function matchesVersion(actualValue: string, constraint = "*"): boolean {
	if (constraint.trim() === "*") return true;
	const actual = numericVersion(actualValue);
	if (!actual) return false;
	return constraint
		.trim()
		.split(/\s+/)
		.every((comparator) => comparatorMatches(actual, comparator));
}

export function mergeSkillEnvironmentRequirements(skills: readonly LockedSkill[]): SkillEnvironmentRequirements {
	const capabilities = new Map<string, string | undefined>();
	const commands = new Set<string>();
	let network: SkillEnvironmentRequirements["network"];
	for (const skill of skills) {
		for (const command of skill.requiredCommands ?? []) commands.add(command);
		for (const command of skill.environmentRequirements?.commands ?? []) commands.add(command);
		for (const requirement of skill.environmentRequirements?.capabilities ?? []) {
			const existing = capabilities.get(requirement.id);
			if (existing !== undefined && requirement.version !== undefined && existing !== requirement.version)
				throw new EnvironmentError(
					"profile_incompatible",
					`Skills require conflicting versions of capability ${requirement.id}: ${existing} and ${requirement.version}`,
				);
			capabilities.set(requirement.id, existing ?? requirement.version);
		}
		const requestedNetwork = skill.environmentRequirements?.network;
		if (requestedNetwork === "restricted") network = "restricted";
		else if (requestedNetwork === "none" && network === undefined) network = "none";
	}
	return {
		schemaVersion: 1,
		capabilities: [...capabilities].map(([id, version]) => ({ id, version })),
		commands: [...commands].sort(),
		network,
	};
}

function sameRef(left: VersionedAssetRef, right: VersionedAssetRef): boolean {
	return left.id === right.id && left.version === right.version;
}

function profileMatches(
	registered: RegisteredExecutionProfile,
	requirements: SkillEnvironmentRequirements,
	requiredTools: readonly string[],
): boolean {
	const profile = registered.profile;
	if (requirements.network && profile.network.mode !== requirements.network) return false;
	if (requirements.commands.some((command) => !profile.commands.includes(command))) return false;
	if (requiredTools.some((tool) => !profile.supportedTools.includes(tool))) return false;
	return requirements.capabilities.every((requirement) => {
		const capability = profile.capabilities.find((candidate) => candidate.id === requirement.id);
		return capability !== undefined && matchesVersion(capability.version, requirement.version);
	});
}

export function resolveExecutionProfile(input: {
	profiles: readonly RegisteredExecutionProfile[];
	policy: EnvironmentPolicy;
	explicitRef?: VersionedAssetRef;
	requirements: SkillEnvironmentRequirements;
	requiredTools: readonly string[];
}): RegisteredExecutionProfile {
	const allowed = input.profiles.filter((candidate) =>
		input.policy.allowedProfiles.some((ref) => sameRef(ref, candidate.profile)),
	);
	if (input.explicitRef) {
		const explicitRef = input.explicitRef;
		if (!input.policy.allowedProfiles.some((ref) => sameRef(ref, explicitRef)))
			throw new EnvironmentError(
				"policy_denied",
				`ExecutionProfile is not allowed: ${input.explicitRef.id}@${input.explicitRef.version}`,
			);
		const selected = allowed.find((candidate) => sameRef(candidate.profile, explicitRef));
		if (!selected)
			throw new EnvironmentError(
				"profile_incompatible",
				`ExecutionProfile is not registered: ${input.explicitRef.id}@${input.explicitRef.version}`,
			);
		if (!profileMatches(selected, input.requirements, input.requiredTools))
			throw new EnvironmentError(
				"profile_incompatible",
				`ExecutionProfile ${selected.profile.id}@${selected.profile.version} does not satisfy required capabilities, commands, network, or tools`,
			);
		return selected;
	}
	const candidates = allowed.filter((candidate) => profileMatches(candidate, input.requirements, input.requiredTools));
	if (candidates.length === 0)
		throw new EnvironmentError(
			"profile_incompatible",
			"No allowed ExecutionProfile satisfies the required capabilities, commands, network, and tools",
		);
	if (input.policy.defaultProfile) {
		const selected = candidates.find((candidate) => sameRef(candidate.profile, input.policy.defaultProfile!));
		if (selected) return selected;
	}
	if (candidates.length > 1)
		throw new EnvironmentError(
			"profile_incompatible",
			`Environment selection is ambiguous: ${candidates.map((item) => `${item.profile.id}@${item.profile.version}`).join(", ")}`,
		);
	return candidates[0];
}

export function createEnvironmentBinding(input: {
	nodeId: string;
	participantId: string;
	profile: RegisteredExecutionProfile;
	readPaths: readonly string[];
	writePaths: readonly string[];
	skillHashes: readonly string[];
	policy: EnvironmentPolicy;
}): EnvironmentBinding {
	const profile = input.profile.profile;
	const identity = {
		nodeId: input.nodeId,
		participantId: input.participantId,
		profileRef: input.profile.ref,
		readPaths: [...input.readPaths],
		writePaths: [...input.writePaths],
		skillHashes: [...input.skillHashes].sort(),
		policyHash: hashJson(input.policy),
	};
	return {
		bindingId: hashJson(identity),
		...identity,
		provider: profile.provider,
		image: profile.provider === "docker" ? { ...profile.image } : undefined,
		capabilities: profile.capabilities.map((item) => ({ ...item })),
		commands: [...profile.commands],
		supportedTools: [...profile.supportedTools],
		environment: { ...profile.environment },
		network: structuredClone(profile.network),
		resources: { ...profile.resources },
		probes: profile.probes.map((probe) => ({ ...probe, command: [...probe.command] })),
		paths: { ...profile.paths },
		probeHash: input.profile.probeHash,
	};
}

export function dockerProfile(value: DockerExecutionProfile): DockerExecutionProfile {
	return value;
}

export function legacySrtProfile(value: LegacySrtExecutionProfile): LegacySrtExecutionProfile {
	return value;
}

export function capabilityRequirements(skills: readonly LockedSkill[]): EnvironmentCapabilityRequirement[] {
	return mergeSkillEnvironmentRequirements(skills).capabilities;
}
