---
title: The shell identifies itself, and its update goes through the same notifications
status: accepted
date: 2026-09-10
covers:
  - packages/node-root/src/image-contract.ts
  - packages/node-root/src/wrapper-identity.ts
  - server/backend/src/core/updates/update-check-scheduler.ts
  - server/backend/src/core/updates/wrapper-update-checker.ts
  - packages/desktop/src/auto-updater.ts
---

> **Implementation status (2026-09-10).** Slices 1–4 are in code; the
> decision is [D437](../decisions/adr-0437-observe-what-you-can-declare-only-what-you-cannot.md).
> Slice 5 (electron's `UpdateState` towards the hub) is **not** done: it touches the
> electron main process. Two deviations from the text below, both
> deliberate:
>
> - **`canSelfUpdate` does not exist.** The electron app already updates itself
>   without anyone pressing anything (`auto-updater.ts`: `autoDownload` +
>   `autoInstallOnAppQuit`), so there is no action to enable and
>   no button. The notification sentence is chosen from `kind`; a field that
>   nobody reads would be the defect this repo keeps paying for.
> - **The availability row carries the SEED's versions**, not
>   `WrapperIdentity.currentVersion`: the version of an electron app is not
>   on the same scale as a release, and the seed is what
>   `contractVersion` was compared against.

# The shell identifies itself, and its update goes through the same notifications

## What already exists — and must be reused, not rewritten

Three pieces are already in production and cover half of the problem.

**`image-contract.ts` already answers the question "is my shell old?"**
It does so without a docker socket and without credentials, because it uses the `seedVersion` —
the `@camstack/server` closure baked into the image — as the fingerprint
of the image itself. The release workflow guarantees that the image
`intel-X.Y.Z` carries seed `X.Y.Z`, so `seed vs current release` **is**
`running image vs contract image`. When neither of the two
proofs holds, the verdict is `unknown`, not `in-sync`.

**`UpdateCheckScheduler` already has the clock and the failure isolation.**
A sweep every 6 h over four paths, and a check that throws is skipped without
publishing — an empty snapshot would mean "everything is up to date".

**The electron shell already identifies itself, via env.** `packages/desktop/src/main.ts`
passes `CAMSTACK_AGENT_APP_VERSION: app.getVersion()` to the child process, and
`agent-http.ts` reads it on `/api/agent/status` with the comment that matters:
*"absent when the agent runs headless / in Docker"*.

## What is really missing

1. **The TYPE of shell is not known to anyone.** `ImageContract` says "this
   node is behind" but does not know whether it is docker, electron or native — so the
   message cannot say **how** to update, and the UI does not know whether to show a
   button or a command.
2. **The verdict does not become a notification.** Today it ends up in a `logger.warn`
   inside `root-update-service`, in an admin-ui banner that listens only to
   `behind-series`, and in an HA sensor. None of the four scheduler
   targets publishes it, so there is no `wrapper-update-available`.
3. **Electron's `UpdateState` never travels up to the hub.** `electron-updater`
   checks the GH Releases every 6 h and keeps the state in the main process, visible
   only to the tray and the local agent UI.

## How a system identifies itself

**Observe what you can, declare only what you cannot — and never let
the declaration be the only source.**

This repo has already paid for the opposite case. On 2026-08-02
`check-deployment-templates.ts` proved every day that the templates
declared `ghcr.io/camstack/camstack:intel-latest`, while the hub was running
`camstack-server:intel-1.1.74` from a renamed repository. **The declaration
was right, reality was not, and nothing compared them.** A `CAMSTACK_WRAPPER=docker`
written in the template is exactly that same declaration.

So, field by field:

| Fact | How it is obtained | Declared or observed |
|---|---|---|
| it is a container | `/.dockerenv`, or `docker`/`containerd` in `/proc/1/cgroup` | **observed** |
| it is inside electron | `CAMSTACK_AGENT_APP_VERSION` present | **declared** — unavoidable: the server is a CHILD process of electron, so `process.versions.electron` is `undefined`; the env is the only channel |
| it is native | neither of the two | observed by exclusion |
| electron shell version | `app.getVersion()` via the same env | declared by the shell about itself — the most authoritative source there is |
| docker shell version | `seedVersion` (already computed) | **observed** |
| image ref (`repo:tag`) | invisible from the inside | declarable via `CAMSTACK_IMAGE_REF`, but **for display only**, never as proof |

Two non-negotiable consequences:

- **`kind` is not an env.** The only env needed is the one that already exists.
  Adding one that states the type would mean being able to declare `electron`
  inside a container.
- **A contradiction is REPORTED, not resolved.** An electron env inside a
  container is not a case in which to pick a winner: it is a
  `kind: 'contradictory'` with both proofs on the record. A shell we cannot
  identify is `unknown`, never `native` by default — the same
  rule with which `assessImageContract` refuses to say `in-sync` without proof.

## Who can update itself

| Shell | Update | Button? |
|---|---|---|
| electron | `quitAndInstall` — already wired | **yes** |
| docker | impossible from the inside: a container cannot replace its own image | **no** — informational notification, with the exact command in the body |
| native (mac agent) | outside our control | **no** |

Hence `canSelfUpdate: boolean` on the record, and the button that appears only when
it is true — the same discipline as `serverUpdateButtonRefusal` (D325).

## The work, in slices

1. **`WrapperIdentity` in `@camstack/types`** — `kind`
   (`docker | electron | native | contradictory | unknown`), `evidence[]` (what
   was observed, what was declared), `currentVersion`, `canSelfUpdate`.
   Zero-dep, next to `image-contract.ts`, so the starter can use it.
2. **`detectWrapperIdentity()`** in `packages/node-root` — pure, with the proofs as
   input, testable without a filesystem.
3. **`wrapper` field on `ServerPackageStatusSchema`** — additive, so only the
   node that produces it needs to be republished... **no**: it is `@camstack/types`, so
   it is a framework change and needs a published `@camstack/server` (D16). It goes
   in an already scheduled release.
4. **Fifth target in the scheduler** — `checkWrapperUpdate`, which publishes
   `wrapper-update-available` through the same `UpdateAvailabilityEmitter`
   (dedup and durability live there, this is just another source).
5. **Electron's `UpdateState` towards the hub** — the main process writes it where the
   child reads it; the GH feed is NOT re-implemented server-side.

## The trap already paid for, not to be repeated

From the comment in `auto-updater.ts`: the release repo is **private**, the feed
answered 404 to an app without credentials, and the app checked every six hours
always failing **silently** — `checking` went back to false and the page
redrew "Check for updates" as if nothing had happened. The operator restarted
and pressed the button several times before anyone looked at the feed by hand.

A shell check that fails is `error`, never "no update".
