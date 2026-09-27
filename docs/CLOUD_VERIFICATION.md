# Live Vercel verification

Verified on 27 September 2026 at 2026-09-27T17:27:30.607Z. This was a fresh cloud execution, separate from the recorded local report on the homepage.

- Uploaded the six-file Shipping Service example through the deployed API.
- IBM Bob analyzed the source, generated practical tests and proposed a narrow repair.
- Existing tests, HTTP requests, malformed inputs and three Chromium workflows actually executed in restricted Docker containers.
- Before approval: 9 checks passed and 1 failed (the documented $100 free-shipping boundary).
- Inspected and explicitly approved the `shipping.mjs` change from `> 100` to `>= 100` in the disposable managed copy.
- After approval: all 10 checks passed, test contracts remained unchanged, and there were zero regressions and zero open issues.
- The downloaded working-copy ZIP contained the approved source change; Markdown export returned HTTP 200.
- Missing authentication and incorrect codes returned 401; cross-origin initialization returned 403.

[Full measured evidence](evidence/vercel-cloud-validation.json). Screenshots are captured inside each private session and expire with it.

Cold setup downloads Docker, Bob and runtime images and takes several minutes. Sessions last 45 minutes. Fresh reasoning requires a valid IBM key and remaining credits; the recorded homepage evidence stays available after credentials expire. This verification covers the sample, not every software project.
