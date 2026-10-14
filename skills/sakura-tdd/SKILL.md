---
name: sakura-tdd
description: Build a change test-first so the test proves the behavior instead of describing it. Use when adding a feature, fixing a bug that should not come back, or when asked to work in a red-green-refactor loop.
---

# Test-driven development

Write the test that fails for the right reason. Then make it pass. Then stop.

## 1. Red — the test must fail first

A test that passed before your change proves nothing about your change. Run it, watch it
fail, and confirm it fails for the reason you expect, not a typo in the setup.

## 2. Green — the smallest change that passes

Resist building the general solution while only one case exists. Ship the minimum, and let
the next failing test tell you what the general shape needs to be.

## 3. Refactor — only when green

Restructure with the test passing at every step. Refactoring while red means you cannot tell
a redesign from a regression.

## 4. One runnable check, not a suite

Per behaviour, one test that fails if the logic breaks. No per-function suites, no fixtures
invented for a single assertion. Tests that nobody runs are worse than no tests: they rot
silently.

## 5. Never snapshot a model's prose

If the code under test calls a model, assert on the resulting state — files changed, exit
codes, returned values. Text output is random; it is not an oracle.

## In this repo

`npm test` runs `node --test`. New unit tests go in `tests/unit/*.test.ts` and must pass
without a model, without git, and without network.
