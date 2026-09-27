# ProofRun implementation and release plan

## Product scope

Improve practical application testing and repair review through a single internal workspace. Accept varied projects, infer intended behavior from source/docs, run supported Linux environments, capture failures, propose narrow source changes, require approval and preserve tests during validation.

Production uses real Bob reasoning and Docker execution. Projects enter through the internal workspace; a missing dependency or key blocks a run visibly.

## Implemented

- General folder/local-directory/ZIP intake, safe paths, credential exclusions and binary assets.
- Tool-less Bob integration with server-only key configuration and bounded source retrieval.
- Validated install/build/start/test plans and a configurable, trusted runtime-image registry.
- Container resource/time limits, bounded source filesystem, package egress and disposable SQL/Redis services.
- Real HTTP, CLI/existing-suite and browser workers, captured inputs/actions/logs/status/stack/screenshot evidence.
- Source-derived tests plus route-derived adversarial input mutations, with explicit assumptions.
- Persistent issue reports, editable concrete diffs, rejection and approval of exact revisions.
- Working-copy patch application, source preconditions, unchanged retesting and regression tracking.
- Internal dashboard, live status/logs, source/evidence inspection, report and working-copy exports.
- Fixture integration tests, an actual Docker gate, and a real Bob + Docker verification gate.

## Verified locally

Thirty-seven automated checks passed, with zero failures or skips. The production Docker/browser gate and actual IBM Bob + Docker repair gate passed. The latest checkout analysis completed in 87.6 seconds, including 16.5 seconds for practical test generation. It found the documented boundary defect via API and browser without incomplete checks. Its actual Bob patch passed all ten unchanged checks on a separate owned copy in 32.4 seconds, with zero regressions. The prepared recording workspace remains unapproved. See TESTING.md for evidence and scope.

## Remaining environment gates

1. The server key is configured locally. Keep it in `.env` and complete IBM first-use setup yourself if required on another machine.
2. Docker Desktop is running; targeted production HTTP and prepared execution have been validated. Keep Linux containers enabled.
3. Both live gates passed on this machine. Repeat them on a fresh execution host; missing prerequisites must remain explicitly blocked/skipped.
4. Test representative real repositories, including a database-backed app, using disposable fixtures. Measure detected outcomes and coverage, not invented productivity numbers.
5. Record the actual Bob detect → diff → explicit approval → unchanged retest session using DEMO_90_SECONDS.md. Label time compression and the deliberately seeded fixture.
6. For hosting, provision a dedicated execution worker with authentication, durable storage, quotas and a stronger boundary for untrusted users. A free static host cannot run this execution service. Public deployment has not been performed.

## Further coverage

The supplied Understand-Anything repository passed installation/build and all four existing suites. Additional generated practical coverage awaits permission for further selected source excerpts to IBM Bob after automatic approval review blocked that transmission. Passing CI does not establish complete behavioral coverage.

Additional Windows/macOS/mobile/hardware adapters, production-like integration fixtures, large-repository context selection, richer browser test actions and a multi-runtime dependency strategy can extend support. They are separate scope, not claims already validated by this build.

## Completed audit

The latest audit passed 37 automated tests and the strengthened Docker/Chromium screenshot gate. A fresh normal-user journey completed upload, actual Bob analysis and test generation, execution, evidence inspection, proposal editing, approval, unchanged retest and export. Its 11 application checks passed after repair with zero regressions. The source archive was refreshed after fixes. See TESTING.md for measurements and bounded verification scope.
