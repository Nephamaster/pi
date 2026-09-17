// Resolve only explicitly authorized public IPv4 destinations and pin the connection address.
import { resolve4 } from "node:dns/promises";
import { isIPv4 } from "node:net";

export function publicAddress(address: string): boolean {
	if (!isIPv4(address)) return false;
	const [a, b, c] = address.split(".").map(Number);
	return !(
		a === 0 ||
		a === 10 ||
		a === 127 ||
		a >= 224 ||
		(a === 100 && b >= 64 && b <= 127) ||
		(a === 169 && b === 254) ||
		(a === 172 && b >= 16 && b <= 31) ||
		(a === 192 && [0, 168].includes(b)) ||
		(a === 192 && b === 88 && c === 99) ||
		(a === 198 && [18, 19].includes(b)) ||
		(a === 198 && b === 51 && c === 100) ||
		(a === 203 && b === 0 && c === 113)
	);
}

export async function resolveDestination(
	raw: string,
	hosts: readonly string[],
	denied: readonly string[],
	lookup: (hostname: string) => Promise<string[]> = resolve4,
) {
	const url = new URL(raw);
	if (
		!["http:", "https:"].includes(url.protocol) ||
		url.username ||
		url.password ||
		(url.port && url.port !== (url.protocol === "https:" ? "443" : "80"))
	)
		throw new Error("Destination protocol or port denied");
	const hostname = url.hostname.toLowerCase();
	if (
		!hosts.some(
			(host) => host === "*" || hostname === host || (host.startsWith("*.") && hostname.endsWith(host.slice(1))),
		)
	)
		throw new Error("Destination host denied");
	if (!hostname.includes(".") || hostname.endsWith(".localhost") || hostname.endsWith(".local"))
		throw new Error("Local destination denied");
	const addresses = isIPv4(hostname) ? [hostname] : await lookup(hostname);
	if (!addresses.length || addresses.some((address) => !publicAddress(address) || denied.includes(address)))
		throw new Error("Non-public destination denied");
	return { url, address: addresses[0] };
}
