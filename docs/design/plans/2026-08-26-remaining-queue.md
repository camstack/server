---
title: Plan — the residual tail after the night of 2026-08-25/26
date: 2026-08-26
status: proposed
---

# The residual tail

Sub-plan of `../2026-08-25-viewer-track-query-plan.md`, written after that
night closed more than expected and opened things that were not expected at all.
It collects **everything that remains**, including the work born from the
measurements rather than from the initial list.

The global constraints of the parent plan apply. In addition, two that this night
earned in the field:

- **Implementation agents work in isolated worktrees and do NOT ship.**
  There is only one git index per working tree: two concurrent `git add`s overlap
  and one commit picks up the other's work. It has already happened (it carries
  one message and contains someone else's work).
- **A rule that makes sense in the abstract must be proven against real data
  before shipping it.** The clip ruler came out mathematically empty because the
  threshold was "at least one minute" and real clips last seconds. The test to
  write is not "the function does what I say", it is "what does it produce on the
  data that exists".

---

## Phase A — The last repeated reads

Status as of 2026-08-26, profiler on the live system, 60 s windows: total down
from ~14,000 to **~3,700–4,400 calls/min**, `busyPct` from 6-14% to **1%**.

The four remaining candidates **all have the same shape**: a `get` per key inside
a loop. Two of them find nothing most of the time, which is the worst version of
the defect — the disk is paid for a negative answer.

| Read | Calls/min | Found | Empty |
| --- | --- | --- | --- |
| `get device-manager:devices` | ~950 | 950 | — |
| `get recorder:recording-configs` | ~770 | ~430 | **~44%** |
| `get pipeline-analytics:addon-settings` | ~640 | 640 | — |
| `get pipeline-analytics:addon-devices` | ~700 | 224 | **~68%** |

### Task A.0 — The boot census (IN PROGRESS, unblocks A.1)

The tool is written, green and committed
(`packages/system/src/builtins/device-manager/fleet-read-census.ts`). It is armed
by `CAMSTACK_FLEET_READ_CENSUS_MS` because the storm happens at BOOT and no debug
action can arrive in time.

- [ ] Train published, `applyServerUpdate` on the three nodes (agent first, hub
      last).
- [ ] Set the variable on the hub container and **restart** (authorised by the
      operator).
- [ ] Read the `fleet read census` line — it is logged, so it ends up in Loki and
      survives the 35-minute ring.
- [ ] Write the numbers in (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

### Task A.1 — The 4,149 boot `listAll` calls — **blocked by A.0**

Do not write code before having the caller's name. The operator's criterion:
*"one per device is fine but not thousands."* The shape of the fix depends on the
measurement: coalesce the boot events into a single rebuild, or
`listFleet({ deviceIds })`, which already exists.

### Task A.2 — `get device-manager:devices`, ~950/min

`getMany(ids)` exists (`DeviceRowStore`) and two callers have already been
converted. Some remain.

- [ ] Enumerate the remaining `rows.get(` calls in loops. **Measure, do not
      deduce**: two attributions deduced from the shape of the code cost half a
      day each in this repo.
- [ ] Convert one per commit, with the `@camstack/system` suite green at every
      step.

### Task A.3 — `get recorder:recording-configs`, ~44% empty

- [ ] Find the caller with a per-call-site census (replicate the shape of
      `read-census.ts` in the recorder).
- [ ] If it is per-device polling: mirror in memory and invalidate **on every
      write of the same process** (D224 — the window belongs to the READER, and
      the writer invalidates). Do not introduce a parallel `private cachedX` if
      the cap already has `runtimeState`.
- [ ] Addon deploy, no train.

### Task A.4 — `get pipeline-analytics:addon-settings`, ~640/min

Addon-level settings, re-read hundreds of times per minute, which change only
when the operator changes them.

- [ ] Same scheme as A.3.

### Task A.5 — `get pipeline-analytics:addon-devices`, ~68% empty

This is `readDeviceBlob`, already reduced from 6,133 to 524/min. The remaining
~700 find something 224 times.

- [ ] The census is **already installed** in this addon (`debug.storeCensus`):
      arm it and read, do not guess.

---

## Phase B — Track media

Established mechanism: `cutSubjectTiles()` releases the frame **before**
`emitInferenceResult()`, and the keyFrame request is a consequence of that emit.
So `holdFrames` does not govern the ordinary path and **every keyFrame that lands
rides an ORPHAN lease entry**.

> ⚠ Rejecting an already-released frame — an obviously correct cleanup — would
> bring the landing rate from 50% to ~0. It is also written in
> `2026-08-13-native-lease-two-tier-redesign.md` §14.

**Operator decision: `holdFrames` is NOT raised.** Raising it masks the problem.
The code is attacked.

### Task B.1 — Instrument the ~825 blind ms

The fetch round-trip is 18 ms p50; the runner 239–328 ms. About 825 ms remain on
the hub between `emitInferenceResult` and `persistKeyFrames`, on a path of eight
`await`s that **nobody measures**.

- [ ] Stamp `emittedAt` on the inference result event.
- [ ] `queueWaitMs` per kind on the scheduler's window line.
- [ ] Addon deploy. **It is the prerequisite of B.3**: without numbers, every fix
      is unverifiable.

### Task B.2 — `staleAfterMs` on the keyFrame request

33% of capture requests never start (per-device lane at the cap of 24 on 17
cameras out of 20), and a keyFrame request does not set `staleAfterMs`: it queues
and runs late instead of being discarded immediately.

- [ ] Test, implementation, addon deploy.

### Task B.3 — Close the hole — **blocked by B.1**

### Task B.4 — Make the face-crop copy honest

The face crop is copied onto the track as `thumbnail` when the track has none of
its own, and it is **indistinguishable from a real thumbnail** on the wire — the
reason the operator opened the case. Size tells them apart (240 KB versus 3–6 KB)
but no surface looks at it.

- [ ] **Operator decision**: a new `MediaFileKind` (cleaner, but
      `packages/types` ⇒ train) versus a stamp on the record (addon deploy).

### Task B.5 — `auditedAt` on tracks

`setTrackFlags({flags:{verified:true}})` answers **200 without writing**: Zod
drops the unknown key. It needs the field, the column, and `.strict()` on the
nested patch (Phase 7.4).

---

## Phase C — Viewer

### Task C.1 — The three lookback bugs (IN PROGRESS)

Latest videos not viewable · index that jumps back to the top · cursor that
flickers live at the day change. Three symptoms, three tasks.

### Task C.2 — Overlay on the camera list

A button that opens PTZ (if the camera has it), linked devices, function enable
switches. **Constraint: reuse the existing components** — enumerate
`accessory-controls/`, `DevicesPanel.tsx`, `CameraSwitchGroup.tsx` before
writing.

- [ ] Remove the yellow disabled-function icon — but D62: *an off switch must be
      REPORTED off; disabled must not look broken*. If that icon was the only
      place saying so, the overlay takes its place, not nothing.

### Task C.3 — Compact function switches

Buttons with dedicated icons plus a helper with the names.

- [ ] **Propose two variants to the operator before implementing.**

### Task C.4 — Face review tab (admin)

Chosen option: **clustering**, falling back to assignment only if the volume does
not hold.

- [ ] Verify `suggestFaceClusters` on the real volume **before** building on it.
      If it does not hold, stop and report.
- [ ] Admin gate (`listIdentities` is already `auth: 'admin'`).
- [ ] Grid sorted by decreasing confidence, confidence as a **bar** (a `0.83` is
      not a decision).
- [ ] Bulk actions: "select all suggested as ‹Name›" and "select above
      threshold".
- [ ] **Stop and show** — verbatim request: *"prepare a first version then we
      look at it together."*

---

## Phase D — The rest of Phase 7

`docs/design/plans/phase-7-topics-lost-between-hops.md`, already rewritten after
the hop map disproved three tasks out of four.

- [ ] **7.3** — a registered provider must be verified against
      `InferProvider<cap>`. Today `ProviderRegistration.provider` is typed
      `object`: it is the REAL cause of the loss of `columns`.
- [ ] **7.4** — `.strict()` on the NESTED write schemas. The top level is
      permissive by construction (it carries `nodeId`/`addonId`) and tightening
      it breaks routing. And `.strict()` breaks clients **newer** than the hub,
      not only old nodes.
- [ ] **7.5a** — `addonId` has no field in the hub→agent envelope: provider
      selection for grouped runners works on the hub and not on the agent.
- [ ] **7.5b** — `ipcChildLink` does not honour `nodePin`, the third instance of
      a family already fixed twice. It has a spec that passes on dead code:
      delete it or repair it, do not leave it.
- [ ] **7.5c** — IN PROGRESS (`internal: true` acts as the floor for `admin`).
- [ ] **7.5d** — `provider[method]?.()` returns 200 on a missing method, while
      `child-cap-dispatch.ts` throws.

---

## Phase E — Infrastructure

### Task E.1 — CI, now that it is back on

Re-enabled on 2026-08-26 after five days. The nx cache was restored after the
`git clean` of `actions/checkout` (it was the cause of the 7-8 min builds and
13-14 min typechecks: `"cache": true` had **never** been effective on that
runner), and the lockfile trap on `nx affected` was closed.

- [ ] Watch the first red and repair it, instead of switching it off again. It is
      how it ended up off the first time.
- [ ] **A guard so it does not recur**: something that notices CI has not run for
      N days. A disabled workflow is invisible by construction — it does not
      fail, it stays silent. The header of `ci.yml` already warned about the
      recurrence in writing and did not prevent it, because it was a note.

### Task E.2 — Node — **may conclude with a NO**

We are not on 22: `engines` requires `>=24`, the Dockerfile starts from
`node:24`, the hub runs 24.19.0. The constraint is not the runtime but the native
modules (`better-sqlite3`, `sharp`, `nodeav`, `shm-ring`), and the cost is an
image rebuild on three nodes.

- [ ] If the gain cannot be named, the right answer is not to do it.

### Task E.3 — Segments 10 s → 60 s

Approved by the operator some time ago, stalled for a technical reason: a
provider method is missing, "how many consecutive GOPs fit in N bytes". Flipping
them today would silently degrade every scrub read.

- [ ] Add the provider method, then flip.

---

## Recommended order

A.0 (in progress) → B.1 and A.2/A.3/A.4/A.5 in parallel (independent
measurements and conversions) → A.1 when A.0 answers → C.1 (in progress) → D →
C.2/C.3 → C.4 → B.3/B.4 → E.

E.1 has no place in this sequence: it is to be done **when CI complains**, which
is now.
