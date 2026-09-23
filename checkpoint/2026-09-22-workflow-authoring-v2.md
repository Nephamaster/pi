# Workflow Authoring V2 implementation checkpoint

Base: `7431984e2e9d1e22ed4c4bfa5c48d1da280a562b`.
PR: https://github.com/Nephamaster/pi/pull/17
Tested implementation: `9f78348179a4e2267361e0fe9fdff296d5a43299`.
Verification: https://github.com/Nephamaster/pi/actions/runs/35755369668

## Scope and preserved behavior

One partial AuthoringDraft V2 feeds the unchanged WorkflowDefinition V3 and existing Compiler. Fourteen domain tools replace the model-facing whole-node apply operation. Business Run Skills remain optional and environment selection continues to use the configured default resolver. No checklist protocol, multi-member Runtime, nested-run execution, benchmark answer, or dependency-version change is introduced.

Topology and later input edits modify the same records. Production criterion references, explicit review subjects, required candidate reads, and stage internal uses are generated deterministically. Professional criteria, approval sources, correction ownership, permissions, and process coverage remain explicit design decisions.

Updates preserve omitted fields, replace only supplied arrays, and are atomic across each batch. Deletion checks include incoming data, standard, completion and design-authority references. Full compilation remains the only formal Workflow validation. A submitted revision is captured immutably and closes model editing; trusted control can request corrections in the original Designer Session. Cancelled control cannot reopen it.

Read tools provide scoped pages and lossless fragments for large selected records, never a hidden complete Workflow in details. The dashboard has a separate safe presentation projection for incomplete drafts. Display defaults do not become executable configuration.

## Compatibility and operational limits

Frozen templates and Baselines are unchanged. Legacy draft files are preserved until trusted code calls `migrateLegacy(runId, true)` after establishing that the old writer has stopped. Migration validates all fields, retains the original bytes in a content-addressed backup, and rejects ambiguous or unsupported mappings. Legacy operation identities remain queryable and cannot be reused as fresh edit/submission IDs.

The draft-local writer lock serializes manager instances and processes. It deliberately does not steal a timed-out lock: after a crash, an operator must establish that the old writer cannot continue before removing its lock. This is narrower than a full distributed controller-recovery protocol.

The programmatic legacy `apply()` bridge is retained for trusted existing callers and tests, is not a Designer tool, and cannot overwrite a draft after domain edits. No new npm dependency was added.

## Defect discovered and fixed during verification

TypeBox 1.x stores kind/optional metadata in non-enumerable property descriptors. Object-spreading the schema and its fields before `Type.Partial()` lost this metadata, causing otherwise valid employee/output fields to compile into rejecting schemas. The authoring projection now copies complete property descriptors, removes only the draft-level array minimum where clearing is allowed, and preserves the original executable Schema.

Regression tests exercise actual employee and output persistence, strict type/unknown-field rejection, lossless legacy import, and the distinction between an incomplete draft list and the still-required executable list. No Compiler or executable contract was relaxed to make these tests pass.

## Final verification performed

The final read-only Node 24.21.0 / npm 11.19.0 diagnostic checkout completed:

- Biome on all 23 changed IPD TypeScript files, without rewriting them;
- `git diff --check`;
- `tsgo --noEmit`;
- **16 selected IPD test files: 111 passed, 1 skipped, 0 failed**;
- the complete `npm run check` command, including dependency/import/entry-graph checks, bridge/dashboard consistency, shrinkwrap/install-lock validation, TypeScript and browser smoke checks.

The selected tests cover authoring schemas, partial/domain operations, deterministic materialization, unchanged Compiler constraints, provenance and deletion protection, durable receipts/candidate capture, legacy migration, incomplete dashboard views, optional Run Skills/default environment selection, governance records and targeted rework. Native Pi/faux-provider tests build a Workflow through the domain tools, use the existing Compiler, and revise in the same Session with and without a business Skill. File ownership is tested using two actual child processes.

The single skipped case requires a real general-purpose Docker Profile. No paid model, actual benchmark, real Docker execution, or performance A/B result is claimed.

## Baseline failures and dependency boundary

Standard CI is still blocked before these checks by the repository's unchanged package-lock/npm-ci mismatch involving `undici`. Diagnostic installation re-resolved the lock only inside a disposable checkout, then ran `npm ci --ignore-scripts`. The resulting temporary lock SHA-256 was `272507f478bd457cce5f41ebce45c6d14a80d8727918c289b88c35f16163516a`. Required ignored model-catalog JSON was hydrated through the repository's existing script. Neither dependencies, lockfiles nor generated model values were committed.

Separately, `test/contracts.test.ts` produced exactly **1 failed and 1 passed** on both the tested branch and a fresh detached worktree of base `7431984e`. The failing unchanged fixture submits TaskInput/ProcessSelection schema v1 plus removed task-requirement fields to the current v2 contracts. This was reproduced rather than reclassified as a passing regression or worked around by weakening the contracts. The file remains unchanged in this PR.

`npm run check` includes Biome's write mode and reformatted the pre-existing `test/presentation-template.test.ts` in the disposable checkout. Verification confirmed that no PR implementation/test file changed; that unrelated formatting was not committed.

Thus this record establishes passing scoped authoring/regression and repository static checks under the stated diagnostic dependency resolution, **not** an entirely green unmodified-lock CI run or a passing full repository test suite.

## Final cleanup

The branch-scoped diagnostic workflow was temporary and has been removed from the final PR diff. After the tested implementation commit, only this checkpoint and removal of that temporary workflow were changed. Existing CI definitions, runtime contracts, frozen assets and lockfiles remain untouched. The verification run retains the exact commands, implementation identity and baseline comparison.
