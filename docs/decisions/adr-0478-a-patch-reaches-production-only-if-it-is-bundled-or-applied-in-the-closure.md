---
id: D478
title: A patch reaches production only if it is BUNDLED or applied INSIDE the closure, and it says which
status: accepted
date: 2026-09-12
supersedes:
applies-to:
  - patches/**
  - scripts/check-patches-reach-production.ts
  - server/backend/scripts/closure-postinstall.mjs
  - server/backend/scripts/copy-closure-patches.mjs
  - packages/node-root/src/root-single-copy.ts
---

## Context

`patches/` holds three `patch-package` diffs, applied by the repo root's
`postinstall`. That postinstall runs in a developer's `node_modules` and in a CI
runner's `node_modules`, and **nowhere else**. Whether the patched behaviour
exists on a live node is a completely separate question, with a different answer
per package, and until today nothing in this repository asked it.

The session that produced this record started from the opposite conclusion — that
`patches/moleculer+0.15.0.patch` (the D457 follow-up: a 3-byte remainder pinning
a 2 MiB backing store) did not reach production. Four signals said so, and all
four were wrong in the same way, so it is worth writing down how:

| Signal | Why it misled |
| --- | --- |
| `pinsTooMuch` absent from `packages/system/dist/` | rolldown inlines a single-use `const`. The identifier is absent from every bundle **including the correct ones**. |
| `pinsTooMuch` absent from the `@camstack/system@1.2.224` tarball | same. Grepping for `rest.buffer.byteLength` finds the patched expression, present, in that exact tarball. |
| `@camstack/system`'s published `package.json` has no `postinstall` | true, and irrelevant: `moleculer` is not in the vite preset's externals, so rolldown inlines its whole tree — parser included — into `dist/index.js`. |
| the live closure's `node_modules/moleculer/src/transporters/tcp/parser.js` is unpatched | true, and also irrelevant. Exactly one file requires that copy — `@camstack/server/dist/agent/agent-service.js`, for `Errors`. Nothing constructs a `ServiceBroker` from it; every broker on hub and agent comes from `createBroker` in `@camstack/system`, so the `Parser` that actually frames mesh traffic is the bundled, patched one. |

Verified 2026-09-12 on the hub (`unraid`), the Docker agent (`agent-a`) and
in the published tarball: the moleculer patch **does** ship, and
`docs/architecture/transport.md` had said so correctly since 2026-09-11.

The guard test was accused too — `moleculer-tcp-parser.spec.ts`, whose
`ParserLike` was widened to `buf?`/`bufs?`/`bufLen?`, was thought to pass against
both parsers. It does not. Reversing the patch in `node_modules` and running it
produces **4 failures across 2 files**: the copy-census assertions (`copied ≤
framed.length * 3`, `fine ≤ coarse * 4`) are quadratic-detectors and they fire.
Only the pending-remainder assertion is shape-tolerant, and it is not the one
carrying the proof.

**The mechanism the finding described is real. It lands on `werift`, not
`moleculer`, and there it had been live the whole time.** `werift` is the exact
opposite case by design: the three addons that use it (`addon-pipeline`,
`addon-provider-reolink`, `addon-provider-hikvision`) declare it and
`session.ts` resolves it at RUNTIME out of the framework closure, specifically so
the installer's closure-dedupe ([D343]) links all three at ONE 5.3 MB copy
instead of bundling three. That copy is a plain npm tarball; the closure has no
`patches/` directory and had no lifecycle step that could apply one. Measured on
all three nodes — hub, Docker agent, Mac-mini Electron agent — production ran
`werift@0.22.9` **unpatched**: `RTP_HISTORY_SIZE = 128` where the patch sets
4096, and no `forceTurn` candidate-leak guard in `lib/ice/src/ice.js`,
`lib/index.mjs` or `lib/webrtc/src/media/rtpSender.js`.

`session.ts` meanwhile carried a comment calling the closure copy "the patched
copy", and `trpc.router.ts` twice described the leak as fixed. That is the
leftover-that-reads-as-verification failure, three times over, and the specs
backed it up: `@camstack/werift-turn-fix`'s relay-SDP specs load the DEV
`node_modules`, which `patch-package` had just fixed.

`node-turn` is the third patch and it is clean: a devDependency of
`@camstack/werift-turn-fix` only — `private: true`, `camstack: false`, never
published, never deployed. Nothing in production loads it.

### What the werift patch was worth, honestly

Two halves, with very different live weight:

- **`RTP_HISTORY_SIZE` 128 → 4096** is unconditional and affects every WebRTC
  session. werift's `RTCRtpSender` can only answer a NACK for a packet still in
  that ring. At ~1200-byte packets, 128 packets is ~0.6 s of history on a 2 Mbps
  stream and ~0.15 s on an 8 Mbps one — shorter than a 4G NACK round trip — so on
  the high tier most late retransmission requests were unanswerable. This is the
  half that was silently absent.
- **the `forceTurn` candidate-leak guard** is currently latent.
  `CAMSTACK_FORCE_RELAY_REMOTE` is unset on the hub, so
  `enrichInputWithRelayClass` forces `relayOnly: false` for every request-bound
  viewer; only a mesh-originated `relayOnly: true` (Alexa/WHEP) reaches the
  relay path. Its real cost was a trap rather than an outage: the documented
  re-enable path asks an operator to validate one real remote relay session, and
  that validation would have been run against the leak it assumes is fixed.

**How to measure the first half** — not run here, and deliberately not as a
load experiment against production: werift already knows when it cannot serve a
NACK, so the instrument is a counter on that branch (NACK received for a
sequence number no longer in `rtpCache`) reported per session next to the
existing `pairClass` logging, compared across one patched and one unpatched
node. Everything before that counter exists is arithmetic on the ring size, and
should be presented as such.

## Decision

A patch under `patches/` must declare, in `patches/patch-reach.json`, **how it
reaches production**, and the claim is checked:

- **`bundled`** — the patched package is inlined into a package's `dist` at
  build time, and the patch travels inside the published tarball. It must name
  the artifacts and at least one marker, the marker must be present in every one
  of them, and the patched package must not appear as an external of that build.
  A marker must be an **added line of the patch**: one that is not would be found
  in the unpatched file too, and every check built on it would be vacuous.
- **`closure-postinstall`** — the patched package is resolved at runtime from
  the framework closure and cannot be bundled. `@camstack/server` ships the patch
  in `dist/closure-patches/` and applies it from its own `postinstall`, which is
  the one place that runs *inside* the staging closure, with the *new* release's
  patch files, needing no new dependency and no change to the update service.
  The version is pinned **exactly** — in the manifest and in every workspace
  package that declares the dependency — because a caret lets npm resolve a
  version the diff does not apply to.
- **`dev-only`** — no publishable workspace package declares the patched
  package, so the patch has nothing to reach.

There is **no default reach**. A patch with no entry fails CI, because a patch
nobody can say ships is a patch that does not.

And the closure is not *trusted* to be patched, it is **checked**: the applier
is best-effort (it must never fail an install, and an `ignore-scripts` npmrc or a
hoisting surprise makes it a no-op), while `findUnappliedClosurePatches` in
`@camstack/node-root` **refuses to arm a swap** into a closure whose markers are
absent, naming the marker. A best-effort applier plus a fail-closed validator is
the only arrangement in which a skipped patch cannot look like an applied one.

## Consequences

- `@camstack/server` gains a `postinstall`. The closure install passes
  `--omit=dev --no-audit --no-fund` and **not** `--ignore-scripts`, so this
  needs no change to `RootUpdateService` and no widening of what scripts run.
  Cost per install: reading one manifest and three small files — not a factor in
  the ~2 minute N100 closure install that the sibling D477 investigation is looking at. Nothing is added
  to the closure's dependency tree; the applier is ~200 lines of `node:fs`.
- `patches/` stays the single authority. The shipped copy under
  `dist/closure-patches/` is build output, never committed, and the guard
  compares it to `patches/` byte for byte so the two cannot drift.
- A werift bump is now a three-place change: re-take the patch, move the exact
  pin in `patch-reach.json`, move it in all three declaring packages. The guard
  fails until all three agree. That friction is the point — the alternative is
  the eight weeks this record is about.
- The applier is a hand-written unified-diff applier, which is a real risk, so
  it is **strict and content-addressed**: line numbers are ignored, a hunk
  applies only when its context+removals occur exactly once, a hunk recognises
  its own output (idempotent under npm re-runs and against the dev tree), a
  version mismatch refuses, and every file is applied in memory and written once
  or not at all. Its spec reverses the repo's own patch onto a copy of the
  installed package and requires the applier's output to equal
  `patch-package`'s **byte for byte** — a "close enough" applier would ship a
  subtly different werift to production.
- The check is wired at **staging**, not at boot. A refused update is safe; a
  refused boot is not, and a closure with no payload at all (any pre-D478
  release) reports nothing missing so that rolling back stays possible.
- `pinsTooMuch` is not a marker anywhere. When asking whether a patch survived a
  bundler, the marker must be an expression the bundler cannot erase.

## Enforcement

`scripts/check-patches-reach-production.ts`, wired into the Repository-guards
step of `.github/workflows/ci.yml` (after `npm run build`, so the dists it greps
exist). Disarm-verified — each branch was confirmed to FAIL with the fix removed:

| Disarm | Guard says |
| --- | --- |
| marker set to `pinsTooMuch` | `packages/system/dist/index.js does not carry "pinsTooMuch" — the patch to moleculer is NOT in what ships` |
| `werift` back to `^0.22.9` in one package | `packages/addon-pipeline declares werift@^0.22.9 — a patched closure dependency must be pinned EXACTLY to 0.22.9` |
| a marker misspelled | `marker … is not an ADDED line of the patch — … making every check that uses it vacuous` |
| a new `patches/*.patch` with no entry | `has no entry in patch-reach.json — every patch must say how it reaches production` |
| a publishable package declares `node-turn` | `reach "dev-only" but the PUBLISHABLE package … declares node-turn` |
| `moleculer` added to `packages/system/vite.config.ts` externals | `a bundled patch must not be an external of the build that carries it` |

Runtime: `findUnappliedClosurePatches`
(`packages/node-root/src/__tests__/closure-patch-assertion.spec.ts`, 6 cases)
and the applier
(`server/backend/src/__tests__/closure-postinstall.spec.ts`, 4 cases —
disarm-verified by making the applier a no-op writer, which turns 2 of them red).

[D343]: adr-0343-a-library-the-server-closure-provides-is-linked-not-copied.md
