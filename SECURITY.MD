# ProofRun security and credential handling

This repository follows the credential-management intent of the [IBM hackathon template](https://github.com/watsonxhackathon/ibm-hackathon-template). Its upstream .gitignore and .bobignore patterns are retained, with project exclusions appended.

## Server credentials

BOBSHELL_API_KEY belongs only in the root .env or your server's process environment. An optional BOB_TEAM_ID identifies the team for a General key. .env.example contains placeholders only. Never share keys in prompts, session screenshots, source, comments, exports or videos. If a key leaks, revoke it through IBM and create another.

Git ignore rules do not remove files already tracked in a repository. Check staged content and history before publishing. Do not ask Bob or another assistant to read your actual .env. .bobignore provides file-selection protection, not a guarantee that secrets manually pasted into a prompt disappear.

## Execution boundary

The service binds loopback and requires same-origin workspace requests. Only the server controls Docker runtime images, resource limits and workspace ownership. Bob's reasoning invocations disable filesystem and execution tools. Schemas validate its proposals before the executor acts.

Containers use unprivileged users, restricted networks, read-only roots and bounded resources. Application containers do not receive the Bob key or host Docker socket. Container isolation shares a kernel. Use a dedicated execution host for code you do not trust. This local app is not a hardened public malware analysis service.

## Repairs

No source patch applies during reasoning. Explicit approval must identify the current diff revisions and source snapshots. A batch checks every precondition before writes, applies identical shared changes once and refuses conflicting replacements. Test contracts, credential files and dependency caches cannot be patched. Source patches affect managed copies, not original connected checkouts.

## Submission

Publish source, placeholder configuration, documentation and reviewed exported Bob task summaries. Exclude local stores, installed tools, live session files and real credentials. Inspect screenshots before uploading. bob_sessions/ must remain included because the official guide requires exported task-session summaries.
