import { readFileSync } from "node:fs";
import type { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

export interface IpdMigration {
	id: string;
	sql: string;
}

export function loadIpdMigrations(): IpdMigration[] {
	return [
		{
			id: "001_initial.sql",
			sql: readFileSync(fileURLToPath(new URL("./migrations/001_initial.sql", import.meta.url)), "utf8"),
		},
		{
			id: "002_workflow_revisions.sql",
			sql: readFileSync(fileURLToPath(new URL("./migrations/002_workflow_revisions.sql", import.meta.url)), "utf8"),
		},
	];
}

export function applyIpdMigrations(db: DatabaseSync): void {
	db.exec(`
CREATE TABLE IF NOT EXISTS migrations (
	id TEXT PRIMARY KEY,
	applied_at TEXT NOT NULL
) WITHOUT ROWID;
`);
	const hasMigration = db.prepare("SELECT id FROM migrations WHERE id = ?");
	const insertMigration = db.prepare("INSERT INTO migrations (id, applied_at) VALUES (?, ?)");
	for (const migration of loadIpdMigrations()) {
		if (hasMigration.get(migration.id)) continue;
		db.exec("BEGIN IMMEDIATE");
		try {
			db.exec(migration.sql);
			insertMigration.run(migration.id, new Date().toISOString());
			db.exec("COMMIT");
		} catch (error) {
			db.exec("ROLLBACK");
			throw error;
		}
	}
}
