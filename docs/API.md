# Internal workspace API

The server binds `127.0.0.1:3000`. API requests require header **`x-proofrun: 1`**, a loopback Host, and same Origin when present. It is not intended to be exposed through a public reverse proxy. There is no endpoint that returns or stores the Bob key from the browser.

JSON request bodies are capped at 180 MB to accommodate base64 transport. Intake caps decoded source at 128 MB, with 32 MB per file and 2,000 files; folder, local-path and ZIP intake use the same limits. Invalid input yields HTTP 400 with `{error:string}`. Errors and public evidence mask the server Bob key.

| Method | Path after `/api/qa`                      | Behavior                                                                                    |
| ------ | ----------------------------------------- | ------------------------------------------------------------------------------------------- |
| GET    | `/status`                                 | Installed Bob/key presence/Docker readiness; no secret value                                |
| GET    | `/projects`                               | Workspace summaries                                                                         |
| POST   | `/projects`                               | Copy folder files, local directory or decoded ZIP into a new UUID workspace                 |
| GET    | `/projects/:id`                           | Current stages, plan, tests, outcomes, issues, proposals, events and validation             |
| POST   | `/projects/:id/start`                     | Start source analysis and actual execution, or return blocked setup                         |
| POST   | `/projects/:id/resume`                    | Continue practical generation after verified suites; exact source and suite hashes required |
| POST   | `/projects/:id/cancel`                    | Abort an active run and preserve partial evidence                                           |
| POST   | `/projects/:id/retest`                    | Run persisted tests without new inference or changed expectations                           |
| POST   | `/projects/:id/issues/:issueId/fix`       | Start cancellable background repair reasoning; no source write                              |
| POST   | `/projects/:id/fixes/:fixId/edit`         | Validate edited replacement text and increment revision                                     |
| POST   | `/projects/:id/fixes/:fixId/reject`       | Reject without changing source                                                              |
| POST   | `/projects/:id/fixes/:fixId/approve`      | Explicit revision approval, apply working-copy change, start retest                         |
| GET    | `/projects/:id/report`                    | Structured JSON report including original evidence and validation history                   |
| GET    | `/projects/:id/source?path=relative/path` | Submitted/proposed source preview                                                           |
| GET    | `/projects/:id/download`                  | ZIP of the current managed source copy                                                      |
| GET    | `/projects/:id/artifact/name.png`         | Captured browser screenshot belonging to the workspace                                      |

## Intake payloads

Use one source mechanism:

```json
{
  "name": "My project",
  "files": [{ "path": "src/main.py", "base64": "BASE64_CONTENT" }]
}
```

```json
{ "name": "My project", "localPath": "C:\\Projects\\my-app" }
```

```json
{ "name": "My project", "zip": "BASE64_ZIP" }
```

Archive member paths, decompressed limits, checksums, symlinks, credentials and case collisions are checked before source execution. Import supports ordinary stored/deflated ZIPs, not encrypted, split or ZIP64 archives.

## Batch repair

The main **Approve & repair all** button calls POST `/projects/:id/fixes/approve`:

```json
{ "approved": true, "fixes": [{ "id": "FIX_ID", "revision": 2 }] }
```

Include every pending proposal for unresolved findings. Rejected proposals are excluded. All revisions, snapshots and file preconditions are validated before any writes. Identical shared patches are deduplicated; conflicting replacements are refused without changing source. One unchanged verification run covers the batch, records `fixIds`, and updates every applied proposal.

POST `/projects/:id/fixes/generate` prepares proposals for unresolved application findings without a pending or rejected proposal. Generation never applies source changes.

## Approval/edit payloads

The individual approval endpoint remains for API compatibility. The web interface uses the main batch action.

```json
{ "approved": true, "revision": 2 }
```

The current revision and source hashes must still match. `{approved:false}` cannot apply a change. A missing Docker prerequisite prevents initial approval so validation can run.

```json
{
  "files": [
    {
      "path": "src/main.py",
      "beforeHash": "CURRENT_SHA256",
      "after": "COMPLETE_REPLACEMENT_TEXT"
    }
  ]
}
```

Editing saves a proposal; it does not approve it. Stale neighboring proposals must be regenerated after any source change. New files use `beforeHash:null`.

## Report semantics

Status includes `protocolVersion:4`; clients must refuse mutations against older orchestration versions. Jobs expose `reasoningProgress` while inference is active and `reasoningRuns` with operation, start time, duration, request byte count and outcome. Report exports include those measured reasoning runs. Model responses and server credentials are not exposed as progress data.

Issues preserve severity, category, description, triggering inputs, reproduction, context, logs/stack, expected/actual outcomes, inferred cause, affected paths/lines/symbols, recommended fix, rationale, risks, status and validation. `results` preserves initial observations; `latestValidation` contains current retest observations. Counts describe the latest validation when available. Incomplete or blocked execution does not count as passed.

The analysis object separates `purpose` (Bob's user-facing explanation), `capabilities`, and `languages: [{name, role}]` from technical `summary` and `stack`. Detected language counts are computed from the submitted inventory. Legacy plans without purpose remain readable and ask for a new analysis. Missing tools and storage failures have category `environment`; command timeouts have status `inconclusive`, not a fabricated source defect.

`busy` and `cancellable` describe the current operation. `canResume` is true only for an unchanged workspace with complete passing existing suites and no generated test contract. Repair generation returns job state immediately; poll the workspace for completion. Analysis warnings preserve the usable report even when Bob cannot finish a response.

The CLI server enforces exclusive ownership of its workspace store. Approval holds the workspace lock through retest reservation; concurrent starts are rejected. `project.currentSnapshot` in the report identifies approved source even before a successful validation exists. Failed intake cleans up its newly created workspace. Browser result screenshot names are unique per execution; binary assets cannot be opened as text source.
