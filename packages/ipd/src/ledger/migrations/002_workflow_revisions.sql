ALTER TABLE workflow_versions ADD COLUMN revision INTEGER NOT NULL DEFAULT 1;

CREATE TABLE workflow_revision_history (
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	revision INTEGER NOT NULL,
	workflow_id TEXT NOT NULL,
	version TEXT NOT NULL,
	hash TEXT NOT NULL,
	source TEXT NOT NULL,
	definition_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (run_id, revision)
) WITHOUT ROWID;

INSERT INTO workflow_revision_history (
	run_id, revision, workflow_id, version, hash, source, definition_json, created_at
)
SELECT run_id, revision, workflow_id, version, hash, source, definition_json, created_at
FROM workflow_versions;
