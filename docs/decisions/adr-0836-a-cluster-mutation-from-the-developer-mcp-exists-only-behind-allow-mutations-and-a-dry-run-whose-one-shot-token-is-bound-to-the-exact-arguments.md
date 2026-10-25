---
id: D836
title: A cluster mutation from the developer MCP exists only behind --allow-mutations and a dry run whose one-shot token is bound to the exact arguments
status: accepted
date: 2026-10-13
supersedes:
applies-to:
  - packages/mcp-dev/src/mutations/gate.ts
  - packages/mcp-dev/src/ops/hub.ts
  - packages/mcp-dev/src/models/**
  - packages/mcp-dev/src/release/commands.ts
---

## Context

P2 of the developer MCP (D835) is read-only by construction: its hub object has
a `query` and nothing else. P3 needs two tools that change the running cluster:
a node benchmark (a LOAD TEST: the hub drains a node and moves its cameras, and
load tests have taken this cluster down) and the finishing half of a model
import (convert formats and copy hundreds of MB to every agent).

Rejected:

- **MCP elicitation as the confirmation.** The client decides whether it honours
  it, auto-approve settings can answer it for the operator, and a server cannot
  tell. The confirmation has to be something the SERVER checks.
- **A bare `confirm: true` argument.** A model that wants the result sets it on
  the first call. Nothing separates "described" from "executed".
- **Giving the existing `OpsHub` a `mutate`.** It would end P2's "a tool that
  wants to write has no function to call" for every tool, not for the two that
  were reviewed to need it.
- **A `model_studio_import(bundle)` that uploads from the laptop.**
  `importModelBundle` takes its tar over a same-host peer-bytes ticket that only
  an addon on the hub can mint (D806, D613); a path handed across a trust
  boundary was rejected there. The tool is therefore the gated second half
  (`ensureFormatsThenDistribute` for a model Model Studio already holds), and
  the bytes still arrive by the trainer's return flow or the Model Studio
  upload.

## Decision

A mutating tool is three things, none of which can be skipped:

- **It exists only when the server is started with `--allow-mutations`.** Without
  the flag it is not registered; the gate also refuses by itself, so a future
  caller that bypasses the registration still cannot mutate.
- **The first call is always a dry run.** It runs read-only queries (for a
  benchmark, the hub's own preflight), describes what would happen, and returns
  a `confirm_token`. A preflight that says the hub would refuse returns no token.
- **A second call executes only with that token and the SAME arguments.** The
  token is single-use, expires in five minutes, is bound to the tool and to a
  digest of the canonical arguments, is consumed the moment it is presented
  (a mismatch, an expiry or a failed execution all need a fresh dry run), and at
  most sixteen are outstanding.

The mutation itself goes through a second object, `OpsMutator`, created only
when the flag is on, that refuses every method outside an allow-list of two
(`pipelineOrchestrator.startNodeBenchmark`, and `addons.custom` for the single
Model Studio action `ensureFormatsThenDistribute`), requires the method to be a
`mutation` in the generated API index, and requires an admin credential for an
admin-tier method. Every call, refusals included, is written to an audit sink
(stderr JSON lines by default); the hub's own audit trail records the scoped
token's use as for any admin call.

The release tools get the same shape of guarantee the other way round: they run
processes only through an allow-list of reads (`git rev-parse|rev-list|log|
describe|diff|status`, `gh run list|view`, `npm view`), so a publish, a workflow
dispatch, a push or a tag is not a command they can spell. A deny-list of "bad"
subcommands would rot the first time a new one appeared.

## Consequences

- The two mutating tools are annotated `readOnlyHint: false, destructiveHint:
  true, openWorldHint: true`; `.mcp.json` does not set the flag, so the operator
  turns it on deliberately for one session.
- A benchmark started through the tool cannot be aborted through the tool (the
  budget bounds it, and the Benchmark page has the abort). Adding an abort is a
  second allow-listed mutation, deliberately not part of this one.
- The five-minute token is a freshness bound for the described state, not a
  security boundary: whoever holds the MCP session holds the operator's
  authority, as with every ops tool.
- A new mutating tool is an entry in the allow-list, a spec for each gate, and a
  line in `annotations.ts`; the annotation lookup throws for an unclassified
  tool, so it cannot ship quietly.

## Enforcement

`packages/mcp-dev/src/__tests__/mutation-gate.spec.ts` (flag off, token absent,
expired, mismatched, replayed, wrong tool, failed execution, audit),
`models.spec.ts` (dry run never calls the mutator, preflight refusal gives no
token, allow-list, admin tier), `models-mcp.spec.ts` (tools absent without the
flag, present and annotated with it, the full cycle over MCP) and
`release.spec.ts` (the command allow-list, and that the release tools never
spawn a publish or a dispatch). Each gate was removed once and a spec went red;
see (planning repo: sessions/sessions.md), 2026-10-13. <!-- drift-ok: moved to the private planning repo -->
