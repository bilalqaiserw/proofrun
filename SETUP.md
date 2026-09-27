# ProofRun setup and first run

This guide starts from a fresh source download. You do not need to repeat installation on a machine that already works. Run commands from the folder containing package.json.

## 1. What you need

| Component | Purpose |
| --- | --- |
| Node.js 24 and npm | Run the TypeScript service and local installer |
| Docker Desktop with a working Linux engine, or Docker Engine on Linux | Execute submitted code in disposable containers |
| IBM Bob Shell 2.x | Invoke Bob's inference from the backend |
| An IBM Bob subscription and inference API key | Authenticate actual analysis and fix proposals |
| A browser | Use the local ProofRun workspace |
| Internet access | Download Bob, runtime images and project dependencies |

No watsonx.ai key, OpenAI key, separate frontend server, Compose stack or trained model is required. Production reasoning uses IBM Bob. npm test uses labelled fixtures for reproducible orchestration verification.

## 2. Install Node.js

Install Node.js **24** from [nodejs.org](https://nodejs.org/en/download), then open a new PowerShell window:

```powershell
node --version
npm --version
```

The Node version must begin v24. package.json supports >=24 and <25. The start command uses Node's built-in TypeScript execution and environment-file loader. There is no npm dependency installation step for the ProofRun application itself.

## 3. Prepare Docker on Windows

Use the current [Docker Desktop Windows instructions](https://docs.docker.com/desktop/setup/install/windows-install/) to check operating-system and virtualization requirements. Docker documents WSL 2 support and a minimum of 8 GB system RAM. Large repositories can require more available memory and disk.

### WSL and virtualization

If WSL is already installed, check it first:

```powershell
wsl --status
wsl --version
```

If WSL is missing, open an administrator PowerShell and follow [Microsoft's WSL installation guide](https://learn.microsoft.com/en-us/windows/wsl/install):

```powershell
wsl --install
```

Restart if Windows asks. Complete any distribution first-run prompts. For an existing WSL installation:

```powershell
wsl --update
wsl --set-default-version 2
```

Enable hardware virtualization in BIOS/UEFI if Windows reports it unavailable. Installation requirements and administrator privileges depend on the Docker installation mode and Windows configuration.

### Docker Desktop

1. Download Docker Desktop from the official page and install it.
2. Choose the WSL 2 backend where available.
3. Launch Docker Desktop and complete its own first-use prompts.
4. Use **Linux containers**. ProofRun's runtime images are Linux images.
5. Wait until the engine is running. Leave Docker Desktop running while using ProofRun.
6. Open a new regular PowerShell and verify:

```powershell
docker version
docker info --format '{{.OSType}}'
docker run --rm hello-world
```

docker version must show a responsive Server section, and OSType must print linux. A working Docker command without a responsive engine is insufficient.

Docker manages CPU/memory through its configured backend. Leave capacity for concurrent containers and browser workers. ProofRun constrains each job but cannot create missing host memory or disk. Do not change Docker's global configuration just to imitate another machine's limits.

## 4. Open the project folder

For the original working copy:

```powershell
cd "C:\Users\tmp\Documents\Codex\2026-09-26\ok-so-i-am-building-a\outputs\proofrun"
```

For a downloaded submission, extract the ZIP and enter its proofrun folder instead. Confirm package.json is present with Get-ChildItem.

## 5. Install Bob Shell

```powershell
npm run setup:bob
```

The project installer downloads IBM's published package, verifies its vendor SHA-256 checksum and installs it under .tools/bob/. It does not ask for your key. Verify:

```powershell
node .tools/bob/node_modules/bobshell/dist/bob.js --version
```

For vendor installation alternatives, see [IBM Bob Shell installation](https://bob.ibm.com/docs/shell/getting-started/install-and-setup). If using another installation, set BOB_BIN to its native executable, or BOB_JS_ENTRY to the absolute dist/bob.js path. On Windows, a .cmd shim should use BOB_JS_ENTRY rather than BOB_BIN.

## 6. Create and configure the API key

1. Sign in at [bob.ibm.com](https://bob.ibm.com/) with your IBMid. For this event, use the hackathon-provisioned subscription instance described in the [official guide](https://lablab-ibm-bob-2-hackathon-guide.s3.us.cloud-object-storage.appdomain.cloud/index.html).
2. Open your subscription instance's API key management section.
3. Create an **Inference** key for that instance/team. IBM also offers General keys, which need a team ID for inference.
4. Store the displayed value securely. IBM shows it only when created. See [IBM's API key instructions](https://bob.ibm.com/docs/shell/account/api-keys).
5. Create .env only if it does not already exist:

```powershell
if (-not (Test-Path -LiteralPath .env)) {
    Copy-Item -LiteralPath .env.example -Destination .env
}
notepad .env
```

Set these values in **.env beside package.json**:

```dotenv
BOBSHELL_API_KEY=PASTE_YOUR_REAL_IBM_BOB_INFERENCE_KEY_HERE
BOB_MAX_COST=2
PORT=3000
```

For a General key, also add BOB_TEAM_ID=YOUR_TEAM_ID. Keep the actual key out of screenshots, recordings, prompts, browser JavaScript and uploaded source. .env is ignored by Git and excluded from the source archive. Only the backend passes this credential to Bob Shell. Submitted containers do not receive it.

BOB_MAX_COST is a Bobcoin limit **per invocation**, not the budget for a complete job. Analysis, retrieval, test generation, investigation and Markdown report generation can make separate calls. Confirm sufficient account balance before recording.

IBM's current standalone Shell documentation names its key variable BOB_API_KEY. ProofRun maps your single BOBSHELL_API_KEY setting to that name in the Bob child process, while retaining compatibility with the installed Shell. The scripts/bob-cli.mjs wrapper performs the same mapping for first-use setup. You do not need to duplicate your key.

Restart ProofRun whenever .env changes. An existing PowerShell environment value overrides the same name in .env, so remove stale PORT/BOB settings from that terminal when diagnosing unexpected configuration.

## 7. Complete IBM's first-use license setup

If Bob reports a required license agreement, view it:

```powershell
node scripts/bob-cli.mjs --show-license
```

After you review and choose to accept the terms, run:

```powershell
node --env-file=.env scripts/bob-cli.mjs --accept-license
```

Complete any interactive account setup, then exit the Bob session before starting ProofRun. Acceptance is your decision and ProofRun does not perform it for you. See [Bob non-interactive usage](https://bob.ibm.com/docs/shell/getting-started/start-bobshell-non-interactive).

## 8. Optional preparation before a demo

Initial image downloads can take several minutes. For the bundled checkout example, you can download its runtime first:

```powershell
docker pull node:24-bookworm
```

Browser execution needs the bundled Playwright/Chromium worker image, which ProofRun builds on demand using worker/Dockerfile.browser. Run the Docker gate before recording to prepare and verify actual browser execution:

```powershell
npm run test:docker
```

Do not pull every language image unnecessarily. ProofRun fetches the selected project runtime when required. npm run test:live also exercises actual Bob/Docker inference and consumes account resources. It is optional setup verification, not the command that starts the app.

## 9. Start ProofRun

```powershell
npm start
```

Open **http://localhost:3000**. Keep that terminal open. Press Ctrl+C to stop the service. Start it again with npm start. The browser's **Connection & setup** dialog should report Bob installation, key presence and Docker readiness. Presence checks cannot prove a key is valid or a license is accepted until an actual Bob request runs.

If port 3000 is occupied, use another port in the same terminal:

```powershell
$env:PORT = "3001"
npm start
```

Then open http://localhost:3001. Stop the previous ProofRun process before starting a replacement against the same data directory. ProofRun prevents two servers from owning one workspace store. Do not kill unrelated programs merely because they use a desired port.

## 10. Run the first practical test

1. Click **Test My App**.
2. Choose a project folder containing its manifests, source, configuration and tests. For the demonstration, choose examples/shipping-service.
3. Create the testing workspace. ProofRun copies eligible files into .proofrun-data/ and starts analysis/testing inside the same app.
4. Watch **Overview** for purpose/languages, then **Tests** and **Logs** for execution. Setup/build problems remain explicit environment findings.
5. In **Issues**, inspect exact inputs, expected/actual behavior and proposed diffs. The supplied checkout example intentionally fails the exactly-$100 delivery boundary.
6. Edit or reject a proposal if appropriate. Neither action changes source. If proposals are missing, use **Generate all proposals**.
7. Click the main **Approve & repair all** button to explicitly approve all remaining current revisions. Compatible changes apply to the managed copy and launch one verification pass. Conflicting changes stop before writes.
8. Inspect **Validation**. The saved tests retain their expectations and regressions remain visible.
9. **Download report** requests a readable Markdown report through Bob. The JSON evidence endpoint remains available. **Download working copy** exports the managed project's ZIP.

Your original project folder remains untouched. To adopt the repair in your repository, inspect and incorporate the exported changes yourself.

## 11. Verification commands

| Command | What it establishes |
| --- | --- |
| npm test | Orchestration and approval regression suite with labelled fixture reasoning and actual owned HTTP/CLI execution |
| npm run test:docker | Production Docker executor, CLI/HTTP execution, secret separation and real Chromium screenshots |
| npm run test:live | Real IBM Bob/Docker analysis, patch approval and unchanged verification |

Prerequisite-dependent gates can skip. Read the summary rather than treating an exit code alone as proof of execution. There are currently 40 local regression tests. Historical live measurements are in docs/evidence/ and docs/TESTING.md.

## 12. Troubleshooting

| Symptom | Action |
| --- | --- |
| EADDRINUSE or another ProofRun already owns the store | Stop your previous ProofRun terminal with Ctrl+C. Use an unused port if another program occupies 3000. |
| Bob Shell is missing | Run npm run setup:bob from this root. Verify the local dist/bob.js path exists. |
| License agreement is required | Review the license and complete step 7 interactively. |
| Authentication/team error | Check the key's instance, type and team. An Inference key needs no extra team ID. A General key needs BOB_TEAM_ID. Restart after changes. |
| Docker daemon unavailable | Open Docker Desktop, wait for its Linux engine and check docker version's Server section. |
| docker command not found | Open a new terminal after installation. ProofRun can discover standard Desktop locations. For a custom install set PROOFRUN_DOCKER_BIN to docker.exe's full path. |
| Docker reports logging compression/max-file error | Current ProofRun explicitly configures its container logging. Confirm you restarted the current source. Inspect the captured command/logging error before changing global daemon settings. |
| Image pull or dependency download failure | Confirm Docker registry and allowed package-registry connectivity. Private packages need supported synthetic fixtures or a separately designed credential mechanism. |
| Install/build is slow or fails | Review exact commands in Logs. First downloads and large monorepos take longer. Check memory, disk, runtime compatibility and sandbox storage limits. |
| Bob response is incomplete | Read the reasoning error. Continue practical tests can reuse already verified unchanged suites where available. Never count an incomplete run as passed. |
| Browser integration fails | The first browser image build requires download access and disk. External browser requests are restricted and production integrations are not exercised. |
| No repair proposal | A finding may be an environment problem, a wrong test expectation or insufficient evidence. Review its category. ProofRun does not invent a source patch for every failure. |
| Proposed revisions conflict or source changed | Inspect/Edit or Reject the incompatible proposal. If source hashes changed, generate fresh proposals. Nothing should apply from a stale diff. |

Do not share .env while troubleshooting. Use the captured, redacted logs.

## 13. Linux and macOS hosts

Install Node 24 and a Docker Linux engine, then use the same npm commands from the root. Copy .env.example to .env without overwriting an existing configuration, set the same server variables and finish Bob's license/account setup. The submitted applications still run inside Linux runtime images. Native Windows/macOS applications and hardware-dependent code require other adapters.

## 14. Publishing the source

Follow docs/SUBMISSION.md. The submission ZIP excludes .env, .tools/, .proofrun-data/ and work/. Reinstall Bob and configure your own key when running the downloaded package. Do not deploy this loopback Docker controller as a public service without authentication and a dedicated isolated execution architecture.
