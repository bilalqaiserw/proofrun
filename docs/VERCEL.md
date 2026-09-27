# Vercel cloud deployment

The web interface is served by Vercel. The server function creates a separate Vercel Sandbox for each browser session. Inside that VM, Docker runs the existing restricted execution engine and IBM Bob Shell performs reasoning. Approved changes and retests use the existing workflow.

## Required server-side variables

- BOBSHELL_API_KEY: IBM Bob key, marked Sensitive.
- PROOFRUN_ACCESS_CODE: at least eight characters; share privately with judges.
- BOB_TEAM_ID: optional, if required by your IBM account.
- PROOFRUN_SESSION_SECRET: optional independent cookie-signing secret; defaults to the IBM key.

Vercel OIDC authenticates the Sandbox SDK automatically. The function uses an HTTP-only signed session cookie. The sandbox gateway requires a separate authentication token that never reaches the browser. Local folder paths are rejected in cloud mode.

## Limits

Cloud folder/ZIP submissions are limited to 3 MB before JSON encoding (2 MB per file), subject to Vercel's function request limit. Local execution retains its larger upload limits. Sessions expire after 45 minutes and are ephemeral: download reports and working copies before expiry. The first startup installs Docker and Bob and can take several minutes. Available cloud quota and IBM credits are required. No cloud reliability or performance claim should be made before a live run is verified.

## Deployment

Import the repository, select Other, and retain vercel.json build/output settings. Add the server variables and deploy. Open the URL, enter the access code, then upload a project. Bootstrap progress is displayed before the normal testing workspace opens. Never commit an environment file or share the key with judges.

## Cloud resource enforcement

The Vercel universal image uses a threaded cgroup root. It cannot delegate a memory controller to nested Docker containers. Cloud mode therefore enforces memory and CPU at the private Firecracker VM boundary (4 GiB hard cap, 2 vCPUs), while Docker retains PID limits, dropped capabilities, read-only filesystems and isolated networks. Local mode keeps its 1536 MB per-container memory limit. Bootstrap must execute an actual restricted container successfully before declaring the environment ready.
