export type IpdLedgerErrorCode =
	| "closed"
	| "not_found"
	| "already_exists"
	| "invalid_transition"
	| "idempotency_conflict"
	| "corrupt";

export class IpdLedgerError extends Error {
	readonly code: IpdLedgerErrorCode;

	constructor(code: IpdLedgerErrorCode, message: string) {
		super(message);
		this.name = "IpdLedgerError";
		this.code = code;
	}
}
