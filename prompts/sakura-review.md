---
description: Review the newest Sakura run's diff against its own evidence
---
Review the newest Sakura run without trusting its summary.

1. `/sakura-status` to get the run id and its metrics.
2. Read `.sakura/runs/<id>/diffs/<id>.diff` — this is the only thing that changed.
3. Read `.sakura/runs/<id>/events.jsonl` and check the `verification.finished` events. Confirm
   the passing commands actually cover the files in the diff.
4. Report, per changed file: what changed, whether a test or check exercises it, and whether
   the change is in scope for the original task.
5. Call out anything that would look like a passing result but is not: skipped tests,
   commented-out assertions, unrelated files rewritten, a "pass" with no command executed.
