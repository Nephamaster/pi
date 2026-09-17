// HTTP/CONNECT proxy in a network-only sidecar; no task files or host credentials are mounted.
import { createServer, type IncomingHttpHeaders, request } from "node:http";
import { connect, Socket } from "node:net";
import { resolveDestination } from "../egress-policy.ts";

const policy = JSON.parse(process.env.IPD_EGRESS_POLICY ?? "") as { hosts: string[]; denied: string[]; token: string };
const authorization = `Basic ${Buffer.from(`ipd:${policy.token}`).toString("base64")}`;
const server = createServer(async (incoming, response) => {
	try {
		if (incoming.headers["proxy-authorization"] !== authorization) throw new Error("Proxy authentication required");
		const { url, address } = await resolveDestination(incoming.url ?? "", policy.hosts, policy.denied);
		if (url.protocol !== "http:") throw new Error("Use CONNECT for HTTPS");
		const headers: IncomingHttpHeaders = { ...incoming.headers, host: url.host };
		delete headers["proxy-authorization"];
		delete headers["proxy-connection"];
		const upstream = request(
			{
				hostname: address,
				port: 80,
				path: url.pathname + url.search,
				method: incoming.method,
				headers,
				timeout: 60_000,
			},
			(reply) => {
				response.writeHead(reply.statusCode ?? 502, reply.headers);
				reply.pipe(response);
			},
		);
		upstream.on("timeout", () => upstream.destroy());
		upstream.on("error", () => response.destroy());
		incoming.on("aborted", () => upstream.destroy());
		response.on("close", () => upstream.destroy());
		incoming.pipe(upstream);
	} catch {
		response.writeHead(403);
		response.end("Egress policy denied the destination");
	}
});
server.on("connect", async (incoming, socket, head) => {
	try {
		if (incoming.headers["proxy-authorization"] !== authorization) throw new Error("Proxy authentication required");
		const { address } = await resolveDestination(`https://${incoming.url}`, policy.hosts, policy.denied);
		const upstream = connect(443, address);
		upstream.setTimeout(60_000, () => upstream.destroy());
		if (socket instanceof Socket) socket.setTimeout(60_000, () => socket.destroy());
		upstream.on("error", () => socket.destroy());
		socket.on("error", () => upstream.destroy());
		socket.on("close", () => upstream.destroy());
		upstream.on("close", () => socket.destroy());
		upstream.once("connect", () => {
			socket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
			if (head.length) upstream.write(head);
			socket.pipe(upstream);
			upstream.pipe(socket);
		});
	} catch {
		socket.end("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
	}
});
server.maxConnections = 128;
server.headersTimeout = 10_000;
server.requestTimeout = 60_000;
server.listen(8080, "0.0.0.0");
