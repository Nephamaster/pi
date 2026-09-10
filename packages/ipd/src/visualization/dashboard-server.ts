import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { RunState } from "../contracts/runtime.ts";
import { buildDashboardSnapshot, readWorkflowDraft } from "./dashboard-model.ts";
import { renderDashboardPage } from "./dashboard-page.ts";

export interface DashboardRunLink {
	url: string;
	snapshotUrl: string;
	bindHost: string;
	port: number;
	shareHint?: string;
}

export interface IpdDashboardServerOptions {
	projectRoot: string;
	processSpecs: readonly ProcessSpec[];
	getRun(runId: string): Promise<RunState>;
	host?: string;
	port?: number;
}

const RUN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

export class IpdDashboardServer {
	private readonly options: IpdDashboardServerOptions;
	private readonly host: string;
	private readonly port: number;
	private readonly runs = new Set<string>();
	private server?: Server;
	private origin?: string;
	private starting?: Promise<void>;

	constructor(options: IpdDashboardServerOptions) {
		this.options = options;
		this.host = options.host?.trim() || "127.0.0.1";
		this.port = options.port ?? 0;
		if (!Number.isInteger(this.port) || this.port < 0 || this.port > 65_535)
			throw new Error(`Invalid IPD dashboard port: ${this.port}`);
	}

	async registerRun(runId: string): Promise<DashboardRunLink> {
		assertRunId(runId);
		this.runs.add(runId);
		await this.ensureStarted();
		const address = this.server?.address() as AddressInfo | null;
		if (!this.origin || !address) throw new Error("IPD dashboard server did not expose a listening address");
		const encoded = encodeURIComponent(runId);
		const url = `${this.origin}/runs/${encoded}`;
		return {
			url,
			snapshotUrl: `${this.origin}/runs/${encoded}/snapshot.html`,
			bindHost: this.host,
			port: address.port,
			...(isWildcardHost(this.host)
				? {
						shareHint:
							"Dashboard is bound to all interfaces; replace 127.0.0.1 in the URL with this machine's LAN IP for other viewers.",
					}
				: {}),
		};
	}

	async close(): Promise<void> {
		if (!this.server) return;
		const server = this.server;
		this.server = undefined;
		this.origin = undefined;
		this.starting = undefined;
		await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	}

	private async ensureStarted(): Promise<void> {
		if (this.origin) return;
		if (this.starting) return this.starting;
		this.starting = new Promise<void>((resolve, reject) => {
			const server = createServer((request, response) => {
				void this.handle(request.url ?? "/", request.method ?? "GET", response);
			});
			server.once("error", reject);
			server.listen(this.port, this.host, () => {
				server.off("error", reject);
				const address = server.address() as AddressInfo | null;
				if (!address) {
					server.close();
					reject(new Error("IPD dashboard server has no address after listen"));
					return;
				}
				this.server = server;
				this.origin = `http://${displayHost(this.host)}:${address.port}`;
				server.unref();
				resolve();
			});
		});
		try {
			await this.starting;
		} catch (error) {
			this.starting = undefined;
			throw error;
		}
	}

	private async handle(rawUrl: string, method: string, response: ServerResponse): Promise<void> {
		if (method !== "GET") return text(response, 405, "Method not allowed");
		try {
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/healthz") return text(response, 200, "ok");
			if (url.pathname === "/") return html(response, 200, this.rootPage());
			const runPage = /^\/runs\/([^/]+)(?:\/(snapshot\.html))?$/.exec(url.pathname);
			if (runPage) {
				const runId = decodeURIComponent(runPage[1]);
				assertRunId(runId);
				if (runPage[2]) return this.snapshot(response, runId);
				return html(
					response,
					200,
					renderDashboardPage({
						runId,
						liveEndpoint: `/api/runs/${encodeURIComponent(runId)}`,
						snapshotUrl: `/runs/${encodeURIComponent(runId)}/snapshot.html`,
					}),
				);
			}
			const api = /^\/api\/runs\/([^/]+)$/.exec(url.pathname);
			if (api) {
				const runId = decodeURIComponent(api[1]);
				assertRunId(runId);
				return json(response, 200, await this.snapshotData(runId));
			}
			return text(response, 404, "Not found");
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code === "ENOENT" ? 404 : 500;
			return text(response, code, error instanceof Error ? error.message : String(error));
		}
	}

	private async snapshot(response: ServerResponse, runId: string): Promise<void> {
		const snapshot = await this.snapshotData(runId);
		const page = renderDashboardPage({ runId, initialSnapshot: snapshot });
		response.statusCode = 200;
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.setHeader("Content-Disposition", `attachment; filename="ipd-${safeFilename(runId)}-snapshot.html"`);
		commonHeaders(response);
		response.end(page);
	}

	private async snapshotData(runId: string) {
		const [state, draft] = await Promise.all([
			this.options.getRun(runId),
			readWorkflowDraft(this.options.projectRoot, runId),
		]);
		return buildDashboardSnapshot(state, this.options.processSpecs, draft);
	}

	private rootPage(): string {
		const links = [...this.runs]
			.reverse()
			.map((runId) => `<li><a href="/runs/${encodeURIComponent(runId)}">${escapeHtml(runId)}</a></li>`)
			.join("");
		return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPD Runs</title><style>body{font:14px system-ui;background:#0a0d12;color:#e8edf5;padding:28px;max-width:900px;margin:auto}a{color:#8ab4ff}li{margin:10px 0}</style></head><body><h1>IPD Runs</h1>${links ? `<ul>${links}</ul>` : "<p>No Runs registered in this process yet.</p>"}</body></html>`;
	}
}

function displayHost(host: string): string {
	if (isWildcardHost(host)) return "127.0.0.1";
	return host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
}

function isWildcardHost(host: string): boolean {
	return host === "0.0.0.0" || host === "::";
}

function assertRunId(runId: string): void {
	if (!RUN_ID_PATTERN.test(runId)) throw new Error(`Invalid Run ID: ${runId}`);
}

function safeFilename(value: string): string {
	return value.replace(/[^A-Za-z0-9._-]/g, "_");
}

function escapeHtml(value: string): string {
	return value.replace(/[&<>"']/g, (character) => ({
		"&": "&amp;",
		"<": "&lt;",
		">": "&gt;",
		'"': "&quot;",
		"'": "&#39;",
	})[character] ?? character);
}

function commonHeaders(response: ServerResponse): void {
	response.setHeader("Cache-Control", "no-store");
	response.setHeader("X-Content-Type-Options", "nosniff");
	response.setHeader("Referrer-Policy", "no-referrer");
}

function text(response: ServerResponse, status: number, body: string): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "text/plain; charset=utf-8");
	commonHeaders(response);
	response.end(body);
}

function html(response: ServerResponse, status: number, body: string): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	commonHeaders(response);
	response.end(body);
}

function json(response: ServerResponse, status: number, body: unknown): void {
	response.statusCode = status;
	response.setHeader("Content-Type", "application/json; charset=utf-8");
	commonHeaders(response);
	response.end(JSON.stringify(body));
}
