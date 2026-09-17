import { stat } from "node:fs/promises";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import type { ProcessSpec } from "../contracts/process-spec.ts";
import type { RunState } from "../contracts/runtime.ts";
import { buildDashboardSnapshot, type DashboardSnapshot, readWorkflowDraft } from "./dashboard-model.ts";
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
	getRunVersion?(runId: string): Promise<string>;
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
	private readonly snapshots = new Map<string, { version: string; snapshot: DashboardSnapshot }>();

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
							"看板已绑定全部网络接口；如需让其他设备访问，请将 URL 中的 127.0.0.1 替换为本机局域网 IP。",
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
				void this.handle(
					request.url ?? "/",
					request.method ?? "GET",
					response,
					request.headers["if-none-match"],
				).catch((error) => {
					if (response.headersSent) response.destroy(error instanceof Error ? error : new Error(String(error)));
					else text(response, 500, error instanceof Error ? error.message : String(error));
				});
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

	private async handle(rawUrl: string, method: string, response: ServerResponse, ifNoneMatch?: string): Promise<void> {
		if (method !== "GET") return text(response, 405, "Method not allowed");
		try {
			const url = new URL(rawUrl, "http://localhost");
			if (url.pathname === "/healthz") return text(response, 200, "ok");
			if (url.pathname === "/") return html(response, 200, this.rootPage());
			const runPage = /^\/runs\/([^/]+)(?:\/(snapshot\.html))?$/.exec(url.pathname);
			if (runPage) {
				const runId = decodeURIComponent(runPage[1]);
				assertRunId(runId);
				if (runPage[2]) {
					await this.snapshot(response, runId);
					return;
				}
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
				const snapshot = await this.snapshotData(runId);
				const etag = `"${snapshot.run.revision}:${snapshot.workflow.draftRevision ?? -1}"`;
				response.setHeader("ETag", etag);
				if (ifNoneMatch === etag) {
					response.statusCode = 304;
					commonHeaders(response);
					response.end();
					return;
				}
				return json(response, 200, snapshot);
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
		const stateVersion = await this.options.getRunVersion?.(runId);
		let draftVersion = "none";
		try {
			const file = await stat(join(this.options.projectRoot, ".pi", "ipd", "runs", runId, "workflow-draft.json"), {
				bigint: true,
			});
			draftVersion = `${file.ino}:${file.mtimeNs}:${file.size}`;
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
		}
		const version = `${stateVersion}/${draftVersion}`;
		const cached = this.snapshots.get(runId);
		if (stateVersion !== undefined && cached?.version === version) return cached.snapshot;
		const [state, draft] = await Promise.all([
			this.options.getRun(runId),
			readWorkflowDraft(this.options.projectRoot, runId),
		]);
		const snapshot = buildDashboardSnapshot(state, this.options.processSpecs, draft);
		if (this.snapshots.size >= 32) this.snapshots.delete(this.snapshots.keys().next().value!);
		this.snapshots.set(runId, { version, snapshot });
		return snapshot;
	}

	private rootPage(): string {
		const links = [...this.runs]
			.reverse()
			.map((runId) => `<li><a href="/runs/${encodeURIComponent(runId)}">${escapeHtml(runId)}</a></li>`)
			.join("");
		return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>IPD 运行列表</title><style>body{font:14px Inter,"PingFang SC","Microsoft YaHei",system-ui;background:#fff;color:#172033;padding:28px;max-width:900px;margin:auto}a{color:#1769e0}li{margin:10px 0}</style></head><body><h1>IPD 运行列表</h1>${links ? `<ul>${links}</ul>` : "<p>当前进程尚未注册 IPD 运行。</p>"}</body></html>`;
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
	return value.replace(
		/[&<>"']/g,
		(character) =>
			({
				"&": "&amp;",
				"<": "&lt;",
				">": "&gt;",
				'"': "&quot;",
				"'": "&#39;",
			})[character] ?? character,
	);
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
