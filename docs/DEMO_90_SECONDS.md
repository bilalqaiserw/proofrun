# Recording the 90-second ProofRun video

Use [the slide-by-slide video script](../presentation/VIDEO_SCRIPT.md) and the editable deck in presentation/. Show the working app during the detection, approval and validation sections.

## Prepare before recording

1. Follow [SETUP.md](../SETUP.md). Configure your own Bob inference key and start Docker's Linux engine.
2. Run the production Docker gate before recording to prepare and verify browser execution. First image downloads can take several minutes.
3. Start ProofRun with npm start and open the actual URL shown by your terminal.
4. Click Test My App and choose examples/shipping-service. This openly labelled example deliberately contains a shipping-boundary defect. It is not a customer production incident.
5. Let the actual Bob analysis and application tests finish. Check that the report identifies the exactly-$100 boundary and contains a concrete diff. Leave the proposal unapproved until recording.
6. Open Tests to inspect the saved inputs and captured browser evidence. In Issues, inspect the diff and its risks. Position the main Approve & repair all button for recording.

## Record

Show the triggering input and actual response. Explain the expected free delivery at exactly $100. Inspect Bob's proposed boundary correction. Click the main **Approve & repair all** button to explicitly approve pending revisions. ProofRun applies compatible changes to the managed copy and runs the saved checks once.

Show Validation and the final report. Say the test count and elapsed time visible in your actual run. A generated plan can differ from the historical recording evidence.

If you compress waiting time, keep an on-screen label such as **Retest sped up. Actual elapsed time: [measured duration]**. Replace the bracketed value with your real observation. Do not imply the complete scan of a large repository takes 90 seconds.

## Evidence and scope

The earlier actual Bob/Docker/Chromium audit recorded 11 checks, two initial failures, 11 passing after repair, and zero regressions. Its initial analysis/testing took 145.8 seconds and its approved retest took 68.2 seconds. Those are historical measurements of this small fixture, distinct from the 40 local orchestration regression tests. See [live audit summary](evidence/live-audit-verification.json).

The source ZIP excludes local workspace jobs, so it does not supply a preloaded project ID or a bookmarked localhost workspace. A fresh judge run must create its own project and use its own authorized key. The original example remains faulty because repairs affect managed copies.
