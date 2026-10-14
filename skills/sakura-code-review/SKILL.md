---
name: sakura-code-review
description: Review a diff for correctness, scope creep, and missing evidence. Use when asked to review changes, a branch, a pull request, or your own work before calling it done.
---

# Code review

Review the change, not the file it lives in.

## What to actually look for

1. **Does it do what was asked?** Compare against the request, not against what the code
   appears to be trying to do.
2. **Is it correct on edge cases?** Empty input, missing keys, concurrent writers, the error
   path nobody runs until production.
3. **Is the fix in the right place?** A guard in every caller is a bigger diff than one guard
   where all callers route through.
4. **Scope creep.** Every unrelated rename, reformat, or "while I was here" makes the diff
   harder to review and the revert riskier.
5. **Does it leave a check behind?** Non-trivial logic needs one runnable assertion that
   fails if the logic breaks.
6. **Over-engineering.** An interface with one implementation, a factory for one product, a
   config key for a value that never changes. Delete before you review.

## Reporting

Report concrete findings with `file:line` and a one-line reason. Separate "this is wrong"
from "I would have done it differently" — the second one is not a finding.

## In this repo

- `sakura_repo` with `action=impact` to see what else a changed symbol touches.
- `sakura_workspace` with `action=diff` to collect a worktree's diff before review.
