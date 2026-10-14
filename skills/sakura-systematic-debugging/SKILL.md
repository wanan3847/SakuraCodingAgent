---
name: sakura-systematic-debugging
description: Diagnose a bug by reproducing it, narrowing it to one failing path, and proving a root-cause fix with evidence. Use when a test fails, code throws, behavior regressed, or a fix "does not work" for reasons nobody has explained yet.
---

# Systematic debugging

Fix the root cause, not the stack trace the ticket names.

## 1. Reproduce before theorising

Get one command that fails deterministically. If you cannot reproduce it, every later step
is guessing. Record the exact command; it becomes the verification evidence.

## 2. Find the whole flow, not the failing line

Grep every caller of the function you are about to touch. A symptom shows up on one path;
the cause usually lives where **all** paths route through. Fixing only the caller named in
the report leaves the sibling callers broken.

## 3. One hypothesis at a time

State the hypothesis, then make the smallest change that would falsify it. Do not stack
three speculative edits and re-run once — you will not know which one mattered.

## 4. Prove it with the reproduction

The reproduction that failed in step 1 must now pass, unchanged. Then run the neighbouring
tests. "Looks right" is not evidence.

## 5. Say what you did not fix

If the fix is a shortcut with a known ceiling, write it down in the report and in a code
comment. A silent shortcut becomes the next person's mystery.

## Tools in this repo

- `sakura_repo` with `action=impact` before changing a shared symbol.
- `sakura_repo` with `action=tests` to find which tests exercise the file.
- `sakura_run` when the bug spans modules and needs planning plus verification.
