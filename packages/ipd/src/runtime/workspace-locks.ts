import { normalizeScope, scopeContains } from "../ir/scopes.ts";

export interface WorkspaceLockRequest {
	ownerId: string;
	readScopes: readonly string[];
	writeScopes: readonly string[];
}

interface NormalizedWorkspaceLockRequest {
	ownerId: string;
	readScopes: string[];
	writeScopes: string[];
}

export class WorkspaceLockError extends Error {
	readonly code: "invalid_scope" | "duplicate_owner" | "aborted";

	constructor(code: WorkspaceLockError["code"], message: string) {
		super(message);
		this.name = "WorkspaceLockError";
		this.code = code;
	}
}

export interface WorkspaceLockHandle extends Disposable {
	readonly ownerId: string;
	release(): void;
}

interface PendingRequest {
	request: NormalizedWorkspaceLockRequest;
	resolve(handle: WorkspaceLockHandle): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	onAbort?: () => void;
}

function scopesOverlap(left: string, right: string): boolean {
	return scopeContains(left, right) || scopeContains(right, left);
}

function requestsConflict(left: NormalizedWorkspaceLockRequest, right: NormalizedWorkspaceLockRequest): boolean {
	return (
		left.writeScopes.some((write) => right.writeScopes.some((scope) => scopesOverlap(write, scope))) ||
		left.writeScopes.some((write) => right.readScopes.some((scope) => scopesOverlap(write, scope))) ||
		right.writeScopes.some((write) => left.readScopes.some((scope) => scopesOverlap(write, scope)))
	);
}

function normalizeRequest(request: WorkspaceLockRequest): NormalizedWorkspaceLockRequest {
	if (!request.ownerId.trim()) throw new WorkspaceLockError("invalid_scope", "Workspace Lock ownerId is required");
	const normalize = (values: readonly string[]): string[] => {
		const normalized: string[] = [];
		for (const value of values) {
			const scope = normalizeScope(value);
			if (scope === undefined) {
				throw new WorkspaceLockError("invalid_scope", "Workspace Lock scopes must be relative workspace paths");
			}
			normalized.push(scope);
		}
		return [...new Set(normalized)];
	};
	const readScopes = normalize(request.readScopes);
	const writeScopes = normalize(request.writeScopes);
	if (readScopes.length === 0 && writeScopes.length === 0) {
		throw new WorkspaceLockError("invalid_scope", "Workspace Lock must declare a read or write scope");
	}
	return { ownerId: request.ownerId, readScopes, writeScopes };
}

export class WorkspaceLockManager {
	private readonly active = new Map<string, NormalizedWorkspaceLockRequest>();
	private readonly pending: PendingRequest[] = [];

	acquire(request: WorkspaceLockRequest, signal?: AbortSignal): Promise<WorkspaceLockHandle> {
		const normalized = normalizeRequest(request);
		if (
			this.active.has(normalized.ownerId) ||
			this.pending.some((item) => item.request.ownerId === normalized.ownerId)
		) {
			return Promise.reject(
				new WorkspaceLockError(
					"duplicate_owner",
					`Workspace Lock owner is already active or queued: ${normalized.ownerId}`,
				),
			);
		}
		if (signal?.aborted)
			return Promise.reject(new WorkspaceLockError("aborted", "Workspace Lock request was aborted"));
		if (this.canGrant(normalized) && !this.pending.some((item) => requestsConflict(item.request, normalized))) {
			return Promise.resolve(this.grant(normalized));
		}
		return new Promise<WorkspaceLockHandle>((resolve, reject) => {
			const pending: PendingRequest = { request: normalized, resolve, reject, signal };
			if (signal) {
				pending.onAbort = () => {
					const index = this.pending.indexOf(pending);
					if (index === -1) return;
					this.pending.splice(index, 1);
					reject(new WorkspaceLockError("aborted", "Workspace Lock request was aborted"));
					this.drain();
				};
				signal.addEventListener("abort", pending.onAbort, { once: true });
			}
			this.pending.push(pending);
		});
	}

	getActiveOwners(): string[] {
		return Array.from(this.active.keys()).sort();
	}

	private canGrant(request: NormalizedWorkspaceLockRequest): boolean {
		return Array.from(this.active.values()).every((active) => !requestsConflict(active, request));
	}

	private grant(request: NormalizedWorkspaceLockRequest): WorkspaceLockHandle {
		this.active.set(request.ownerId, request);
		let released = false;
		return {
			ownerId: request.ownerId,
			release: () => {
				if (released) return;
				released = true;
				this.active.delete(request.ownerId);
				this.drain();
			},
			[Symbol.dispose]() {
				this.release();
			},
		};
	}

	private drain(): void {
		let granted = true;
		while (granted) {
			granted = false;
			for (let index = 0; index < this.pending.length; index++) {
				const pending = this.pending[index];
				const blockedByEarlier = this.pending
					.slice(0, index)
					.some((earlier) => requestsConflict(earlier.request, pending.request));
				if (blockedByEarlier || !this.canGrant(pending.request)) continue;
				this.pending.splice(index, 1);
				if (pending.signal && pending.onAbort) pending.signal.removeEventListener("abort", pending.onAbort);
				pending.resolve(this.grant(pending.request));
				granted = true;
				break;
			}
		}
	}
}
