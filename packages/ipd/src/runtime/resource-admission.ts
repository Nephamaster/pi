// Bound shared execution capacity and retained responsibility without evicting live Sessions.
import { NodeWorkerError } from "./node-worker.ts";

export interface ResourceLimits {
	active: number;
	activePerRoot: number;
	tools: number;
	toolsPerRoot: number;
	residentPerRoot: number;
	sealedBytesPerRoot: number;
}
interface Reservation {
	key: string;
	rootId: string;
	channel: "execution" | "tool";
	resolve(release: () => void): void;
	reject(error: Error): void;
	signal?: AbortSignal;
	abort(): void;
}

export class ResourceAdmission {
	readonly limits: ResourceLimits;
	private readonly active = new Map<string, { rootId: string; channel: "execution" | "tool" }>();
	private readonly residents = new Map<string, Set<string>>();
	private readonly sealedBytes = new Map<string, number>();
	private readonly pending: Reservation[] = [];

	constructor(limits: Partial<ResourceLimits> = {}) {
		this.limits = {
			active: 8,
			activePerRoot: 4,
			tools: 16,
			toolsPerRoot: 8,
			residentPerRoot: 64,
			sealedBytesPerRoot: 10 * 1024 ** 3,
			...limits,
		};
		for (const [name, value] of Object.entries(this.limits))
			if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid resource limit ${name}`);
	}

	isAvailable(rootId: string, channel: "execution" | "tool" = "execution"): boolean {
		const active = [...this.active.values()].filter((item) => item.channel === channel);
		return (
			active.length < (channel === "execution" ? this.limits.active : this.limits.tools) &&
			active.filter((item) => item.rootId === rootId).length <
				(channel === "execution" ? this.limits.activePerRoot : this.limits.toolsPerRoot)
		);
	}

	acquire(
		rootId: string,
		key: string,
		signal?: AbortSignal,
		channel: "execution" | "tool" = "execution",
	): Promise<() => void> {
		if (signal?.aborted) return Promise.reject(new NodeWorkerError("cancelled", "Resource admission cancelled"));
		if (this.active.has(key) || this.pending.some((item) => item.key === key))
			return Promise.reject(new Error(`Duplicate resource admission ${key}`));
		return new Promise((resolve, reject) => {
			const reservation: Reservation = {
				key,
				rootId,
				channel,
				resolve,
				reject,
				signal,
				abort: () => {
					const index = this.pending.indexOf(reservation);
					if (index >= 0) this.pending.splice(index, 1);
					signal?.removeEventListener("abort", reservation.abort);
					reject(new NodeWorkerError("cancelled", "Resource admission cancelled"));
					this.drain();
				},
			};
			this.pending.push(reservation);
			signal?.addEventListener("abort", reservation.abort, { once: true });
			this.drain();
		});
	}

	retain(rootId: string, participantKey: string): void {
		const residents = this.residents.get(rootId) ?? new Set<string>();
		if (!residents.has(participantKey) && residents.size >= this.limits.residentPerRoot)
			throw new NodeWorkerError(
				"resource_capacity",
				`Root ${rootId} reached its retained participant limit; existing Sessions are preserved`,
			);
		residents.add(participantKey);
		this.residents.set(rootId, residents);
	}

	checkSealedBytes(rootId: string, existingBytes: number, additionalBytes: number): void {
		const total = Math.max(existingBytes, this.sealedBytes.get(rootId) ?? 0) + additionalBytes;
		if (total > this.limits.sealedBytesPerRoot)
			throw new NodeWorkerError(
				"resource_capacity",
				`Root ${rootId} sealed storage would exceed ${this.limits.sealedBytesPerRoot} bytes`,
			);
		this.sealedBytes.set(rootId, total);
	}

	releaseParticipant(rootId: string, participantKey: string): void {
		this.residents.get(rootId)?.delete(participantKey);
	}

	releaseRoot(rootId: string): void {
		if ([...this.active.values()].some((item) => item.rootId === rootId))
			throw new Error("Cannot release residency while root execution is active");
		this.residents.delete(rootId);
		this.sealedBytes.delete(rootId);
	}

	view(rootId: string) {
		return {
			active: [...this.active.values()].filter((item) => item.rootId === rootId && item.channel === "execution")
				.length,
			tools: [...this.active.values()].filter((item) => item.rootId === rootId && item.channel === "tool").length,
			queued: this.pending.filter((item) => item.rootId === rootId).length,
			resident: this.residents.get(rootId)?.size ?? 0,
			sealedBytes: this.sealedBytes.get(rootId) ?? 0,
			limits: this.limits,
		};
	}

	private drain(): void {
		for (let index = 0; index < this.pending.length; ) {
			const reservation = this.pending[index];
			if (!this.isAvailable(reservation.rootId, reservation.channel)) {
				index++;
				continue;
			}
			this.pending.splice(index, 1);
			reservation.signal?.removeEventListener("abort", reservation.abort);
			this.active.set(reservation.key, { rootId: reservation.rootId, channel: reservation.channel });
			let released = false;
			reservation.resolve(() => {
				if (released) return;
				released = true;
				this.active.delete(reservation.key);
				this.drain();
			});
		}
	}
}
