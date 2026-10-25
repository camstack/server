---
id: D437
title: Observe what you can, declare only what you cannot — and a contradiction is reported, not resolved
status: accepted
date: 2026-09-10
supersedes:
applies-to:
  - packages/node-root/src/wrapper-identity.ts
  - server/backend/src/core/updates/wrapper-update-checker.ts
---

## Context

A node had no idea what it was running INSIDE. `assessImageContract` could say
"this node's image is behind the release contract", but not whether that image
was a Docker container, an Electron app bundle or a bare install — so the
verdict could never become an instruction, and it reached the operator through
nothing but a `logger.warn`.

The obvious fix is an env var: `CAMSTACK_WRAPPER=docker` in the compose
template. This repo has already paid for exactly that shape. On 2026-08-02
`scripts/check-deployment-templates.ts` passed every single day proving the <!-- drift-ok -->
templates DECLARED `ghcr.io/camstack/camstack:intel-latest`, while the hub
actually ran `camstack-server:intel-1.1.74` — a 13-day-old image from a
repository that had been renamed and received no builds. `runningVersion` was
current (`applyServerUpdate` swaps the data-root and never touches the image),
so every surface was green on a node whose starter, entrypoint and boot seed
were weeks old. **The declaration was right. Reality was not. Nothing compared
them.** An env var naming the wrapper kind would be the same declaration with
the same failure mode, and this time nothing at all would be able to check it.

The awkward half: the node cannot observe that it is a child of an Electron
main process. `process.versions.electron` is `undefined` in the child, so the
only channel is `CAMSTACK_AGENT_APP_VERSION` — which the main process already
writes and `agent-http.ts` already reads.

## Decision

`WrapperIdentity.kind` is DERIVED from probes, never read from an env var. The
one env var in play is the one that already exists
(`CAMSTACK_AGENT_APP_VERSION`), and it is marked `mode: 'declared'` on the
evidence row so a reader can see it was not observed.

Every probe stays on the record — including the ones that found nothing,
because "checked, absent" and "never checked" are the whole distance between
`native` and `unknown`. From that:

- An Electron declaration INSIDE an observed container is `contradictory`, with
  both proofs on `evidence` and no winner chosen. A resolver here would be the
  2026-08-02 failure with extra steps: it would silently prefer one source and
  nothing would ever compare them again.
- A shell that could not be identified is `unknown`, never `native` by
  default — the same discipline with which `assessImageContract` refuses to say
  `in-sync` without evidence. Exclusion requires a probe that ANSWERED.
- A failed measurement is `null`, never a value (D393): an unreadable
  `/proc/1/cgroup` is `null`, never `''`, because `''` would read as "checked,
  no container".

The announcement that rides on this (`wrapper-update-available`, the fifth
`UpdateCheckScheduler` target) is INFORMATIVE. No node can replace the shell it
is running inside, so there is no apply button and no `canSelfUpdate` field:
the body sentence is chosen from `kind` alone, and a boolean nothing reads is a
defect this repo keeps paying for. The check itself follows the scheduler's own
rule — a node that cannot answer REJECTS, so the sweep records an error; an
inconclusive contract verdict (`unknown`, `ahead`) publishes NOTHING rather
than an empty snapshot, because an empty snapshot clears the dedup state and
reads as "the image is fine".

## Consequences

- `detectWrapperIdentity` takes its probes as INPUTS and is pure, so the whole
  table is exercisable on a developer Mac. A detector testable only by running
  it inside a container is a detector nobody tests.
- Two verdicts exist purely to refuse a guess, and callers must handle them.
  `contradictory` and `unknown` both carry `currentVersion: null`.
- The wrapper announcement uses the SEED versions, not
  `WrapperIdentity.currentVersion`: an Electron app version is not on the same
  scale as a release, and the seed is what `contractVersion` was compared
  against.
- Adding a new shell means adding a probe, not an env var. If a future shell is
  genuinely unobservable, it gets a `declared` evidence row and says so.

## Enforcement

- `packages/node-root/src/__tests__/wrapper-identity.spec.ts` pins every row of
  the table, including "unknown, NEVER native, when the container probe could
  not run" and "REPORTS the contradiction instead of picking a winner". Both
  were confirmed to go red when the rule is removed.
- `server/backend/src/core/updates/__tests__/wrapper-update-checker.spec.ts`
  pins "an inconclusive sweep does not WIPE the standing announcement" and the
  reject-on-unanswerable path.
- `packages/addon-post-analysis/src/notification-center/__tests__/wrapper-update-intake.spec.ts`
  pins that no apply button is minted for the kind.
- Review only for "no env var declares the kind": there is no guard, because
  the rule is about an env that does not exist. If one ever appears, the
  evidence rows are where its dishonesty would be visible.
