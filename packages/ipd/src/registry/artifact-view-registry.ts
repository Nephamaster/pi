import type { ArtifactManifestFile, ReviewMaterial, ReviewViewOptions } from "../artifact/review-bundle.ts";
import type { IpdDiagnostic } from "../ir/types.ts";

export interface ArtifactViewProvider {
	id: string;
	mimeTypes: readonly string[];
	create(file: ArtifactManifestFile, absolutePath: string, options: ReviewViewOptions): Promise<ReviewMaterial>;
}

function matchesMimeType(pattern: string, mimeType: string): boolean {
	if (pattern === mimeType) return true;
	return pattern.endsWith("/*") && mimeType.startsWith(pattern.slice(0, -1));
}

export class ArtifactViewRegistry {
	private readonly providers = new Map<string, ArtifactViewProvider>();

	add(provider: ArtifactViewProvider): IpdDiagnostic | undefined {
		if (this.providers.has(provider.id)) {
			return {
				code: "asset_collision",
				path: "/id",
				message: `Artifact View Provider is already registered: ${provider.id}`,
			};
		}
		this.providers.set(provider.id, provider);
		return undefined;
	}

	list(): readonly ArtifactViewProvider[] {
		return Array.from(this.providers.values());
	}

	resolve(mimeType: string): ArtifactViewProvider | undefined {
		return this.list().find((provider) => provider.mimeTypes.some((pattern) => matchesMimeType(pattern, mimeType)));
	}
}
