# ProofRun video script

Use slides 1-6 as supporting visuals. Slide 7 is an appendix for judges. Prioritize the working application over reading the slides. This outline totals 90 seconds with the demo. Compress long waits only with an on-screen time-compression label and the actual measured duration.

| Time | Visual | Narration |
| --- | --- | --- |
| 0-8s | Slide 1 | “ProofRun is an AI software QA workspace powered by IBM Bob. It tests a running application and proposes repairs that I approve.” |
| 8-18s | Slide 2 | “Passing unit tests can still miss a real user journey. In this deliberately faulty checkout example, exactly one hundred dollars should qualify for free delivery.” |
| 18-30s | Slide 3, then actual upload/Overview | “I provide the project folder. Bob explains its purpose and plans how to run it. Docker executes the application and practical API and browser checks inside disposable environments.” |
| 30-47s | Actual Tests/Issues | “This input exposes a five-dollar delivery charge. The report preserves the request, expected result and actual response. Browser evidence shows what the customer sees.” |
| 47-66s | Actual diff and main Approve & repair all | “Bob proposes this boundary correction. I can edit or reject it. This main button explicitly approves all pending fixes and applies them only to the managed copy.” |
| 66-79s | Actual retest and Validation, wait compressed with label if needed | “ProofRun reruns the original saved tests and checks previously passing behavior. This recorded result shows the outcomes, any remaining failures and regressions.” |
| 79-90s | Slides 5-6 or actual report | “I also used Bob IDE while developing the report-download feature. ProofRun keeps reasoning separate from execution and ties repairs to repeatable evidence. I can download the readable report and repaired working copy.” |

## Accuracy notes

The deck's historical real Bob/Docker demonstration passed 11 unchanged checks after repair. Your current workspace can contain a different generated set. Say the count and elapsed time visible in your actual recording. The 40 tests on slide 6 are ProofRun's separate orchestration regression suite, not 40 model-generated application tests. Never imply a large arbitrary repository completes in 90 seconds. The example contains a deliberate, disclosed defect.

The supplied Bob IDE screenshot documents a completed Markdown-report development task. Runtime inference uses Bob Shell with the server-side key. Neither screenshot nor deck substitutes for showing the running solution.
