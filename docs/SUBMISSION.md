# Submission package and final checklist

## Requirements reviewed

- [IBM Bob 2.0 event](https://lablab.ai/ai-hackathons/ibm-bob-2-hackathon).
- [Official guide and Bob session upload instructions](https://lablab-ibm-bob-2-hackathon-guide.s3.us.cloud-object-storage.appdomain.cloud/index.html#upload-bob-task-session-summary).
- [IBM repository security template](https://github.com/watsonxhackathon/ibm-hackathon-template).

The guide requires Bob IDE usage and exported summaries for all relevant tasks in bob_sessions/. The template supplies security/placeholder files, not a required src/app hierarchy. This package keeps executable paths intact, organizes documentation under docs/, and adds the required evidence and security files.

## Contents

The archive contains source, tests, the labelled checkout example, PROJECT.md, SETUP.md, security files, docs/, presentation/ and bob_sessions/. It excludes the real .env, installed .tools/, local .proofrun-data/, work/, node_modules/ and raw live sessions. Historical setup verification is explicitly labelled under docs/history/. Earlier runtime evidence lives in docs/evidence/ and is distinct from the current 40-test orchestration result.

## Before submitting

- [x] Source published to https://github.com/bilalqaiserw/proofrun (public). Use this repository URL in the submission form.
- [ ] Include all relevant Bob IDE task summaries. One supplied summary is included; capture additional tasks if applicable.
- [ ] Inspect screenshots for credentials and private information before publication.
- [ ] Record the running application's detection, diff approval and unchanged verification. The deck and screenshots support the video but do not replace the working demo.
- [ ] Keep a visible time-compression label if lengthy analysis or retesting is sped up. Use your measured elapsed time.
- [ ] Upload the required video and pitch deck using the event's submission fields and current limits.
- [ ] Paste the statements from LONG_DESCRIPTION.md and IBM_BOB_USAGE.md. Each is below 500 words.
- [ ] Check the event's current deadline and submission status directly in the portal. This package does not claim submission is complete.
- [ ] Ensure judges can reproduce the local workflow using SETUP.md and their own authorized key. If the portal requires a hosted prototype, supply an actual working URL or discuss the local Docker requirement with organizers. No hosted URL is fabricated here.

## Git checks

From a Git repository, inspect staging before committing:

```powershell
git check-ignore -v .env
git status --short
git diff --cached --name-only
git diff --cached
```

.env must be ignored and not tracked. The exported PNG in bob_sessions/ must be included. Do not display your key during the video. The source package supplies configuration placeholders only.
