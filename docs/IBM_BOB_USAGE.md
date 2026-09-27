# IBM Bob usage statement

I used IBM Bob in two parts of ProofRun: during development in the Bob IDE and as the reasoning engine inside the running application.

During development, Bob assisted me with implementation and project refinement. One documented task improved the report-download workflow. I asked Bob to use the project's existing IBM Bob integration to organize the already captured application explanation, test results, issues, proposed fixes and validation outcomes into a readable Markdown report, rather than making users interpret a raw JSON download. The included IDE task-session summary shows the ProofRun workspace, completion of the task and five changed files. This evidence is saved in bob_sessions/.

At runtime, the Node backend invokes IBM Bob Shell in non-interactive Ask mode using an IBM Bob inference API key stored only on the server. Bob examines bounded source excerpts to explain the application's purpose, determine installation/build/start/test requirements, and propose practical API, browser or CLI checks. After execution, it uses captured inputs, responses and logs to explain observed failures and propose concrete code changes with risks and diffs. Bob also organizes the downloadable Markdown report from saved evidence.

ProofRun separates Bob's reasoning from execution. Bob's file-edit and command-execution tools are disabled for these application invocations. A separate Docker runner executes validated plans and collects observations. Users inspect, edit or reject proposed changes, then explicitly approve the remaining batch. The application applies approved patches to a managed copy and reruns the unchanged tests to check the original failures and regressions.

Bob therefore contributes both to building a user-facing reporting feature and to the product's core analysis and repair workflow. Actual execution evidence determines test outcomes, while Bob supplies explanations and proposals.
