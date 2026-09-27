# ProofRun

An internal project workspace for **understand → execute → test → explain → propose → approve → verify**.

IBM Bob reasons about the source. A separate Docker runner performs execution. The application has no automatic sample connection, external test-app redirect, prewritten project-specific test scenario, or production mock AI mode.

## Start here

You need Node.js **24**, IBM Bob Shell with an inference API key, and a running **Docker Linux engine**. On Windows, Docker Desktop normally uses WSL 2; installing that prerequisite may require administrator access and a restart.

From this project folder:

```powershell
npm run setup:bob
```

The current local copy already has Bob Shell 2.0.5 installed. The installer is needed when using a fresh source download. It obtains the official IBM package, checks its vendor SHA-256 checksum and installs it under `.tools/bob`. There are no frontend or application npm dependencies to install.

Add your key to **`.env` beside `package.json`**:

```dotenv
BOBSHELL_API_KEY=YOUR_REAL_IBM_BOB_INFERENCE_KEY
```

Use `.env.example` as the template if `.env` does not exist. Do not paste a key into the browser or into an uploaded project. `.env`, `.tools` and `.proofrun-data` are ignored by Git and excluded from the distributable archive. Complete IBM's one-time license/account setup as described in [BOB_SETUP.md](BOB_SETUP.md).

Start Docker, then:

```powershell
npm start
```

Open **http://localhost:3000**. If that port is occupied, set `PORT=3003` in `.env` and open **http://localhost:3003** after restarting. The service deliberately listens on loopback. This is a local developer application, not a public, authenticated service for running strangers' repositories.

## Historical detailed implementation guide

The main repair action now uses **Approve & repair all**. Follow the root README and SETUP for the current beginner workflow. This guide retains implementation and earlier measurements.

## Use it

1. Click **Test My App** and choose your source folder. ZIP upload and copying an absolute local source path are available under the collapsed alternative intake section.
2. ProofRun creates a workspace and starts analysis/testing. Follow its stages, current test, logs and captured evidence without leaving the app.
3. After the report is ready, inspect the proposed diffs in **Issues**. The main **Approve & repair all** button applies every pending compatible proposal and retests once. If proposals are missing, **Generate all proposals** asks Bob to prepare them. Inspect the triggering inputs, expected/actual behavior, reproduction, logs, inferred cause and risks in **Issues**. A faulty generated test instead shows **Correct tests & rerun**; it does not authorize an application source patch.
4. **Reject**, **edit**, or **approve** the proposal. Editing creates a new revision and does not change source. Approval must match the displayed revision and unchanged source hashes.
5. ProofRun applies the approved patch to the **managed working copy**, reruns the original tests, checks previously passing flows, and updates **Validation**. Download the report and working-copy ZIP when finished.

If Bob's response fails after your existing suites passed, **Continue practical tests** retries generation for the unchanged source without repeating those verified suites. It still executes every newly generated test. Existing evidence remains available. **Generate all proposals** runs in the background and can be cancelled; a reasoning error preserves the report and never applies a patch.

Your original connected directory is never modified by the application. This prevents background repairs from silently changing your checkout. Applying a downloaded working copy to your own repository remains your decision.

## What actually runs

- Bob explains what the program is for in plain English. A separate Languages section lists detected source languages, file counts and expandable roles; framework and environment details stay collapsed.
- Bob determines setup/build/start/existing-test commands from source and documentation.
- Node runtimes include Node 22 and Node 24. The runner installs pinned pnpm/Yarn from package manifests inside the container, preserves dependency hard links and supplies a Python stdlib alias. Build commands receive at least five minutes and existing suites up to ten; completed commands return immediately. Internal test timeouts and assertions remain unchanged. Setup/existing suites get four CPUs; each independent prepared workflow gets two.
- Runtime images are selected from a server-owned registry, not from unrestricted model-supplied Docker commands.
- Install/build commands, existing suites, generated CLI tests and the application run inside Linux containers.
- HTTP workflows perform real requests with assertions and captured values. Route-derived mutations exercise malformed JSON, nulls, arrays, missing fields, unexpected types and numeric boundaries.
- Browser workflows use headless Chromium through Playwright with declarative navigation, clicks, fills and assertions. They record exceptions, console errors, failed requests, HTTP 5xx responses and PNG screenshots.
- PostgreSQL, MySQL and Redis can be provisioned with disposable databases and synthetic credentials. Production services and credentials are not used.
- Each generated workflow starts with fresh source/dependency/database state. Tests are persisted and hashed so repairs cannot silently change their expectations.
- Installation failures, build failures, command errors, startup failures, timeouts and incomplete tests are reported. An unavailable prerequisite is a **blocked run**, never a passing result.

## Project support

File intake accepts arbitrary extensions, repository layouts and binary assets. Execution is framework-independent within configured **Linux runtime images**: Node/TypeScript, Python, Go, Rust, Java/Maven, .NET, Ruby, PHP, C/C++, and a base Linux image. Additional trusted images, including images with multiple toolchains, can be registered by the operator:

```dotenv
PROOFRUN_RUNTIME_IMAGES={"custom":"your-trusted-image:tag"}
```

This must be a server-side setting. A submitted project or AI response cannot add images or request host mounts. Unsupported platforms, unavailable SDKs, private dependencies, external integrations and required production data must appear as coverage gaps or setup failures.

## Verification

```powershell
npm test
npm run test:docker
npm run test:live
```

`npm test` uses an explicitly labelled deterministic reasoning substitute and **owned local fixtures**, with real HTTP requests and real child processes, to verify orchestration and approval boundaries. That fixture executor is confined to test support; production has no host-execution fallback.

`test:docker` exercises the actual production Docker executor, Python CLI execution, server-secret absence, HTTP testing and browser screenshots. `test:live` exercises the real Bob + Docker detect/repair/approve/retest loop and may consume Bob Coins. Missing prerequisites are explicitly **skipped**, not passed.

Current verification: **40 automated checks passed, 0 skipped**. The **production Docker gate passed**, including Python, HTTP and Chromium; the **real IBM Bob + Docker repair gate passed**, including an approved patch and unchanged regression checks. The latest real checkout analysis completed in **87.6 seconds**, including **16.5 seconds for practical test generation**. Approving its actual Bob diff on a separate verification copy took **32.4 seconds** to rerun all **10 unchanged checks**, with **0 regressions**. The recording workspace remains unapproved. See [TESTING.md](TESTING.md) for measured scope and [DEMO_90_SECONDS.md](DEMO_90_SECONDS.md) for recording instructions.

## Execution speed

Practical test generation starts as soon as Bob's environment plan is validated, overlapping installation, builds and existing tests. The UI shows elapsed reasoning time. Missing command display labels are derived from validated commands; a schema correction uses the previous proposal and exact error rather than resending the full project. Source-matched valid proposals can be reused. Known native numeric and required controls are checked before browser tests execute; missing required values are tested through actual browser validity assertions. Execution constraints and saved regression expectations remain enforced.

For projects without service-side setup, installation and build run once per analysis or retest. A run-local prepared snapshot includes workspace files and temporary/home state; two workers restore independent copies and start separate application instances. Changes made by one test cannot affect another. Database-backed plans retain full fresh setup because install/build commands can initialize service data. A failed snapshot falls back to ordinary fresh setup. Every approved fix creates a new prepared environment; no previous source build is reused. Existing Docker images are reused, and finished resources are removed in batches. Bob still reads the same source context and receives the full failure evidence.

The checkout demonstration's complete retest improved from **149.2 seconds to 29.1–38.8 seconds** with the same source, plan and all **10 unchanged checks**, including real browser tests and regression suites. This excludes new Bob reasoning and first-time image downloads. Prepared workflows now reuse immutable runner files and restore fresh source and temporary files without recreating download proxies and networks. The applications still have no outbound network in these prepared workflows.

Measured on the supplied Express project: seven repeated install/build sequences previously totalled **510.5 seconds** of command time. The optimized run used one sequence (**64.5 seconds**) and completed setup plus six unchanged HTTP workflows in **142.7 seconds**, excluding Bob reasoning time. This is a repository-specific execution measurement, not a promise for every project.

## Limits you should know

- No system can infer every undocumented business requirement or detect every defect. AI expectations are marked as documented or assumed; root-cause claims remain inferences until validated.
- Intake is limited to 2,000 files / 128 MB, with 32 MB per file. Browser and server share these limits; AI source context is bounded separately. Known dependency/generated directories, symlinks and credential filenames are excluded.
- Initial reasoning context is bounded to 140 excerpts / 260 KB. Bob can request up to 24 inventory-listed text files per round, with at most 350 KB of additional context over four rounds. A final response must finish without another retrieval. It cannot read arbitrary host paths. Large/incomplete source does not receive a guessed full-file patch.
- A patch contains up to eight text files, 180 KB per file / 350 KB total. Credential files, dependency caches and test contracts cannot be patched.
- Runs have a 30-minute deadline, commands up to 10 minutes, bounded output, two active jobs, and 50 stored workspaces. Remove old workspace directories with the service stopped when needed.
- Containers use unprivileged users, resource/process limits, read-only roots, bounded temporary filesystems, a 2 GB source/dependency workspace and restricted networking. This is container isolation with a shared kernel, not a hardened VM guarantee for hostile malware. Use a dedicated execution machine for untrusted third-party code.
- Native Windows/macOS apps, mobile devices, hardware-specific software, private infrastructure and unspecified credentials require additional execution adapters or fixtures. External browser requests are blocked; affected integrations are not validated.
- Missing tools and sandbox storage failures are reported as environment issues; they do not receive speculative application patches. Command timeouts remain inconclusive, and remaining suites recover into a fresh session.
- Fresh runs repeat installation/build work; individual prepared workflows reuse a frozen build through independent filesystem copies. Large SDKs and browser images need sufficient Docker memory, disk and download access. Cleanup removes per-run resources; image caches remain.
- The UI reports findings; Markdown exports provide a readable report and the JSON API retains detailed evidence. Screenshots are included when a browser workflow actually ran, not fabricated for API/CLI tests.

## Implementation map

| Area                                                   | Files                                                |
| ------------------------------------------------------ | ---------------------------------------------------- |
| Internal API, CSRF checks, loopback server             | `src/server.ts`                                      |
| Pipeline, persistence, approvals and unchanged retests | `src/qa/engine.ts`                                   |
| Bob integration, key handling, disabled tools          | `src/qa/bob.ts`                                      |
| Validated plans/tests and trusted runtime registry     | `src/qa/contracts.ts`                                |
| Isolated execution, databases, resources and cleanup   | `src/qa/docker.ts`, `src/qa/process.ts`              |
| Source intake, context, paths and ZIP import/export    | `src/qa/projects.ts`, `safety.ts`, `zip.ts`          |
| Diffs, revision approval and source preconditions      | `src/qa/fixes.ts`                                    |
| Evidence and final report                              | `src/qa/reports.ts`                                  |
| HTTP, browser and package egress workers               | `worker/`                                            |
| Workspace UI                                           | `public/workbench.html`, `workbench.js`, stylesheets |

More detail: [ARCHITECTURE.md](ARCHITECTURE.md), [API.md](API.md), [PLAN.md](PLAN.md).

## September 27 reliability audit

The complete automated suite now passes **40 automated checks**. A fresh real Bob + Docker browser journey found two manifestations of the same defect and passed **all 11 unchanged application checks after explicit repair approval**, with zero regressions. Screenshot capture, stale navigation, partial-repair reporting, intake cleanup, cancellation/recovery, concurrent approval and duplicate-server ownership were repaired. See [TESTING.md](TESTING.md) for timings, evidence and scope.

Only one current ProofRun server may own a data directory. If you start a second copy, its error tells you the already-running URL. Use that server, or stop it before restarting; choose a different `PROOFRUN_DATA_DIR` only when you intentionally want an independent workspace store. Port conflicts now produce an actionable message. The audited service currently runs at **http://localhost:3003**.
