# ProofRun: project description

## Problem

A green unit-test suite can still miss a real user journey. Developers must manually learn an unfamiliar repository, reproduce its setup, decide what behavior matters, create tests, investigate failures and verify repairs. AI-generated code increases the need for runtime evidence, especially around boundary values, state changes and malformed inputs.

## Solution and users

ProofRun brings this testing and debugging workflow into one local web workspace for individual developers, small engineering teams and reviewers preparing a release. IBM Bob interprets bounded source context and proposes an environment plan and tests. A separate Docker execution layer runs the software and captures observations. Bob uses that evidence to explain failures and propose code changes. Developers retain approval of every applied change.

## Interaction

1. **Provide source:** choose a folder, upload a ZIP, or copy an absolute local folder into a managed workspace.
2. **Understand:** Bob explains the application's purpose and user actions. Language detection and roles appear separately.
3. **Prepare:** validate the model's structured environment plan, select a trusted Linux runtime, install dependencies, build and run existing suites.
4. **Test:** execute generated HTTP sequences, declarative Chromium browser actions and CLI commands. Exercise normal behavior, boundaries and safe malformed-input mutations where applicable.
5. **Observe:** capture exact actions and inputs, responses, exit codes, stdout/stderr, runtime errors, browser failures and screenshots when browser tests run.
6. **Explain:** distinguish application defects from environment failures, inconclusive execution and wrong test expectations. Root-cause explanations remain inferences.
7. **Review:** inspect replacement-file diffs, risks and affected locations when identifiable. Edit proposals or reject them without changing source.
8. **Approve:** the main Approve & repair all button approves the remaining current revisions. The server validates source snapshots, rejects incompatible replacements, and applies the batch to the managed copy.
9. **Verify:** rerun the original saved contracts and existing suites, detect regressions and update each finding. Export a Markdown report and the managed-copy ZIP.

## Architecture

The browser calls a Node.js 24 service written in TypeScript. QAEngine orchestrates persisted workspaces, phases, logs, reports and verification. BobReasoner invokes IBM Bob Shell in non-interactive Ask mode using a server-side inference key. Its file/edit/execute/MCP/skill/subagent tools are disabled. Model output must satisfy server-owned schemas before execution.

DockerExecutor controls image selection, containers, dependency download access, command deadlines, application startup, disposable PostgreSQL/MySQL/Redis services and cleanup. Worker processes perform real HTTP assertions and browser actions. Source and dependencies stay in disposable container resources rather than host bind mounts. Unprivileged containers have resource and process limits. Container isolation shares the host kernel and does not provide a VM guarantee against malicious code.

The repair layer validates explicit revision approval and exact source hashes. It excludes credentials, generated dependencies and test contracts from patches. Identical shared patches apply once. Conflicting changes stop before writes. Compatible proposals apply together and trigger one verification pass. The original checkout remains untouched.

## Distinctive design

The same workspace links each finding to its triggering input and actual execution evidence. It preserves the tests used to establish a failure during repair verification, so a proposed fix cannot silently weaken the expected outcome. It labels documented expectations and assumptions, distinguishes runner failures from application defects, and reports incomplete execution rather than claiming success. Prepared immutable builds reduce repeated dependency work while each independent workflow receives fresh execution state.

## Demonstrated example

The included Shipping Service deliberately contains a boundary defect. Its checked-in unit tests pass, but an order of exactly $100 incorrectly pays $5 delivery even though the documented rule says orders of $100 or more ship free. An earlier actual Bob/Docker/Chromium run observed the problem through API and browser checks. After explicit approval of the source change from > to >=, all 11 saved application checks passed and no regressions appeared. Authentic before/after screenshots and measured summary are in docs/evidence/. This is a labelled fixture, not a production customer case.

The current 40-test orchestration suite separately verifies boundaries, actual HTTP/CLI execution, edits, rejection, batch application, unchanged verification and regression reporting using deterministic reasoning fixtures. See docs/TESTING.md for historical timings and scope.

## Supported scope and limitations

The server registry currently includes Node 24, Node 22, Python 3.12, Go, Rust, Java/Maven, .NET, Ruby, PHP, C/C++ and base Linux images. Operators can register additional trusted images. Availability of an image does not establish exhaustive compatibility for every application in its language.

Upload limits are 2,000 files and 128 MB total, with 32 MB per file. AI context and retrieval are bounded independently. Two jobs can run concurrently. External production credentials and integrations are excluded. Missing SDKs, required private services, unsupported operating systems and undocumented requirements appear as failures or coverage gaps. ProofRun cannot guarantee finding every bug.
