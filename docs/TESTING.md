# Measured verification

Verified September 27, 2026 on Windows, Node 24.17.0, IBM Bob Shell 2.0.5 and the running Docker Linux engine. The key stays in the server environment.

## Gates and earlier submission evidence

| Gate                      | Result                              | What actually ran                                                                                                                                |
| ------------------------- | ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `npm test`                | **37 passed, 0 failed, 0 skipped**  | Real owned HTTP/CLI processes with deterministic reasoning substitutes for orchestration tests                                                   |
| `npm run test:docker`     | **Passed**                          | Production Docker executor; Python CLI; absent server key; loopback HTTP; headless Chromium and real screenshots                                 |
| `npm run test:live`       | **Passed**                          | Actual IBM Bob and production Docker: analyze, find arithmetic defect, propose concrete patch, approve, rerun unchanged tests, check regressions |
| Checkout browser approval | **10 checks passed, 0 regressions** | Actual Bob-generated API/browser checks; UI approval; managed source patch; production Docker retest                                             |
| Prepared-copy isolation   | **Passed**                          | Two independent Docker copies, workspace and `/tmp` reset, hard links, symlinks and executable permissions preserved                             |

The Docker gate took 54.8 seconds with the browser image available. The live Bob repair gate took 297.2 seconds. These are measured gate durations, not a promise that a new repository can finish in 90 seconds.

Automated checks cover intake/ZIP boundaries, credentials, source and revision approval, real process failures, timeout recovery, actual malformed HTTP inputs, edits/rejection, regression detection, secret masking, toolchain pins, language counts, prose/fenced JSON parsing, bounded Bob retry, operational failure reports, HTTP header/HEAD assertions, grouped repairs, cancellable asynchronous repair generation and continuation guarded by exact source and test hashes. The substitutes exist only in test support; production uses Bob and Docker.

## Verified demonstration

Latest submission run: **87.6 seconds** for actual Bob analysis, production Docker execution and repair proposal; practical test generation took **16.5 seconds**. Ten checks executed: eight passed and two detected the same documented $100 shipping defect through API and browser. There were **zero incomplete checks or reasoning failures**. The actual proposed patch was explicitly approved on a separate owned verification copy: **all 10 original checks passed in 32.4 seconds**, contracts were unchanged and zero regressions were observed. The source workspace remains vulnerable and its proposal unapproved for recording.

Evidence is in the sibling deliverables `proofrun-submission-verification.json`, `proofrun-submission-report.json`, `proofrun-submission-repair-validation.json` and `proofrun-submission-repair-report.json`. Browser inspection confirmed the purpose/languages view, real issue evidence, concrete diff and approval controls. These timings describe this small fixture with available Docker images, not arbitrary repositories.

New regression checks cover absent command display labels, supported browser action aliases, rejection of executable model scripts, compact schema correction and source-matched proposal reuse, numeric control inputs and native required-field validation. Actual Chromium verified the native missing-value case in the submission retest. Earlier invalid model test expectations were corrected before saving the latest contracts; approved source retesting did not alter them.

`examples/shipping-service` is an openly labelled fixture with a deliberately seeded boundary defect. Its checked-in unit suite passes while the documented exactly-$100 free-shipping rule is broken. Actual Bob generated API and browser tests, found the defect and proposed changing `>` to `>=`. The patch was inspected and approved through the real browser UI. The original example remains vulnerable; only its managed working copy was changed.

The same complete retest dropped from **149.2 seconds to 29.1–38.8 seconds** after reducing Docker restoration overhead. The fixed source hash, plan hash and all 10 saved checks were identical. This is a warm-image execution measurement; AI generation is excluded. Evidence is in the sibling deliverables `proofrun-shipping-before.json`, `proofrun-shipping-after.json` and `proofrun-speed-validation.json`.

Browser monitoring also verifies that an expected, handled HTTP 400 is retained as an observation rather than reported as a JavaScript defect. A genuinely missing script still fails. Browser text assertions wait for asynchronous UI updates.

## Supplied Understand-Anything repository

The original source was not changed. A real in-app run completed installation, all builds and all four existing checks: ESLint, core Vitest, root Vitest and Python helper unittest. A later practical-test generation request exceeded the previous eight-file retrieval bound and stopped with preserved evidence, not a fabricated app defect.

The retrieval budget now supports bounded 24-file batches and continuation of unchanged verified source. Automatic approval review required separate authorization before sending additional source beyond previously approved excerpts to IBM Bob. Until that approval arrives, additional generated practical coverage for this repository is **not validated**. Existing CI success must not be presented as exhaustive application coverage.

## Reproduce

Start Docker, configure the server key as described in README, then run:

```powershell
npm test
npm run test:docker
npm run test:live
npm start
```

Upload `examples/shipping-service` through **Test My App**. Inspect the real evidence and concrete diff, approve it, and verify Validation. Model-generated case counts can vary on a fresh analysis; do not claim the saved run's exact count for a different run. Missing prerequisites are skipped by live gates or reported as blocked by the application, never passed.

## Full codebase and judge journey audit — September 27

The latest automated run passed **37 tests, with 0 failures and 0 skips**, in **26.3 seconds**. Nine new regression tests cover malformed request URLs and JSON, binary previews, failed intake cleanup, partial repair reporting, cancellation, interrupted recovery, empty verification, duplicate store ownership, Windows line endings and the approval-to-retest concurrency handoff.

The strengthened production Docker/Chromium gate passed in **50.4 seconds**. It now checks that the screenshot named in a result exists as an actual PNG on the host, and that internal binary transport does not leak into reports. An initial gate attempt caught a missing filesystem import in the new assertion; that import was corrected and the complete gate reran successfully.

A fresh browser journey selected the actual shipping-service folder, created **Judge walkthrough · audit**, and ran real Bob reasoning and Docker tests. Eleven checks ran: **9 passed and 2 found the shipping threshold defect**. Initial analysis/testing/repair proposal took **145.8 seconds**, including **33.2 seconds** of test generation. These are this run's measurements; earlier submission timings above describe separate runs.

The UI was used to inspect the diff, edit and save a new revision, confirm source was still unchanged, approve revision 3, and retest. **All 11 saved checks passed, contracts stayed identical, both findings resolved, and no regressions appeared**. The approved retest took **68.2 seconds** while other audit checks also used Docker. Report and repaired ZIP responses were downloaded through the production API; the ZIP contained the approved code and omitted credentials/dependencies. The original sample remained vulnerable and untouched.

Browser checks verified Back navigation, project switching, source/diff dialogs, screenshot display, report and working-copy download preparation, restart persistence and missing-project handling. The in-app browser did not emit a native download event; archive content was separately fetched and verified from the same production endpoint. Its viewport override did not change this tab's dimensions, so phone layout was reviewed in CSS but is not claimed as a browser-verified result. The desktop layout fit its 1265-pixel viewport without horizontal overflow.

Evidence: `../proofrun-audit.md`, `../proofrun-audit-verification.json`, `../proofrun-audit-before.json`, `../proofrun-audit-after.json`, `../proofrun-audit-before.png`, `../proofrun-audit-after.png` and `../proofrun-audit-repaired-project.zip`.

The final real duplicate-start check initially exposed an unhandled connection-reset error on the ownership socket. The socket now handles peer errors; regression coverage resets four connections, and a repeated actual CLI start was refused while the original service stayed healthy.
