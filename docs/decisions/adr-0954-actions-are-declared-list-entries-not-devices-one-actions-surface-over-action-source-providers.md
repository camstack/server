---
id: D954
title: Actions are declared list entries, not devices — one `actions` surface over `action-source` providers, with run traces and cooldown in a hub ledger
status: accepted
date: 2026-10-27
applies-to:
  - packages/types/src/capabilities/actions.cap.ts
  - packages/types/src/capabilities/action-source.cap.ts
  - packages/types/src/automation/**
  - packages/system/src/builtins/core-blocks/**
---

## Context

An operator wants to press "night mode", "open the gate" or a Home Assistant
script from a camera page, and to call the same thing from an automation. The
first idea was to model each as a device with a button cap. That makes the
device registry carry things that are not devices (no state, no identity beyond a
name), forces every provider addon to mint rows for them, and gives a viewer no
way to be allowed one action without being allowed a whole device.

Separately, an automation block kept its cooldown stamp and trace ring in
`ctx.storage` inside its forked runner. The editor that paints a trace could not
read it, and a second consumer (an Action run) would have needed a second copy of
the same code.

## Decision

1. **An action is a list entry.** A provider addon DECLARES actions through the
   `action-source` collection cap (`listActions`, `runAction`, `stopAction`); the
   operator authors internal ones (`internal:<uuid>`, cap and wait steps with
   typed variables) in the `core-blocks` builtin. One singleton cap, `actions`,
   is the only surface the UI and automations use. It keeps NO catalog of its own
   (D3): every `list` asks the sources live and overlays run status.
2. **One step runner.** `runSteps` / `buildActionSteps` in `@camstack/types` run
   the steps of an automation's THEN half and of an internal action alike, and
   produce the same `AutomationStepTrace` (`actions.N` / `steps.N`). An
   automation gains an `{ kind: 'action' }` step that awaits `actions.run` and
   fails its own step unless the run `ran`. Actions cannot contain actions, so
   there are no cycles to detect.
3. **Run state lives in a hub ledger.** The `runs` record kind of `core-blocks`
   holds, per owner (`automation:<blockId>` / `action:<actionId>`), the cooldown
   stamp and the bounded trace ring. A block reads its stamp once at start and
   reports through `core-blocks.reportAutomationRun`; the call is owner-only
   (`core-blocks` is a caller-stamped cap, the stamp must be
   `core-block-<blockId>`). The in-memory stamp stays the authority at fire time
   (D49); an unreadable stamp lets the run through and says so in the trace.
4. **Permissions follow the camera (D356).** A camera links the actions the
   operator picked (`action-links` record kind, row id = deviceId,
   `deviceRemoval: 'delete'`). A non-admin may `get` / `run` an action only
   through a camera that links it: the call names the camera (`deviceId`, a
   top-level field, so the viewer scope gate proves the caller may see it) and
   the provider proves the link. An admin may run anything, and so may an automation block: its
   in-process call arrives with the mesh principal, which is an admin identity
   (`createMeshTrpcContext`). The router refuses a call with no identity
   (`injectCaller`) before the provider runs. A refusal is a typed
   `[not-linked]` error and a log line.
5. A run of an action that is already running is refused — traced as
   `skipped-overlap`, logged — never queued.

## Consequences

- No action ever appears in the device registry; there is nothing to
  garbage-collect when a source addon is removed.
- `@camstack/types` and `@camstack/system` change together (new caps,
  `core-blocks` added to the caller-stamped list): a publish must force both,
  and the generated automation block now needs the new `core-blocks` methods, so
  a block compiled before this change reads and writes its old `ctx.storage`
  file until it is recompiled.
- An automation's cooldown now survives only through the hub: a hub that cannot
  answer the stamp read at block start lets the first run through (traced).
- If every `action-source` provider is down, `list` returns the internal actions
  only and logs it; the UI cannot tell "no addon actions" from "addon not
  answering" until a presence query exists for the cap.
- Deleting an internal action removes every camera link naming it. A link to an
  action an addon stopped declaring is hidden from `listForCamera` and kept (the
  addon may come back).

## Enforcement

`actions-service.spec.ts` (scoped user runs a linked action, is refused an
unlinked one, admin runs anything; overlap refused; read-only refusal),
`runs-api.spec.ts` (owner-only ledger, ring bound, sweep confirmed by a second
read), `generated-block.spec.ts` (ledger RPC, action step), and the
caller-stamp list in `caller-stamp.ts`.
