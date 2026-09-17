import { describe, expect, it } from "vitest";
import { publicAddress, resolveDestination } from "../src/environment/egress-policy.ts";

describe("explicit public egress policy", () => {
	it.each([
		"127.0.0.1",
		"10.0.0.1",
		"172.16.0.1",
		"192.168.0.1",
		"169.254.169.254",
		"100.64.0.1",
		"0.0.0.0",
		"224.0.0.1",
		"198.18.0.1",
		"::1",
		"::ffff:8.8.8.8",
	])("denies %s", (address) => expect(publicAddress(address)).toBe(false));
	it("pins allowed hosts and rejects private DNS answers, credentials, host addresses and alternate ports", async () => {
		const lookup = async () => ["93.184.216.34"];
		expect((await resolveDestination("https://example.com/path", ["example.com"], [], lookup)).address).toBe(
			"93.184.216.34",
		);
		await expect(resolveDestination("https://example.com", ["other.com"], [], lookup)).rejects.toThrow("host denied");
		await expect(
			resolveDestination("https://example.com", ["*"], [], async () => ["93.184.216.34", "127.0.0.1"]),
		).rejects.toThrow("Non-public");
		await expect(resolveDestination("https://example.com", ["*"], ["93.184.216.34"], lookup)).rejects.toThrow(
			"Non-public",
		);
		for (const url of [
			"http://2130706433",
			"https://127.0.0.1",
			"https://u:p@example.com",
			"https://example.com:8443",
			"http://localhost",
		])
			await expect(resolveDestination(url, ["*"], [], lookup)).rejects.toThrow();
	});
});
