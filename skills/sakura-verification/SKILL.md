---
name: sakura-verification
description: Prove a change works using the project's own commands and report the evidence. Use before declaring any task complete, fixed, or passing.
---

# Verification

No verification, no completion.

## 1. Run the project's commands, not invented ones

Look for `package.json` scripts, `Makefile`, `pyproject.toml`, `Cargo.toml`, `go.mod`, CI
config. Run what the project already defines. A command you made up proves nothing about
whether the project is healthy.

## 2. Report exit codes and real output

"Tests should pass" is not a report. Give the command, the exit code, and the tail of the
output. Keep the failing output too — that is the evidence the next attempt needs.

## 3. Distinguish "not run" from "passed"

If no test command exists, say so explicitly. Silence is not success. Never let a missing
check read as a passing one.

## 4. Check the diff, not just the tests

Tests can pass while the diff does something else entirely — commented-out assertions, a
skipped test, an unrelated file rewritten. Read your own diff before claiming done.

## 5. Failed verification route: diagnose, then fix or replan

A single deterministic slip is a retry. Everything else needs the plan to change.

## In this repo

- `sakura_run` runs lint/typecheck/test/build detected from the workspace and writes the
  evidence to `.sakura/runs/<id>/`.
- `/sakura-status` prints the newest run's metrics.
