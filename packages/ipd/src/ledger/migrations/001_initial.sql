CREATE TABLE IF NOT EXISTS ipd_runs (
	id TEXT PRIMARY KEY,
	trace_id TEXT NOT NULL,
	status TEXT NOT NULL,
	task TEXT NOT NULL,
	skill_name TEXT NOT NULL,
	skill_hash TEXT NOT NULL,
	global_budget_json TEXT NOT NULL,
	workflow_id TEXT NULL,
	workflow_version TEXT NULL,
	workflow_hash TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	version INTEGER NOT NULL,
	failure_json TEXT NULL,
	create_idempotency_key TEXT NOT NULL UNIQUE,
	create_request_hash TEXT NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS run_sequences (
	run_id TEXT PRIMARY KEY REFERENCES ipd_runs(id) ON DELETE CASCADE,
	next_sequence INTEGER NOT NULL
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS idempotency_keys (
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	key TEXT NOT NULL,
	operation TEXT NOT NULL,
	request_hash TEXT NOT NULL,
	result_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (run_id, key)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS workflow_versions (
	run_id TEXT PRIMARY KEY REFERENCES ipd_runs(id) ON DELETE CASCADE,
	workflow_id TEXT NOT NULL,
	version TEXT NOT NULL,
	hash TEXT NOT NULL,
	source TEXT NOT NULL,
	definition_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (run_id, workflow_id, version, hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS agent_card_snapshots (
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	card_id TEXT NOT NULL,
	version TEXT NOT NULL,
	hash TEXT NOT NULL,
	card_json TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	PRIMARY KEY (run_id, card_id, version, hash)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS node_instances (
	attempt_id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	node_id TEXT NOT NULL,
	attempt_number INTEGER NOT NULL,
	status TEXT NOT NULL,
	agent_card_id TEXT NOT NULL,
	agent_card_version TEXT NOT NULL,
	agent_card_hash TEXT NOT NULL,
	session_id TEXT NULL,
	session_file TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	error_json TEXT NULL,
	UNIQUE (run_id, node_id, attempt_number)
);

CREATE INDEX IF NOT EXISTS idx_node_instances_run_status ON node_instances(run_id, status, node_id);

CREATE TABLE IF NOT EXISTS artifacts (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	node_id TEXT NOT NULL,
	attempt_id TEXT NOT NULL REFERENCES node_instances(attempt_id),
	contract_id TEXT NOT NULL,
	status TEXT NOT NULL,
	manifest_json TEXT NOT NULL,
	manifest_hash TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_artifacts_run_node_status ON artifacts(run_id, node_id, status);

CREATE TABLE IF NOT EXISTS gate_runs (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	node_id TEXT NULL,
	attempt_id TEXT NULL REFERENCES node_instances(attempt_id),
	artifact_id TEXT NULL REFERENCES artifacts(id),
	gate_id TEXT NOT NULL,
	status TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	decision_json TEXT NULL
);

CREATE INDEX IF NOT EXISTS idx_gate_runs_run_status ON gate_runs(run_id, status, gate_id);

CREATE TABLE IF NOT EXISTS reviewer_instances (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	gate_run_id TEXT NOT NULL REFERENCES gate_runs(id) ON DELETE CASCADE,
	agent_card_id TEXT NOT NULL,
	agent_card_version TEXT NOT NULL,
	agent_card_hash TEXT NOT NULL,
	status TEXT NOT NULL,
	session_id TEXT NULL,
	session_file TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL,
	result_json TEXT NULL
);

CREATE TABLE IF NOT EXISTS criterion_results (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	gate_run_id TEXT NOT NULL REFERENCES gate_runs(id) ON DELETE CASCADE,
	criterion_id TEXT NOT NULL,
	kind TEXT NOT NULL,
	result TEXT NOT NULL,
	reviewer_instance_id TEXT NULL REFERENCES reviewer_instances(id),
	evidence_json TEXT NOT NULL,
	rationale TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (gate_run_id, criterion_id, kind, reviewer_instance_id)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_criterion_results_identity
ON criterion_results(gate_run_id, criterion_id, kind, IFNULL(reviewer_instance_id, ''));

CREATE TABLE IF NOT EXISTS decisions (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	type TEXT NOT NULL,
	action TEXT NOT NULL,
	rationale TEXT NOT NULL,
	node_id TEXT NULL,
	gate_run_id TEXT NULL REFERENCES gate_runs(id),
	reviewer_instance_id TEXT NULL REFERENCES reviewer_instances(id),
	evidence_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS escalations (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	node_id TEXT NULL,
	status TEXT NOT NULL,
	target TEXT NOT NULL,
	question TEXT NOT NULL,
	context_json TEXT NOT NULL,
	answer TEXT NULL,
	created_at INTEGER NOT NULL,
	updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS budget_usage (
	id TEXT PRIMARY KEY,
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	category TEXT NOT NULL,
	node_id TEXT NULL,
	attempt_id TEXT NULL REFERENCES node_instances(attempt_id),
	reviewer_instance_id TEXT NULL REFERENCES reviewer_instances(id),
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	cache_read_tokens INTEGER NOT NULL,
	cache_write_tokens INTEGER NOT NULL,
	total_tokens INTEGER NOT NULL,
	cost_usd REAL NOT NULL,
	duration_ms INTEGER NOT NULL,
	details_json TEXT NOT NULL,
	created_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS ipd_events (
	run_id TEXT NOT NULL REFERENCES ipd_runs(id) ON DELETE CASCADE,
	sequence INTEGER NOT NULL,
	event_id TEXT NOT NULL UNIQUE,
	trace_id TEXT NOT NULL,
	type TEXT NOT NULL,
	timestamp INTEGER NOT NULL,
	payload_json TEXT NOT NULL,
	node_id TEXT NULL,
	attempt_id TEXT NULL,
	gate_run_id TEXT NULL,
	reviewer_instance_id TEXT NULL,
	PRIMARY KEY (run_id, sequence)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_ipd_events_trace ON ipd_events(trace_id, timestamp);
