import { PROJECT_LIMITS, formatBytes } from "./project-limits.js";

import { sourceLanguages } from "./languages.js";

const $ = (id) => document.getElementById(id);

const esc = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,

    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );

const pretty = (value) => JSON.stringify(value, null, 2);

let job = null,
  connection = null,
  view = "overview",
  selectedFiles = [],
  editing = null,
  loading = false,
  navigating = false,
  navigationRevision = 0,
  uploading = false,
  downloading = false,
  polling = false;

const headers = { "x-proofrun": "1" };

async function api(path, body) {
  if (body !== undefined && connection && connection.protocolVersion !== 4)
    throw new Error(
      "This tab is connected to an older ProofRun server. Open the updated app at http://localhost:3003, or restart this server before testing.",
    );

  const response = await fetch("/api/qa/" + path, {
    headers: {
      ...headers,

      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },

    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
  });

  const data = await response.json();

  if (!response.ok) throw new Error(data.error ?? "Request failed");

  return data;
}

function notice(text, error = false) {
  $("status").textContent = text;

  $("status").classList.toggle("error", error);
}

function setView(name) {
  view = name;

  for (const item of ["overview", "issues", "tests", "logs", "validation"])
    $("view-" + item).hidden = item !== name;

  for (const button of document.querySelectorAll("[data-view]"))
    button.classList.toggle("active", button.dataset.view === name);
}

async function listProjects() {
  const { projects } = await api("projects");

  $("project-list").innerHTML = projects

    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))

    .map(
      (p) =>
        `<button class="nav-button ${job?.id === p.id ? "active" : ""}" data-project="${p.id}"><div>${esc(p.name)}<small>${esc(p.phase)} · ${p.issues} open issues</small></div></button>`,
    )

    .join("");

  for (const button of document.querySelectorAll("[data-project]"))
    button.onclick = () => openProject(button.dataset.project);

  $("clear-projects").hidden = projects.length === 0;
}

async function checkSetup() {
  try {
    connection = await api("status");

    const outdated = connection.protocolVersion !== 4;

    $("open-updated-app").hidden = !outdated;

    $("open-updated-app").href = "http://localhost:3003/" + location.hash;

    if (outdated) connection.ready = false;

    $("new-project").disabled = outdated;

    $("welcome-upload").disabled = outdated;

    $("connection-pill").textContent = connection.ready
      ? "Bob & Docker ready"
      : "Setup required";

    $("connection-pill").className =
      "outcome " + (connection.ready ? "passed" : "inconclusive");

    $("setup-banner").hidden = connection.ready;

    const missing = [
      outdated
        ? "This is an older ProofRun server. Open the updated app at http://localhost:3003; restarting the server also loads the latest fixes."
        : null,

      !connection.bob.installed
        ? connection.bob.detail || "Bob Shell installation was not found."
        : null,

      !connection.bob.keyConfigured
        ? "Add your Bob key to the server .env file."
        : null,

      !connection.docker.available
        ? "Docker Linux containers are not running."
        : null,
    ].filter(Boolean);

    $("setup-message").textContent = missing.join(" ");

    $("setup-state").innerHTML =
      `<p>Bob Shell: <strong>${connection.bob.installed ? "installed" : "missing"}</strong> · API key: <strong>${connection.bob.keyConfigured ? "configured" : "missing"}</strong> · Docker: <strong>${connection.docker.available ? "ready" : "unavailable"}</strong></p>`;

    $("setup-error").textContent = connection.ready
      ? "Connection ready. Upload your project to begin."
      : missing.join(" ");
    render();
    render();
  } catch (error) {
    $("setup-error").textContent = error.message;

    notice(error.message, true);
  }
}

function render() {
  if (!job) {
    const disabled =
      uploading || navigating || connection?.protocolVersion !== 4;
    $("new-project").disabled = disabled;
    $("welcome-upload").disabled = disabled;
    for (const button of document.querySelectorAll("[data-project]"))
      button.classList.remove("active");
    return;
  }

  $("welcome").hidden = true;

  $("workspace").hidden = false;

  $("breadcrumb").textContent = job.name;

  $("project-name").textContent = job.name;

  $("project-meta").textContent =
    `${job.inventory.length} files · created ${new Date(job.createdAt).toLocaleString()}`;

  $("job-message").textContent = job.message;

  const reasoning = job.reasoningProgress;

  $("reasoning-progress").hidden = !reasoning;

  $("reasoning-progress").textContent = reasoning
    ? `${reasoning.operation} · ${Math.max(0, Math.floor((Date.now() - Date.parse(reasoning.startedAt)) / 1000))} seconds elapsed.`
    : "";

  $("analysis-warnings").hidden = !job.analysisWarnings?.length;

  $("analysis-warnings").textContent = job.analysisWarnings?.length
    ? "Execution evidence is ready. Bob could not propose some repairs: " +
      job.analysisWarnings.map((w) => w.message).join("; ") +
      " Open Issues to retry a repair."
    : "";

  $("phase-badge").textContent =
    job.phase === "complete"
      ? job.validations.length
        ? job.validations.at(-1).results.length > 0 &&
          job.validations

            .at(-1)

            .results.every((result) => result.outcome === "passed") &&
          !job.validations.at(-1).error
          ? "Checks passed"
          : "Re-test complete"
        : "Report ready"
      : job.phase;

  $("phase-badge").className =
    "outcome " +
    (["error", "blocked", "cancelled", "interrupted"].includes(job.phase)
      ? "inconclusive"
      : job.phase === "complete" &&
          job.results.length &&
          !job.issues.some((i) => i.status !== "resolved")
        ? "passed"
        : "neutral");

  $("start-run").disabled =
    job.busy ||
    loading ||
    navigating ||
    uploading ||
    connection?.protocolVersion !== 4;

  $("start-run").className = job.results.length
    ? "secondary-button"
    : "primary-button";

  $("cancel-run").disabled = loading || navigating;

  $("new-project").disabled =
    uploading || navigating || connection?.protocolVersion !== 4;

  $("start-run").textContent = job.canResume
    ? "Continue practical tests"
    : job.results.length
      ? "Start a new analysis"
      : "Analyze & test";

  $("cancel-run").hidden = !job.cancellable;

  $("retest").disabled = job.busy || loading || navigating || !job.plan;

  $("export-project").disabled =
    job.busy || navigating || loading || downloading;

  $("export-report").disabled = downloading;

  const steps = [
    ["Analyze", ["analyzing"]],

    ["Environment", ["setup", "building"]],

    ["Tests", ["generating-tests", "testing"]],

    ["Propose fixes", ["diagnosing"]],

    ["Report ready", ["complete"]],

    ["Repair", ["fixing"]],

    ["Re-test", ["retesting"]],
  ];

  const active =
    job.phase === "complete" && job.validations.length
      ? 6
      : steps.findIndex(([, phases]) => phases.includes(job.phase));

  $("pipeline").innerHTML = steps

    .map(
      ([label], index) =>
        `<div class="pipeline-step ${index === active ? "current" : ""}"><span>${index + 1}</span>${label}</div>`,
    )

    .join("");

  const current = job.validations.at(-1)?.results ?? job.results;

  const counts = {
    passed: current.filter((r) => r.outcome === "passed").length,

    failed: current.filter((r) => r.outcome === "failed").length,

    incomplete: current.filter((r) => r.outcome === "inconclusive").length,

    issues: job.issues.filter((i) => i.status !== "resolved").length,
  };

  $("issue-count").textContent = counts.issues;

  $("metrics").innerHTML = Object.entries(counts)

    .map(
      ([name, count]) =>
        `<div><strong>${count}</strong><span>${esc(name)}</span></div>`,
    )

    .join("");

  $("analysis-summary").textContent =
    job.plan?.purpose ??
    (job.plan
      ? "Run Analyze & test to ask Bob for a plain-English explanation of this program."
      : "Bob will explain what this program is meant to do after reading your source.");

  $("capabilities-details").hidden = !job.plan?.capabilities?.length;

  $("analysis-capabilities").innerHTML = (job.plan?.capabilities ?? [])

    .map((item) => `<li>${esc(item)}</li>`)

    .join("");

  const languages = sourceLanguages(job.inventory);

  $("analysis-languages").innerHTML = languages.length
    ? languages

        .map((language) => {
          const role = job.plan?.languages?.find(
            (item) => item.name.toLowerCase() === language.name.toLowerCase(),
          )?.role;

          return `<div class="language-row"><strong>${esc(language.name)}</strong><span>${language.files} ${language.files === 1 ? "file" : "files"}</span><details><summary>${role ? "How it is used" : "Source files"}</summary><p>${esc(role || language.examples.join(", "))}</p></details></div>`;
        })

        .join("")
    : "No implementation language identified from the submitted file types yet.";

  $("analysis-stack").innerHTML =
    job.plan?.stack

      .map((s) => `<span class="stack-tag">${esc(s)}</span>`)

      .join("") ?? "";

  $("plan-details").innerHTML = job.plan
    ? `<h3>Runtime: ${esc(job.plan.runtime)}</h3><pre class="source-code">${esc(pretty(job.plan))}</pre><h3>Test coverage limits</h3><ul>${[...(job.tests?.limitations ?? []), ...(job.coverage ?? [])].map((x) => `<li>${esc(x)}</li>`).join("")}</ul>`
    : "No execution plan yet.";

  $("running-test").hidden = !job.currentTest;

  $("running-test").textContent = "Running: " + (job.currentTest ?? "");

  $("source-summary").textContent =
    `${job.inventory.length} submitted files. ${job.omitted.length} excluded credential/dependency entries. Initial source snapshot: ${job.snapshot.slice(0, 12)}.`;

  $("file-list").innerHTML = job.inventory

    .slice(0, 300)

    .map(
      (f) =>
        `<button class="file-button" data-file="${esc(f.path)}">${esc(f.path)} <small>${f.size} bytes${f.binary ? " · binary" : ""}</small></button>`,
    )

    .join("");

  for (const b of document.querySelectorAll("[data-file]"))
    b.onclick = () => showSource(b.dataset.file);

  renderIssues();

  renderNextStep();

  renderTests();

  $("logs").textContent = job.events

    .map((e) => `${e.time} [${e.phase}/${e.stream}] ${e.text}`)

    .join("\n");

  $("validations").innerHTML = job.validations.length
    ? job.validations

        .map(
          (v) =>
            `<article class="issue-card"><h3>${v.error ? "Validation could not finish" : v.resolved ? (v.fixId ? "Original issue resolved" : "Executed checks passed") : "Review validation results"}</h3><p>${esc(v.time)} · ${v.contractsUnchanged ? "Original test expectations preserved" : "Contracts not verified"}</p><p>${v.results?.filter((r) => r.outcome === "passed").length ?? 0} passed · ${v.results?.filter((r) => r.outcome === "failed").length ?? 0} failed · ${v.results?.filter((r) => r.outcome === "inconclusive").length ?? 0} incomplete · ${v.regressions?.length ?? 0} new regression(s).</p>${v.error ? `<p class="error-text">${esc(v.error)}</p>` : ""}<details><summary>Inspect validation evidence</summary><pre class="source-code">${esc(pretty(v))}</pre></details></article>`,
        )

        .join("")
    : `<div class="empty">${job.phase === "retesting" ? "Rerunning the original checks and watching for regressions…" : "Approve a proposed repair to apply it and rerun tests. Results will appear here."}</div>`;

  setView(view);
}

function pendingRepairs() {
  return job.fixes.filter(f => f.status === "proposed" && job.issues.some(i =>
    i.status !== "resolved" && (i.id === f.issueId || f.relatedIssueIds?.includes(i.id))));
}

function repairTarget() {
  const unresolved = job.issues.filter((issue) => issue.status !== "resolved");

  const proposed = pendingRepairs();

  if (proposed.length) return { kind: "review", fixes: proposed };

  const application = unresolved.find(
    (issue) =>
      !["environment", "reasoning", "test-expectation", "insufficient"].includes(
        issue.category,
      ) && !["proposed", "rejected"].includes([...job.fixes].reverse().find(f => f.issueId === issue.id || f.relatedIssueIds?.includes(issue.id))?.status),
  );

  if (application) return { kind: "generate", issue: application };

  if (unresolved.some((issue) => issue.category === "test-expectation"))
    return { kind: "tests" };

  if (unresolved.some((issue) => issue.category === "reasoning"))
    return { kind: "reasoning" };

  if (unresolved.length) return { kind: "environment" };

  if (job.validations.length) return { kind: "validation" };

  return null;
}

function renderNextStep() {
  const target = repairTarget();

  $("next-step").hidden = !target || job.busy || !job.results.length;

  if (!target) return;

  const copy = {
    review: [
      "Repair proposals are ready",

      `Review the diffs in Issues. This button approves all ${target.fixes?.length ?? 0} pending proposal(s), applies them to your working copy, and reruns the original tests once. Rejected proposals are excluded; findings without a safe proposal remain open.`,

      "Approve & repair all",
    ],

    generate: [
      "Prepare repair proposals",

      "Ask Bob to prepare changes for all findings without a proposal. Review the diffs, then use Approve & repair all. Source changes require that approval.",

      "Generate all proposals",
    ],

    tests: [
      "The generated test needs a correction",

      "This finding is a problem in the generated test, not a confirmed application defect. Start a fresh analysis to correct the test plan and rerun checks; the current report remains available until it starts.",

      "Correct tests & rerun",
    ],

    reasoning: [
      "Finish Bob's analysis",

      "Execution evidence is saved. Retry the incomplete analysis to obtain practical tests and proposed repairs.",

      "Retry analysis",
    ],

    environment: [
      "Resolve the execution requirement",

      "Review the setup or environment finding before rerunning. No application source repair has been established.",

      "Review requirements",
    ],

    validation: [
      "Repair validation is available",

      "Review the unchanged test results and any remaining failures or regressions.",

      "View validation",
    ],
  }[target.kind];

  $("next-step-title").textContent = copy[0];

  $("next-step-description").textContent = copy[1];

  $("repair-action").textContent = copy[2];

  $("repair-action").disabled = loading || connection?.protocolVersion !== 4;

  $("repair-action").disabled ||= navigating || uploading;
}

$("repair-action").onclick = () => {
  if (!job || job.busy || loading) return;

  const target = repairTarget();

  if (target?.kind === "review")
    action("fixes/approve", {
      approved: true,
      fixes: target.fixes.map(f => ({ id: f.id, revision: f.revision })),
    }, "validation");
  else if (target?.kind === "generate")
    action("fixes/generate", {}, "issues");
  else if (["tests", "reasoning"].includes(target?.kind))
    action(job.canResume ? "resume" : "start", {}, "tests");
  else if (target?.kind === "validation") setView("validation");
  else setView("issues");
};

function renderIssues() {
  $("issues").innerHTML = job.issues.length
    ? job.issues

        .map((issue) => {
          const fix = [...job.fixes]

            .reverse()

            .find(
              (f) =>
                f.issueId === issue.id || f.relatedIssueIds?.includes(issue.id),
            );

          return `<article class="issue-card"><div class="issue-heading"><span class="outcome ${issue.status === "resolved" ? "passed" : "failed"}">${esc(issue.severity)}</span><div><h3>${esc(issue.title)}</h3><small>${esc(issue.category)} · ${esc(issue.status)} · ${esc(issue.basis)}</small></div></div><p>${esc(issue.description)}</p><div class="issue-grid"><div><h4>Expected behavior</h4><p>${esc(issue.expected)}</p></div><div><h4>Likely root cause</h4><p>${esc(issue.rootCause)}</p>${issue.affected.map((a) => `<button class="text-button" data-source="${esc(a.path)}">${esc(a.path)}${a.line ? ":" + a.line : ""}${a.symbol ? " · " + esc(a.symbol) : ""}</button>`).join("")}</div></div><details><summary>Inputs, actual behavior &amp; reproduction</summary><pre class="source-code">${esc(pretty({ triggeringInput: issue.triggeringInput, actual: issue.actual, reproduction: issue.reproduction, context: issue.executionContext }))}</pre></details><details><summary>Logs &amp; stack trace</summary><pre class="log-console">${esc(issue.logs + "\n" + issue.stackTrace)}</pre></details><p><strong>Recommended fix:</strong> ${esc(issue.recommendedFix)}</p><p>${esc(issue.fixExplanation)}</p><p class="workflow-footnote"><strong>Possible side effects:</strong> ${esc(issue.risks)}</p>${fix ? `<section class="fix-preview"><h4>${fix.revision > 1 ? "User-edited change" : "Proposed change"} · revision ${fix.revision}</h4><p>${fix.revision > 1 ? "Original Bob rationale: " : ""}${esc(fix.explanation)}</p>${fix.files.map((file) => `<details open><summary>${esc(file.path)}</summary><pre class="patch-diff">${esc(file.diff)}</pre></details>`).join("")}<p class="workflow-footnote">${esc(fix.risks)}</p><div class="fix-actions">${fix.status === "proposed" && issue.status !== "resolved" ? `<button class="secondary-button" data-edit="${fix.id}" ${job.busy ? "disabled" : ""}>Edit proposal</button><button class="text-button" data-reject="${fix.id}" ${job.busy ? "disabled" : ""}>Reject</button>` : `<span class="outcome">${esc(fix.status)}${issue.status === "resolved" ? " · failure resolved" : ""}</span>`}</div>${fix.retest ? `<p>Re-test: ${fix.retest.resolved ? "original failure resolved" : (fix.retest.error ?? "review remaining failures")}</p>` : ""}</section>` : ""}</article>`;
        })

        .join("")
    : `<div class="empty">${job.busy ? "Testing is running. Findings will appear as they are detected." : job.phase === "blocked" ? "Complete setup, then start testing. No application tests have executed." : "No issues have been recorded. Check execution status and coverage before concluding the application is ready."}</div>`;

  for (const b of document.querySelectorAll("[data-reject]"))
    b.onclick = () => action(`fixes/${b.dataset.reject}/reject`, {});

  for (const b of document.querySelectorAll("[data-edit]"))
    b.onclick = () => editFix(b.dataset.edit);

  for (const b of document.querySelectorAll("[data-source]"))
    b.onclick = () => showSource(b.dataset.source);
}

function renderTests() {
  const results = job.validations.at(-1)?.results ?? job.results;

  const plans = [...(job.tests?.http ?? []), ...(job.tests?.browser ?? [])];

  $("tests").innerHTML = results.length
    ? results

        .map(
          (result) =>
            `<article class="issue-card"><div class="issue-heading"><span class="outcome ${result.outcome === "passed" ? "passed" : result.outcome === "failed" ? "failed" : "inconclusive"}">${esc(result.outcome)}</span><h3>${esc(result.title)}</h3></div><p>${esc(result.intent ?? result.expected ?? "")}</p><small>Expected: ${esc(result.expected ?? "Command completes successfully")} · ${esc(result.basis ?? "existing test suite")}</small><details><summary>Exact requests, actions &amp; outcomes</summary><pre class="source-code">${esc(pretty(result.trace ?? result))}</pre></details>${result.screenshot ? `<button class="text-button" data-screenshot="${esc(result.screenshot)}">View captured screenshot</button><div id="shot-${esc(result.id)}"></div>` : ""}</article>`,
        )

        .join("")
    : `<div class="empty">${plans.length ? plans.length + " generated workflows are ready for execution." : "Tests will appear after project analysis and environment setup."}</div>`;

  for (const b of document.querySelectorAll("[data-screenshot]"))
    b.onclick = async () => {
      try {
        const res = await fetch(
          "/api/qa/projects/" + job.id + "/artifact/" + b.dataset.screenshot,

          { headers },
        );

        if (!res.ok) {
          const response = await res.json();

          throw new Error(response.error || "Screenshot unavailable");
        }

        const url = URL.createObjectURL(await res.blob());

        const image = document.createElement("img");

        image.onload = image.onerror = () => URL.revokeObjectURL(url);

        image.src = url;

        image.alt = "Captured failure screenshot";

        image.className = "test-screenshot";

        b.after(image);

        b.disabled = true;
      } catch (e) {
        notice(e.message, true);
      }
    };
}

async function openProject(id) {
  const revision = ++navigationRevision;

  navigating = true;

  if (editing) {
    $("edit-dialog").close();

    editing = null;
  }

  if (location.hash !== "#project/" + id)
    history.pushState(null, "", "#project/" + id);

  render();

  try {
    const received = await api("projects/" + id);

    if (revision !== navigationRevision) return;

    job = received;

    view = "overview";

    render();

    await listProjects();

    notice("");
  } catch (error) {
    if (revision === navigationRevision) {
      job = null;

      $("workspace").hidden = true;

      $("welcome").hidden = false;

      $("breadcrumb").textContent = "Project workspaces";

      notice(error.message, true);
    }
  } finally {
    if (revision === navigationRevision) {
      navigating = false;

      render();
    }
  }
}

async function action(path, body, nextView) {
  if (!job || loading || navigating) return;

  const projectId = job.id,
    revision = navigationRevision;

  loading = true;

  render();

  notice("Working...");

  try {
    const received = await api("projects/" + projectId + "/" + path, body);

    if (job?.id !== projectId || revision !== navigationRevision) {
      await listProjects();

      return;
    }

    job = received;

    if (nextView) view = nextView;

    render();

    await listProjects();

    notice(job.message);

    if (job.phase === "blocked") await checkSetup();
  } catch (error) {
    if (job?.id !== projectId || revision !== navigationRevision) return;

    notice(error.message, true);

    try {
      const received = await api("projects/" + projectId);

      if (job?.id === projectId && revision === navigationRevision) {
        job = received;

        render();
      }
    } catch {}
  } finally {
    loading = false;

    render();
  }
}

async function showSource(path) {
  const projectId = job.id,
    revision = navigationRevision;

  try {
    const source = await api(
      "projects/" + projectId + "/source?path=" + encodeURIComponent(path),
    );

    if (job?.id !== projectId || revision !== navigationRevision) return;

    $("source-title").textContent = source.path;

    $("source-content").textContent = source.content;

    $("source-dialog").showModal();
  } catch (error) {
    if (job?.id === projectId && revision === navigationRevision)
      notice(error.message, true);
  }
}

function editFix(id) {
  if (loading || navigating || job.busy) return;

  editing = { ...job.fixes.find((f) => f.id === id), projectId: job.id };

  $("edit-files").innerHTML = editing.files

    .map(
      (f, index) =>
        `<label class="form-label">${esc(f.path)}<textarea class="edit-source" data-edit-index="${index}" spellcheck="false">${esc(f.after)}</textarea></label>`,
    )

    .join("");

  $("edit-error").textContent = "";

  $("edit-dialog").showModal();
}

$("save-edited-fix").onclick = async () => {
  if (!editing || $("save-edited-fix").disabled) return;

  const proposal = editing;

  $("save-edited-fix").disabled = true;

  try {
    const files = proposal.files.map((f, i) => ({
      path: f.path,

      beforeHash: f.beforeHash,

      after: document.querySelector(`[data-edit-index="${i}"]`).value,
    }));

    const received = await api(
      "projects/" + proposal.projectId + "/fixes/" + proposal.id + "/edit",

      {
        files,
      },
    );

    if (job?.id !== proposal.projectId) return;

    job = received;

    $("edit-dialog").close();

    editing = null;

    render();

    notice("New diff revision saved. Inspect it before approving.");
  } catch (error) {
    if (editing?.id === proposal.id)
      $("edit-error").textContent = error.message;
  } finally {
    $("save-edited-fix").disabled = false;
  }
};

for (const button of document.querySelectorAll("[data-close]"))
  button.onclick = () => {
    if (button.dataset.close === "upload-dialog" && uploading) return;

    $(button.dataset.close).close();

    if (button.dataset.close === "edit-dialog") editing = null;
  };

$("edit-dialog").addEventListener("close", () => (editing = null));

for (const button of document.querySelectorAll("[data-view]"))
  button.onclick = () => setView(button.dataset.view);

function uploadDialog() {
  if (uploading) return;

  $("upload-form").reset();

  selectedFiles = [];

  $("upload-selection").textContent =
    "Choose the application folder, excluding installed dependencies.";

  $("upload-error").textContent = "";

  $("upload-dialog").showModal();
}

$("new-project").onclick = uploadDialog;

$("upload-dialog").addEventListener("cancel", (event) => {
  if (uploading) event.preventDefault();
});

$("welcome-upload").onclick = uploadDialog;

$("choose-folder").onclick = () => $("source-folder").click();

$("source-folder").onchange = (e) => {
  selectedFiles = [...e.target.files];

  $("local-path").value = "";

  $("zip-file").value = "";

  const files = selectedSourceFiles();

  const bytes = files.reduce((n, f) => n + f.size, 0);

  $("upload-selection").textContent =
    `${files.length} files · ${formatBytes(bytes)}${files.length !== selectedFiles.length ? ` · ${selectedFiles.length - files.length} excluded` : ""}`;

  $("upload-error").textContent = selectionError(files);

  if (!$("upload-name").value)
    $("upload-name").value =
      selectedFiles[0]?.webkitRelativePath.split("/")[0] ?? "";
};

function selectedSourceFiles() {
  return selectedFiles.filter(
    (f) =>
      !/(^|\/)(\.env(?!\.example$|\.sample$)[^/]*|.*\.(pem|key|p12|pfx)|id_rsa|id_ed25519|.*(credentials|secrets)[^/]*|\.npmrc|\.pypirc|\.netrc)(\/|$)/i.test(
        f.webkitRelativePath,
      ) &&
      !/(^|\/)(node_modules|\.git|\.bob|\.codex|\.tools|\.proofrun-data|\.venv|venv|__pycache__|dist|build|target|coverage|\.ssh|\.aws|\.azure|\.kube)(\/|$)/i.test(
        f.webkitRelativePath,
      ),
  );
}

function selectionError(files) {
  const bytes = files.reduce((n, f) => n + f.size, 0);

  const large = files.find((f) => f.size > PROJECT_LIMITS.maxFileBytes);

  if (large)
    return `${large.webkitRelativePath} is ${formatBytes(large.size)}; each file can be up to 32 MB.`;

  if (
    files.length > PROJECT_LIMITS.maxFiles ||
    bytes > PROJECT_LIMITS.maxProjectBytes
  )
    return `Selected ${files.length} files / ${formatBytes(bytes)}. Limit: 2,000 files / 128 MB after exclusions.`;

  return "";
}

async function base64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();

    reader.onload = () =>
      resolve(
        String(reader.result).slice(String(reader.result).indexOf(",") + 1),
      );

    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));

    reader.readAsDataURL(file);
  });
}

$("upload-form").onsubmit = async (event) => {
  event.preventDefault();

  if (uploading) return;

  uploading = true;

  $("submit-project").disabled = true;

  $("upload-error").textContent = "";

  try {
    const input = { name: $("upload-name").value || "My application" };

    const local = $("local-path").value.trim(),
      zip = $("zip-file").files[0];

    if (local) input.localPath = local;
    else if (zip) {
      if (zip.size > PROJECT_LIMITS.maxProjectBytes)
        throw new Error(`ZIP is ${formatBytes(zip.size)}; limit is 128 MB`);

      input.zip = await base64(zip);
    } else {
      if (!selectedFiles.length)
        throw new Error("Choose your project folder first");

      const filtered = selectedSourceFiles();

      const error = selectionError(filtered);

      if (error) throw new Error(error);

      input.files = [];

      const total = filtered.reduce((n, f) => n + f.size, 0);

      for (let i = 0; i < filtered.length; i += 8) {
        input.files.push(
          ...(await Promise.all(
            filtered.slice(i, i + 8).map(async (f) => ({
              path:
                f.webkitRelativePath.split("/").slice(1).join("/") || f.name,

              base64: await base64(f),
            })),
          )),
        );

        $("upload-selection").textContent =
          `Preparing ${Math.min(i + 8, filtered.length)} / ${filtered.length} files · ${formatBytes(total)}`;
      }

      $("upload-selection").textContent =
        "Uploading project and creating your workspace…";
    }

    job = await api("projects", input);

    $("upload-dialog").close();

    view = "overview";

    ++navigationRevision;

    navigating = false;

    history.pushState(null, "", "#project/" + job.id);

    render();

    await action("start", {});
  } catch (error) {
    $("upload-error").textContent = error.message;

    notice(error.message, true);
  } finally {
    uploading = false;

    $("submit-project").disabled = false;

    render();
  }
};

$("start-run").onclick = () => action(job?.canResume ? "resume" : "start", {});

$("cancel-run").onclick = () => action("cancel", {});

$("retest").onclick = () => action("retest", {}, "validation");

for (const id of ["setup-button", "show-setup"])
  $(id).onclick = () => {
    $("setup-dialog").showModal();

    checkSetup();
  };

$("refresh-setup").onclick = checkSetup;

$("clear-projects").onclick = async () => {
  if (!confirm("Remove all project workspaces? This cannot be undone.")) return;
  try {
    await fetch("/api/qa/projects", { method: "DELETE", headers });
    job = null;
    if (location.hash) history.pushState(null, "", location.pathname);
    await listProjects();
    render();
  } catch {
    notice("Could not clear workspaces", true);
  }
};

async function download(kind) {
  if (
    !job ||
    downloading ||
    navigating ||
    (kind === "download" && (job.busy || loading))
  )
    return;

  const projectId = job.id,
    revision = navigationRevision;

  downloading = true;

  render();

  notice(
    kind === "report"
      ? "Generating Markdown report with IBM Bob — this may take a moment..."
      : "Preparing your working copy...",
  );

  try {
    const endpoint =
      kind === "report" ? "report-md" : kind;
    const response = await fetch(
      "/api/qa/projects/" + projectId + "/" + endpoint,
      { headers },
    );

    if (!response.ok) throw new Error("Download failed");

    const link = document.createElement("a");

    link.href = URL.createObjectURL(await response.blob());

    const disposition = response.headers.get("content-disposition") ?? "";
    const filenameMatch = /filename="([^"]+)"/.exec(disposition);
    link.download = filenameMatch
      ? filenameMatch[1]
      : kind === "report"
        ? "proofrun-report.md"
        : "proofrun-working-copy.zip";

    if (job?.id !== projectId || revision !== navigationRevision) {
      URL.revokeObjectURL(link.href);
      return;
    }

    document.body.append(link);

    link.click();

    link.remove();

    notice("Download prepared: " + link.download);

    setTimeout(() => URL.revokeObjectURL(link.href), 10000);
  } catch (error) {
    if (job?.id === projectId && revision === navigationRevision)
      notice(error.message, true);
  } finally {
    downloading = false;

    render();
  }
}

$("export-report").onclick = () => download("report");

$("export-project").onclick = () => download("download");

setInterval(async () => {
  if (!job || editing || loading || navigating || polling) return;

  const projectId = job.id,
    revision = navigationRevision;

  polling = true;

  try {
    const updated = await api("projects/" + projectId);

    if (job?.id !== projectId || revision !== navigationRevision) return;

    if (updated.updatedAt !== job.updatedAt || updated.busy !== job.busy) {
      const phaseChanged = updated.phase !== job.phase;

      job = updated;

      render();

      notice(job.message);

      if (phaseChanged || !job.busy) listProjects().catch(() => {});
    }
  } catch (error) {
    if (job?.id === projectId && revision === navigationRevision)
      notice(error.message, true);
  } finally {
    polling = false;
  }
}, 2000);

function syncRoute() {
  const route = /^#project\/([0-9a-f-]{36})$/.exec(location.hash);

  if (route) return openProject(route[1]);

  ++navigationRevision;

  navigating = false;

  job = null;

  $("workspace").hidden = true;

  $("welcome").hidden = false;

  $("breadcrumb").textContent = "Your projects";

  $("new-project").disabled = uploading || connection?.protocolVersion !== 4;

  notice("");
}

window.addEventListener("popstate", syncRoute);

window.addEventListener("hashchange", () => {
  const route = /^#project\/([0-9a-f-]{36})$/.exec(location.hash);

  if (route?.[1] !== job?.id && !navigating) syncRoute();
});

const match = /^#project\/([0-9a-f-]{36})$/.exec(location.hash);
const startup = await Promise.allSettled([
  checkSetup(),
  listProjects(),
  match ? openProject(match[1]) : Promise.resolve(),
]);
for (const result of startup)
  if (result.status === "rejected") notice(result.reason.message, true);
