---
description: Run a coding task through Sakura's plan → multi-agent → verify loop
argument-hint: "<task>"
---
Run this task through Sakura instead of editing by hand:

$ARGUMENTS

Do it in this order, and do not skip a step:

1. `sakura_repo` with `action=impact` on the symbols you expect to touch, and
   `action=tests` to find which tests cover them.
2. `sakura_plan` on the task. Look at the layers it returns: those are the parts that can
   run in parallel. If the shape looks wrong for the size of the task, say so before running.
3. `sakura_run` with the same task.
4. Report the result from the trace, not from memory: which nodes succeeded, which commands
   the verifier ran with which exit codes, and where the diff landed
   (`.sakura/runs/<id>/diffs/`). Sakura does not auto-merge; say explicitly that the diff is
   left for review.

If `sakura_run` fails on a model connection or auth error, stop and report it. Do not silently
fall back to ad-hoc edits and then claim the task was verified.
