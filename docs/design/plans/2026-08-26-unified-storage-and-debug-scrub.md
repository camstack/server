# Plan — unified storage + diagnosable scrub

> **For the implementer:** REQUIRED SKILL — use `superpowers:subagent-driven-development`
> (recommended) or `superpowers:executing-plans`. The steps use checkboxes
> (`- [ ]`) for tracking.

**Goal:** give `eventMedia` the same migration story as recordings
(*mark read-only → drain in the background → no pause*), extract the placement
planner as a shared primitive that is agnostic of storage, and make a scrub
failure diagnosable on the first occurrence instead of the third.

**Architecture:** three independent tracks. **A** is plumbing over engines
already written and tested and unblocks the migration proof. **B** extracts
`placement-planner.ts` — already declared pure — into a shared package, with the
COST OF A MOVE as a caller parameter. **C** closes the observability holes that
made the 2026-08-26 failure unprovable. A and C can start in parallel; B depends
on A.

**Stack:** TypeScript 5.7+, Zod 4, vitest, npm workspaces + nx.

## Global constraints

The rules of `CLAUDE.md` apply. In addition, verbatim:

- **No casts.** No `as any`, `as unknown as X`, `as never`. Exceptions: `as
  const` and a documented type boundary. Use discriminated unions and type guards.
- **`z.infer<>` for Zod schemas** — never duplicate a shape by hand.
- **Named types**: no inline types on signatures or return values.
- **Every log line about a device carries `tags: { deviceId }`** with the numeric
  id. Always the same key, never only in the message text.
- **A branch that silently throws work away logs it.** Silence reads as "it never
  happened".
- **Addons do not import each other.** `ctx.api` is the only layer.
- **`npm run codegen` after every touch to a `*.cap.ts`.** Skipping it is silent
  drift.
- **A green test is not proof.** After every fix, DISARM the fix and confirm the
  test turns red. Report that you did.
- **Never `git --no-verify`, never `git add -A`, never `git stash`.** Explicit
  pathspecs. The tree is shared.
- Production recordings are on a real disk: **no task here touches the production
  hub**. Only code and tests.

## File structure

| File | Responsibility | Track |
| --- | --- | --- |
| `packages/types/src/interfaces/relocate.ts` | `RelocateMediaInput` schema (exists) | A |
| `packages/types/src/capabilities/pipeline-analytics.cap.ts` | expose `relocateMedia` / `listRelocateMediaJobs` / `cancelRelocateMedia` | A |
| `packages/addon-post-analysis/src/pipeline-analytics/index.ts` | implementation of the three + choice of the write location | A |
| `packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts` | **NEW** — resolves the `eventMedia` locations, filters `readOnly` | A | <!-- drift-ok: this plan creates it -->
| `packages/system/src/placement/placement-planner.ts` | **MOVED** from the recorder, pure, parametric on the cost | B | <!-- drift-ok: this plan creates it -->
| `packages/addon-pipeline/src/recorder/addon/placement-planner.ts` | becomes a thin adapter | B |
| `packages/addon-pipeline/src/stream-broker/recorded/recorded-feeder.ts` | `dragId`, reasoned state transitions, commit accounting | C |
| `packages/addon-pipeline/src/stream-broker/recorded/scrub-gesture-record.ts` | **NEW** — records a gesture for replay | C | <!-- drift-ok: this plan creates it -->

---

## Track A — `eventMedia` earns the no-pause road

### Task A1: the write side knows `readOnly`

Today in the whole of `pipeline-analytics` **`readOnly` does not appear even
once** (verified 2026-08-26). The recorder, on the other hand, reads it like this,
and this is the shape to mirror — `recorder/addon/roots.ts`:

```ts
readOnly: l.config['readOnly'] === true,
…
const writable = locations.filter((l) => !l.readOnly)
```

**Files:**
- Create: `packages/addon-post-analysis/src/pipeline-analytics/media-locations.ts` <!-- drift-ok: this plan creates it -->
- Create: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/media-locations.spec.ts` <!-- drift-ok: this plan creates it -->
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/index.ts` (where
  `mediaLocationStorage` is built, near `invalidateRoots()`)

**Interfaces:**
- Produces: `pickWritableMediaLocation(locations, currentDefaultId): string | null`
- Consumes: the location list from `storage.listLocations({ type: 'eventMedia' })`

- [ ] **Step 1 — write the failing test.**

```ts
import { describe, it, expect } from 'vitest'
import { pickWritableMediaLocation, type MediaLocation } from '../media-locations.js'

const loc = (id: string, readOnly: boolean, enabled = true): MediaLocation => ({
  id, readOnly, enabled, headroomBytes: 1_000,
})

describe('pickWritableMediaLocation', () => {
  it('does not write to a location marked readOnly — it is the operator drain', () => {
    const picked = pickWritableMediaLocation([loc('old', true), loc('new', false)], 'old')
    expect(picked).toBe('new')
  })

  it('keeps the default as long as it is writable — no free bouncing', () => {
    const picked = pickWritableMediaLocation([loc('a', false), loc('b', false)], 'a')
    expect(picked).toBe('a')
  })

  it('answers null when NONE is writable instead of picking at random', () => {
    // The caller must be able to log and refuse. Returning a readOnly one anyway
    // would make every write fail with a filesystem error, much farther from the
    // cause.
    expect(pickWritableMediaLocation([loc('a', true)], 'a')).toBeNull()
  })

  it('skips a disabled location even if writable', () => {
    expect(pickWritableMediaLocation([loc('a', false, false), loc('b', false)], 'a')).toBe('b')
  })
})
```

- [ ] **Step 2 — run it and verify it FAILS.**
      `npx vitest run --root packages/addon-post-analysis media-locations`
      Expected: `Cannot find module '../media-locations.js'`.

- [ ] **Step 3 — implement the minimum.**

```ts
/**
 * Which `eventMedia` location receives the NEXT blob.
 *
 * Why the recordings planner is not needed: there the unit is an ffmpeg writer
 * bound to a directory, and moving it costs a restart and a recording gap — hence
 * hysteresis and stickiness. Here every blob is an independent write, so the
 * choice can be per-blob and has no move cost. See track B: the shared primitive
 * is the choice ENGINE, the cost is a parameter.
 */
export interface MediaLocation {
  readonly id: string
  /** `config.readOnly` — operator drain: it is still READ, not written. */
  readonly readOnly: boolean
  /** `StorageLocation.enabled`; absent means active. */
  readonly enabled: boolean
  readonly headroomBytes: number
}

export function pickWritableMediaLocation(
  locations: readonly MediaLocation[],
  currentDefaultId: string,
): string | null {
  const writable = locations.filter((l) => l.enabled && !l.readOnly)
  if (writable.length === 0) return null
  // Minimal stickiness: the default stays as long as it is writable. Changing on
  // every blob would scatter one event over two disks with no gain.
  const keep = writable.find((l) => l.id === currentDefaultId)
  if (keep) return keep.id
  return writable.toSorted((a, b) => b.headroomBytes - a.headroomBytes)[0]?.id ?? null
}
```

- [ ] **Step 4 — run: green.**
- [ ] **Step 5 — verify the test is LOAD-BEARING.** Remove `&& !l.readOnly`,
      re-run, confirm red, restore. Report it.
- [ ] **Step 6 — wire it in `index.ts`.** Where the `eventMedia` default is
      resolved, go through `pickWritableMediaLocation`. If it returns `null`,
      **log at `error`** with `tags: { deviceId }` when a deviceId is in scope
      and refuse the write with a message naming the locations seen — do not let
      it fail as a filesystem error much farther downstream.
      Do NOT introduce an RPC per blob: the write provider is a
      `no-RPC-per-blob` bypass; resolve and cache as
      `location-aware-media-storage.ts` already does, invalidating on
      `invalidateRoots()`.
- [ ] **Step 7 — commit** (`fix(analytics): il lato scrittura dei media conosce readOnly`).

### Task A2: expose the mover as an admin mutation, without a lease

`MediaRelocateEngine` **already exists**, is tested and has the safe order (write
to destination → stamp `row.locationId` → delete the source). Today it is
reachable only from `startStorageMigrationMove`, which checks the lease:

```ts
if (this.storageMigrationLeaseId !== input.leaseId) {
  throw new Error('event-media storage migration lease does not match')
}
```

The twin of `recording.relocateFootage` is needed: same engine, no lease.
`RelocateMediaInputSchema` already exists (`{ toLocationId, throttleMbps? }`) — it
is `StorageMigrationMediaMoveInputSchema` that extends it with the `leaseId`, so
the schema without a lease is already there and **must not be created**.

**Files:**
- Modify: `packages/types/src/capabilities/pipeline-analytics.cap.ts`
- Modify: `packages/addon-post-analysis/src/pipeline-analytics/index.ts`
- Create: `packages/addon-post-analysis/src/pipeline-analytics/__tests__/relocate-media-api.spec.ts` <!-- drift-ok: this plan creates it -->

- [ ] **Step 1 — failing test**: `relocateMedia` starts a job without a lease;
      `startStorageMigrationMove` keeps REJECTING a wrong lease (the second half
      is a regression not to cause).
- [ ] **Step 2 — red.**
- [ ] **Step 3 — declare in the cap**, next to the `*StorageMigration*`:

```ts
/**
 * Moves event media between locations — the OPERATOR's mover, without the
 * coordinator's lease. Twin of `recording.relocateFootage`: the same engine the
 * coordinated migration uses, drivable in the background and WITHOUT stopping
 * anything. It exists because `eventMedia` was the only storage class whose only
 * road went through the global pause.
 */
relocateMedia: method(RelocateMediaInputSchema, z.object({ jobId: z.string() }), {
  kind: 'mutation',
  auth: 'admin',
}),
listRelocateMediaJobs: method(z.object({}), z.array(RelocateJobSchema).readonly(), {
  kind: 'query',
  auth: 'admin',
}),
cancelRelocateMedia: method(z.object({ jobId: z.string() }), z.object({ cancelled: z.boolean() }), {
  kind: 'mutation',
  auth: 'admin',
}),
```

- [ ] **Step 4 — implement** reusing `this.mediaRelocate`. `relocateMedia` must
      NOT touch `storageMigrationLeaseId`.
- [ ] **Step 5 — `npm run codegen`.** Mandatory: you touched a `*.cap.ts`.
- [ ] **Step 6 — green** + **load-bearing check** (remove the method from the cap
      and confirm red).
- [ ] **Step 7 — commit** and update
      `docs/design/2026-08-26-low-events-storage-migration-to-ssd.md`: the
      "background road" table still says *none* for `eventMedia`, and after this
      task it is **false**. A table that describes the right design and is not
      true reads as verification.

---

## Track B — the planner becomes a shared primitive

`placement-planner.ts` already declares itself pure: *"No clock, no rotation
state, no I/O"*, and its candidates are already `{ locationId, type,
headroomBytes }` — that is, **agnostic of what you write into them**. It is not a
recordings planner: it is a placement planner used only by recordings.

**What must NOT be flattened.** Stickiness exists for a reason written in its
header: *"each move costs a writer restart and a recording gap"*. Event media do
not have that cost. If you unify that too, `eventMedia` inherits a hysteresis it
pays for without reason.

- [ ] **Task B1** — move the planner to `packages/system/src/placement/` <!-- drift-ok: this plan creates it -->
      **without changing its behaviour**. Move its tests too. The file in the
      recorder becomes an adapter that re-exports. Separate commit, so a bisect
      distinguishes "moved" from "changed".
- [ ] **Task B2** — introduce `moveCost` in the signature: `'high'` (default,
      recordings: current hysteresis and stickiness) and `'free'` (media: no
      hysteresis, pick the best). Existing tests must pass **unchanged** under
      `'high'` — if they change, the refactor changed behaviour and must be
      redone.
- [ ] **Task B3** — make `pickWritableMediaLocation` of Task A1 use the
      primitive, with `moveCost: 'free'`. The A1 tests stay green unchanged.

> **Do not start B before A is merged and verified live.** B is a refactor with
> no visible gain; doing it first means changing the planner while nobody has yet
> exercised the new road.

---

## Track C — a scrub failure explains itself on the first occurrence

On 2026-08-26 two commits produced `playback:intent` without `playback:ready`,
with the feeder stuck on `loading`. The cause was **not proven**, and the reason
is all in here.

### Task C1: a `dragId` shared between app and feeder

**The defect that blocked the investigation.** The `[app:*]` lines carry the
phone's `clientTs`, the feeder's lines carry the hub clock: the two sources are
**not orderable against each other**. The feeder logs `sessionId` on every line;
the app does not — it carries only `deviceId` and `epochMs`.

An id generated by the app at the start of the gesture and passed to
`scrubStart`, then printed on EVERY line on both sides, joins
`intent → drag-end → ready` **without depending on any clock**. It solves the
problem at the root instead of chasing skew.

- [ ] Test: two overlapping gestures produce lines with different `dragId`s, and
      every line of one gesture carries only one.
- [ ] Propagate through `beginScrub` / `scrubTo` / the `seek` commit.
- [ ] On the viewer side, generate it where the gesture is born and carry it onto
      `scrubStart`, `commitScrub`, `playback:intent`, `playback:ready`.

### Task C2: state transitions say WHY

Today: `recorded: feeder state = loading`. A bare string that says neither where
it came from, nor for what reason, nor with which `seekToken` — and a stuck state
is exactly the case in which those three things are the answer.

- [ ] `onState` becomes `{ from, to, reason, seekToken, dragId }`.
- [ ] Test: a state stuck on `loading` is reconstructible from the lines alone.

### Task C3: every commit closes with an accounting

`scrub-feeder:drag-end` is very rich but it covers the DRAG. The failure was in
the **commit**, and there only `recorded:seek-ready` exists, which is written only
on success. `recorded:seek-abandoned` (added 2026-08-26) is half the work.

- [ ] One line per commit that is ALWAYS written, whatever the outcome: served,
      abandoned, superseded, in gap. With `dragId`.
- [ ] Test: no path through the commit can end without the line.

### Task C4: record and replay a gesture

The most expensive and the most conclusive. A scrub is a deterministic sequence of
`(target, instant)`; today every investigation is archaeology on the logs.

- [ ] `scrub-gesture-record.ts`: ring buffer of the last N gestures (`dragId`,
      target, timings, outcomes), exposed by an admin query.
- [ ] A test helper that replays a recorded gesture against the existing harness
      in `__tests__`.
- [ ] Test: the 2026-08-26 gesture — 26 ticks, commit on 09:31:56 — replays and
      produces the same census.

> Do C4 LAST. It has value only after C1: without `dragId` a recorded gesture
> cannot be matched to the lines describing its failure.

---

## Out of scope, on purpose

- **Do not touch `scrub-prefetch.spec.ts` nor put a directional speculation
  back.** Removed on 2026-08-26 on measurement: 25 speculative reads, 3 hits. The
  `prefetch*` counters stay on the line at zero on purpose.
- **Do not change the segment duration.** Decided and motivated elsewhere.
- **Do not touch the migration coordinator's pause.** Track A bypasses it for
  `eventMedia`; changing the state machine is its own job.
- **Do not touch `hl loki-query`** (it silently truncates at 1000 lines — a real
  trap, but it is operator tooling, not this repo).

## What remains unknown and must be measured, not assumed

- **Whether the `beginScrub` hazard is the real cause** of the 2026-08-26
  stall. `beginScrub()` bumps `seekToken` without announcing anything, and its
  guard does not cover the commit window because the commit sets
  `scrubbing = false` before going to disk. It is a real hazard in the code;
  **it is not proven** that it was this one. C1+C3 make it decidable at the next
  occurrence. **Do not "fix" it before having seen it**: a first hypothesis on
  this very bug (`loaded === null` as a mute branch) has already been written,
  tested and discarded as unreachable.
- **The 17 `warm-start`s in ten seconds** (fillGen 2→18) observed on 2026-08-26.
  That is a lot. They need looking at, but separately.
