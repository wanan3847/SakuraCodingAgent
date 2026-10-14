---
name: sakura-planning
description: Decompose a coding task into a dependency-ordered plan and decide which parts can run in parallel. Use before any task that touches more than one file, spans modules, or could be done two different ways.
---

# Planning

Decide **what** must happen before deciding **who** does it.

## 1. Size the task honestly

A README typo needs one edit and a check. A cross-module bug needs parallel exploration and
a diagnosis step. Do not run a five-agent pipeline for a one-line fix — the cost is real and
the result is worse.

## 2. Write tasks as outcomes, not as steps

"Find why refresh returns the old token" is a task. "Open auth-service.ts" is not — that is
one way of doing it, and it forecloses better ones.

## 3. Make dependencies explicit

Two tasks that both write the same directory cannot run at once. Two read-only explorations
usually can. If you cannot name the dependency, the tasks are probably one task.

## 4. Keep the graph checkable

Every dependency must name a task that exists. Writers should declare a write scope. If the
plan is not a DAG, it is not a plan.

## 5. Expect to replan

The first plan is a hypothesis. When verification fails and the failure is not a one-line
slip, fix the graph — do not just retry the same node and hope.

## Tools in this repo

- `sakura_plan` returns a validated Task DAG with parallel layers, without running anything.
- `sakura_run` plans and executes in one step.
