# Workflow Authoring V2 implementation checkpoint

Base: `7431984e2e9d1e22ed4c4bfa5c48d1da280a562b`.
PR: https://github.com/Nephamaster/pi/pull/17

## Scope and preserved behavior

One partial AuthoringDraft V2 now feeds the unchanged WorkflowDefinition V3 and existing Compiler. Fourteen domain tools replace the model-facing whole-node apply operation. Business Run Skills remain optional and environment selection continues to use the configured default resolver. No checklist protocol, multi-member Runtime, nested-run execution, benchmark answer, or dependency-version change is introduced.

Topology and later input edits modify the same records. Production criterion references, explicit review subjects, required candidate reads, and stage internal uses are generated deterministically. Professional criteria, approval sources, correction ownership, permissions, and process coverage remain explicit design decisions.

Updates preserve omitted fields, replace only supplied arrays, and are atomic across each batch. Deletion checks include incoming data, standard, completion and design-authority references. Full compilation remains the only formal Workflow validation. A submitted revision is captured immutably and closes model editing; trusted control can request corrections in the original Designer Session. Cancelled control cannot reopen it.

Read tools provide scoped pages and lossless fragments for large selected records, never a hidden complete Workflow in details. The dashboard has a separate safe presentation projection for incomplete drafts. Display defaults do not become executable configuration.

## Compatibility and operational limits

Frozen templates and Baselines are unchanged. Legacy draft files are preserved until trusted code calls `migrateLegacy(runId, true)` after establishing that the old writer has stopped. Migration validates all fields, retains the original bytes in a content-addressed backup, and rejects ambiguous or unsupported mappings. Legacy operation identities remain queryable and cannot be reused as fresh edit/submission IDs.

The draft-local writer lock serializes manager instances and processes. It deliberately does not steal a timed-out lock: after a crash, an operator must establish that the old writer cannot continue before removing its lock. This is narrower than a full distributed controller-recovery protocol.

The programmatic legacy `apply()` bridge is retained for trusted existing callers and tests, is not a Designer tool, and cannot overwrite a draft after domain edits. No new npm dependency was added.

## Verification performed

On the implementation before the final provenance/legacy-view regressions, the Node 24 remote diagnostic completed:

- Biome on the changed IPD TypeScript files;
- `tsgo --noEmit`;
- 58 passing tests across domain authoring, durable manager/Compiler integration, incomplete-draft presentation, file ownership, existing draft behavior, and native Pi/faux-provider control Sessions.

The filesystem suite includes two actual child processes contending for the same writer lock. Native tests cover both optional-business-Skill modes, same-Session corrections, and construction through the domain tools followed by the existing Compiler. No external paid model is used.

This was a diagnostic checkout using an ephemeral re-resolved package-lock. Standard CI failed earlier at `npm ci` with an `undici` lock mismatch; no lockfile repair was committed. Therefore these results do not establish green standard locked CI or clean-install verification. Full repository tests, Docker execution, real model design quality and benchmark performance were not measured.

A final diagnostic run additionally checks design-decision deletion protection and read-only access to retained legacy operation receipts. Its outcome must be recorded before final review. The temporary diagnostic workflow must be removed from the final PR diff; the standard workflows and lockfiles must remain unchanged.
