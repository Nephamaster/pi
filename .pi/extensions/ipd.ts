// Auto-load IPD with this project's Docker, network and external-read policy.
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { registerDefaultIpdExtension } from "../../packages/ipd/src/tool/default-ipd-extension.ts";

export default function (pi: ExtensionAPI) {
	registerDefaultIpdExtension(pi, {
		environmentMode: "docker",
		allowedEndpoints: ["*"],
		externalReadTools: ["web_search", "fetch_content", "get_search_content", "source_check"],
	});
}
