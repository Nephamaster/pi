export function isTerminal(status: string): boolean {
	return status === "succeeded" || status === "failed" || status === "cancelled";
}

/** A timed-out operation remains owned by its caller; this does not claim it stopped. */
export async function bounded<T>(operation: Promise<T>, timeoutMs: number, description: string): Promise<T> {
	let timer: NodeJS.Timeout | undefined;
	try {
		return await Promise.race([
			operation,
			new Promise<never>((_resolve, reject) => {
				timer = setTimeout(() => reject(new Error(`${description} exceeded ${timeoutMs}ms`)), timeoutMs);
			}),
		]);
	} finally {
		if (timer) clearTimeout(timer);
	}
}
