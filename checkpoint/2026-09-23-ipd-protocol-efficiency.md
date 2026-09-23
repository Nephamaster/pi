# IPD protocol efficiency: sources, evidence and local correction

Date: 2026-09-23
Base: `e3a438af4cbd5d662ebe5471484f2f98f8d88deb`
Tested implementation: `7c6b01e98bb9bc4f2a69a5fae41949898b7f104c`
Branch: `fix/ipd-protocol-efficiency`

## Scope and motivation

The supplied Run `20260923T012433633Z` exposed repeated ProcessSpec source-reference guesses, misrouted authoring diagnostics, invalid evidence ownership/path formats, and repeated generation of otherwise unchanged long submission/review payloads. This change addresses those generic code and method boundaries. It does not rewrite that task, change its workflow topology, ProcessSpec, template, AgentCards, quality criteria, model route, budget or permissions. No benchmark solution, private Run files or task-specific logic is included.

## Implemented behavior

### Authoring sources and diagnostics

- `processSources()` exposes exact selected ProcessSpec activity, deliverable, review, nested criterion and rule IDs and their original descriptions. Authoring and provenance validation share that extraction.
- `workflow_draft_read` with `view: process, kind: sources` returns bounded source entries. The selected entry ID is the source reference; a ProcessSpec name/version or selection ID is not a substitute.
- `workflow_draft_governance.requirements.from_process` accepts a requirement ID, exact `source_id` and explicit strength. Code copies the selected source ID/quote and records process authority; it does not invent criteria, node responsibility, approval or coverage. Missing/ambiguous sources are rejected.
- Sparse requirement patches edit an existing record without resending its description, quote and unchanged siblings. The draft's revision, atomic batch and request replay checks remain in force.
- Provenance errors identify the exact field and usable source guidance. Authoring source maps preserve field suffixes and support named node paths; review/remediation diagnostics and coverage errors route to their actual editors.

### Submission references and local correction

- `submission_context` is a read-only, on-demand tool. Review reference pages contain only exact criterion-permitted, currently bound manifest tuples. They exclude unbound outputs and host sealed-root paths; listing a reference proves neither inspection nor quality.
- Producer context distinguishes declared candidate file paths from an immutable manifest. Cheap preflight reports multiple malformed references and their precise payload paths; existence, content, output ownership and hash checks still belong to normal Runtime processing.
- `SubmissionCapture` can retain a rejected payload within the same native Session and compatible work scope. Same-round Runtime protocol feedback may reuse the captured base; a new business round, changed input binding/contract or unrelated new dispatch resets it.
- `correct_submission` accepts an exact `base_hash` and 1..32 ordered `set`/`remove` JSON Pointer edits. It clones the base, rejects unsafe/prototype pointers and invalid indices, validates the complete result against the original submit Schema, and calls the original submission tool. It neither edits files nor changes workflow/state/standards.
- Full prevalidation, single-candidate capture, tool termination, sealing, mechanical checks, semantic review and final adoption remain in force. A patch is not approval. Bad patches do not partially mutate the stored base.
- Review validation collects independent protocol defects with locations rather than stopping at the first one. Missing/duplicate criteria still stop downstream ownership checks when interpretation would be ambiguous. Mandatory evidence, criterion coverage, composite subjects, legal rework ownership and decision semantics remain enforced.
- Runtime file-evidence diagnostics provide legitimate reference examples and separate file identity from page/section `locator`; they do not accept unrelated background evidence by relabeling it.

### Generic method updates

Workflow-design references explain exact source lookup and local changes. Execution/review prompts explain the two new control tools, exact file references, criterion-local `finding_resolutions`, and preserving unchanged substantive material rather than regenerating it in repeated metadata/rationales. Complete deliverables, distinct observations, limitations and real evidence remain required. This is not automatic semantic compression and does not alter concrete task decomposition.

## Boundaries and known limitations

1. The correction cache is an in-memory convenience owned by the existing Session binding, not a new authoritative submission store or crash-recovery protocol. If unavailable, submit the full candidate normally.
2. Calls rejected by the native Tool Schema before the submit tool executes may never create a retained correction base. Do not promise partial repair for every malformed tool call.
3. Correction field reads are bounded; overlarge fields return narrower-field guidance, not an automatically summarized replacement. Whole-payload reads are not returned by default.
4. Reference discovery and producer preflight do not prove file existence, inspection or business truth. Preserved-output references still require Runtime verification.
5. No standards are automatically weakened, PASS fabricated, evidence owner changed, Findings closed, or independent branches restarted. Same-round correction is not quality rework.
6. Reload the package/prompts for new runs to use the new tools. Existing frozen workflows and live Session tool sets are not silently rewritten.

## Actual verification

Final independent verification checked out the exact committed implementation above (not an uncommitted payload):

- https://github.com/Nephamaster/pi/actions/runs/35839198415
- Job `107109929791`; Ubuntu 24.04; Node `24.20.0`; npm `11.19.0`.
- Complete `npm run check`: passed in the diagnostic dependency environment described below, including TypeScript, import/dependency/entry-graph checks, generated bridge/dashboard consistency and browser smoke.
- Selected IPD suite: **20 files, 142 tests passed, 0 failed, 0 skipped**.
- Final diff check confirmed the tested IPD production, prompt, Skill and changed test files were not rewritten by the check command.

Earlier narrower verification: https://github.com/Nephamaster/pi/actions/runs/35838569886 (12 files, 98 tests passed). This is not an additional 98 unique cases; the final suite includes that coverage.

The final suite comprised:

```text
protocol-efficiency.test.ts
authoring-source-efficiency.test.ts
submission-correction-session.test.ts
structured-submissions.test.ts
pi-node-worker.test.ts
pi-control-roles.test.ts
workflow-authoring.test.ts
workflow-authoring-manager.test.ts
workflow-authoring-invariants.test.ts
workflow-authoring-schema.test.ts
workflow-authoring-dashboard.test.ts
workflow-draft-storage.test.ts
compiler.test.ts
review-validation.test.ts
review-evidence-store.test.ts
submission-store.test.ts
submission-diagnostics.test.ts
governance-kernel.test.ts
round-invalidation.test.ts
runtime-rework.test.ts
```

Run from `packages/ipd` using `node ../../node_modules/vitest/dist/cli.js --run` and the corresponding `test/` paths. The native-Session regression uses a faux provider to exercise full-submit rejection, field-only correction, another Runtime protocol correction in the same Session, and refusal to reuse the old base in a new quality round. Synthetic patch tests verify unchanged long content is preserved and the correction arguments are much smaller; they do not measure actual model latency or token savings.

Initial verification found a test helper typed as `Record<string, unknown>` where `fauxToolCall` needs its JSON argument type, and an older assertion expecting an object-only diagnostic path. The helper now derives its type from the real function; the assertion expects the deliberately retained `.path_prefix`. Production validation was not relaxed to make those tests pass.

### Dependency baseline / non-green-default-CI caveat

The repository's unchanged lockfile required a temporary resolution for diagnostic installation. Only the disposable CI checkout ran:

```sh
npm install --package-lock-only --ignore-scripts
npm ci --ignore-scripts
npm run hydrate:model-data
```

Original lock SHA-256: `6acd1e39fd20ae02a40bd5144ab6cc205abdac439c9e729d188433c9a5d658d9`.
Temporary diagnostic lock SHA-256: `fa4b869191ed4c5614ed092d9b9b034d65ca200f6c7e5dea0e9515c3e9fa3886`.

No package manifest, lockfile, model catalog or standard CI configuration change is included. The root check reformatted an unrelated existing `presentation-template.test.ts` only in the disposable checkout; that change was not committed. These results are not a claim that unmodified default `npm ci` or every repository test is green.

Temporary source-transfer payloads and the diagnostic workflow were removed from the final diff. After the tested implementation commit, only diagnostic cleanup and this checkpoint changed; production/test behavior is the tested version.

## Not run / no performance claim

No full-repository test suite, real Docker execution, paid-model session, new PPT task, WorkBuddy scoring or before/after benchmark was run. The known slow-run observations motivated the generic fixes; this PR does not claim to have removed all four hours or quantify a measured speedup. The next real Run should separately report authoring source errors, rejected submission counts, correction payload size, model response time/output usage and independent quality results.
