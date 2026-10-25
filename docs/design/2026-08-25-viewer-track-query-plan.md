---
title: Plan — DB queries, track media, viewer
date: 2026-08-25
status: proposed
covers:
  - packages/system/src/builtins/device-manager/**
  - packages/addon-post-analysis/src/pipeline-analytics/**
---

# Implementation plan — DB queries, track media, viewer

> **For whoever executes:** use `superpowers:subagent-driven-development` (recommended)
> or `superpowers:executing-plans`. The steps are checkboxes (`- [ ]`).

**Goal.** Close three threads opened on 2026-08-25: the repeated reads on the
DB that remain after the first round, the cause of the missing frames on tracks, and the
queue of viewer work (clip timeline, camera list, translations, face review).

**Architecture.** No new subsystem. Three levers that already exist and have already
shipped: the SQL `columns` projection, the `*Batch` methods, and the per-call-site
census (`pipeline-analytics/store/read-census.ts`). The rest is viewer work.

**Stack.** Node **24** (`package.json` says `>=24`, the Dockerfile starts from
`node:24`, the hub runs 24.19.0 — the "22+" in CLAUDE.md is a minimum threshold left
behind, see Phase 8) / TS 5.7 / Fastify 5 / tRPC v11 / Zod 4 on the hub side;
Expo 54 / RN 0.81 / React 19 on the viewer side. Vitest everywhere.

## Global constraints

They apply to **every** task, without repeating them:

- **Never** open the production DB with `sqlite3` — not even `mode=ro`, not even
  a SELECT (corruption 2026-08-19). Only tRPC, or the tars in
  `/mnt/cache/appdata/camstack/backups/`.
- **Never** mint a token. The CLI token is only `scratchpad/.tok-cli`.
- **Never** `git add -A`, **never** `git stash`, **never** `--no-verify`. The tree is
  shared: explicit pathspecs.
- **Never** touch the `the reference NVR` container.
- Every log line about a device carries `tags: { deviceId }`, numeric id.
- No casts (`as any`, `as unknown as X`). Named types, never inline.
- Touching a `*.cap.ts` ⇒ `npm run codegen` in the same commit.
- **biome** formatting. The pre-commit hook exceeds 2 minutes: commit in the
  background.
- **A green suite is not proof**: when you close a gate, remove the fix and
  verify that the test fails.

## Shipping cost — choose it before starting a task

| What changes | How it reaches production |
| --- | --- |
| only an addon's `src` | `camstack deploy packages/<addon>` |
| `@camstack/system`, `@camstack/types`, a `*.cap.ts`, the generated routers | `Publish Packages` train → `serverManagement.applyServerUpdate` on **agents first, hub last** |
| manifest `placement`, image seed | image rebuild |

---

## Phase 0 — Measurements that unblock the rest

Two tasks here produce numbers, not product code. They come first because
**three later tasks cannot be written without their result**, and
this session has already paid half a day, twice, for attributions deduced
from the shape of the code instead of measured.

### Task 0.1 — Attribute the 4,149 boot `listAll` calls

**Known measurement:** 66 s boot window, `query device-manager:devices` with
shape `SELECT … ORDER BY "deviceId" ASC LIMIT ?` → **4,149 calls, 4,219,533
rows**. Steady state: 39 calls/min. The comment in `device-queries.ts` already says
"~3,000 for a boot of 974 devices" but **does not name the caller**.

**Already excluded** (read, they are boot one-shots, not thousands):
`device-manager.addon.ts:521` (`idToAddonId`), `device-bindings-store.ts:504`
(`getAllBindings`).

**Files:**
- Create: `packages/system/src/builtins/device-manager/fleet-read-census.ts` <!-- drift-ok -->
- Create: `packages/system/src/builtins/device-manager/__tests__/fleet-read-census.spec.ts` <!-- drift-ok -->
- Modify: `packages/system/src/builtins/device-manager/device-row-store.ts` (inside `list()`)

**Interfaces produced:** `FleetReadCensus` with `arm(ms)`, `record(site)`,
`rows(): ReadonlyArray<{ site, calls }>`, `siteOf(fn)`. Same shape as
`StoreReadCensus` in `pipeline-analytics/store/read-census.ts` — **read it and
copy its structure**, including the fact that when disarmed it is a guard and a
comparison, and that `armMs: 0` READS the already-closed window instead of re-arming.

- [ ] **Step 1 — failing test.** The disarmed census records
      nothing; armed, two `listFleet()` calls from the same caller produce ONE row
      with `calls: 2`; different callers produce different rows.
- [ ] **Step 2 — run it, it must fail** on a nonexistent module.
- [ ] **Step 3 — implement** `fleet-read-census.ts` and hook it into
      `DeviceRowStore.list()`. Capture the stack ONLY when armed.
- [ ] **Step 4 — green.**
- [ ] **Step 5 — commit**, train, `applyServerUpdate` (agent → hub).
- [ ] **Step 6 — MEASURE.** Arm before a hub restart, read after the
      boot. Write the numbers in (planning repo: sessions/sessions.md). <!-- drift-ok: moved to the private planning repo -->

**Expected outcome:** the name of the caller that makes 4,149 fleet reads. The fix
lives in Task 1.1 and **must not be written before this number**.

### Task 0.2 — Why the native captures are missing (use Loki, not the ring)

**Correction to a previous UNKNOWN:** the 2026-08-25 audit could not
answer because `logs.query` keeps ~35 minutes. **Local Loki has the history** —
verified: the `key-frame` lines go back at least 12 h (~2,000 in the
window). The helper is `~/.claude/homelab/bin/hl`; available labels:
`job`, `hostname`, `node`, `level`, `service_name`, `source`.

**Numbers to explain** (1,859 video tracks, 29 cameras): 12.7% zero media, 31.4%
without a native `keyFrame`, 22.5% without a `firstFrame`, 27.6% without a `lastFrame`.
Known correlation: duration (median 5.1 s / 14 positions on the zero-media tracks against
14.4 s / 46 on the healthy ones). **It is a correlation, not a mechanism.**

Already measured and **excluded**: multi-track pressure (overlap 0.59 vs 0.61),
cold session (13% vs 17%), single camera, single hour.

- [ ] **Step 1** — `hl loki-query` over 12 h for the `key-frame-metrics.ts` lines,
      grouped by device. `key-frame-metrics.ts` ALREADY computes
      `nativeMiss` / `ramTier` / `error` / `skippedNodeOffline` per device: the
      question is which one dominates.
- [ ] **Step 2** — cross with the zero-media tracks by `deviceId` and time
      window.
- [ ] **Step 3** — write the outcome in (planning repo: sessions/sessions.md). If Loki does not <!-- drift-ok: moved to the private planning repo -->
      cover the right lines, **say so** and move on to Task 2.1 (expose the metrics
      as a debug action) instead of guessing.

**Task 2.4 depends on this and must not be started before.**

---

## Phase 1 — The repeated reads that remain

The operator's criterion, verbatim: *"ogni chiamata pesante e ripetuta che conta
centinaia di chiamate o righe non deve esistere. Ogni query deve essere puntuale,
filtrata il più possibile."* [no heavy, repeated call that counts hundreds of calls or rows should exist. Every query must be targeted, filtered as much as possible.] A read below that threshold is **not** a defect
just because it is slow; one above it is, even if it costs little.

All the numbers below come from the live profiler, 60 s window, `busyPct=1`,
6,116 calls total (2026-08-25, after the first round of fixes).

### Task 1.1 — The boot `listAll` — **blocked by Task 0.1**

Do not write code here before having the caller's name. The operator's
bar: *"va bene una per device ma non migliaia"* [one per device is fine but not thousands] — so the shape of the
fix will almost certainly be one of these two, and which one depends on the measurement:

- if it is **a subscriber that rebuilds a snapshot per event**: coalesce
  the boot events into a single rebuild (debounce on the boot, not per
  call), or
- if it is **a per-device loop**: `listFleet({ deviceIds })`, which already exists.

### Task 1.2 — `get device-manager:devices`: 1,656/min, 17,687 at boot

One row per call ⇒ it is a primary-key lookup repeated in a loop.
Identical anti-pattern to the one `readDeviceStoreBatch` has already removed
elsewhere.

**Files:**
- Modify: `packages/system/src/builtins/device-manager/device-row-store.ts`
- Test: `packages/system/src/builtins/device-manager/__tests__/device-row-store-filtered.spec.ts`

**Interfaces produced:** `DeviceRowStore.getMany(ids: readonly number[]): Promise<ReadonlyMap<number, DeviceRow>>`.

- [ ] **Step 1** — test: `getMany([2,4])` makes **one** query with
      `whereIn: { deviceId: [2,4] }`, returns one entry for every id asked
      (absent ⇒ the key is missing, not a fake row), and `getMany([])` does not
      query at all.
- [ ] **Step 2** — red.
- [ ] **Step 3** — implement on `list()`, reusing `listFleet`.
- [ ] **Step 4** — green.
- [ ] **Step 5** — find the callers that loop over `rows.get(` and convert them. One
      at a time, one commit each.
- [ ] **Step 6** — commit + train + node update. Re-measure with the profiler and write
      the before/after.

### Task 1.3 — `query addon-device-settings`: 468/min × **77 rows** = 36k rows/min

**This is a debt introduced today**, by `readDeviceStoreBatch` in
`settings-door-view.ts`: it scans the whole `<addonId>:` prefix and then filters in
JS on the requested ids. The comment in the code declares the trade ("the ids of a
listing are not contiguous, a range per id would be a query per id") — correct
when the ids are many, wrong when they are eight.

- [ ] **Step 1** — test: below an id threshold (propose 32, justify it in the
      comment) the batch emits a range per id instead of a prefix scan;
      above it, the scan stays. Both return the same result.
- [ ] **Step 2** — red. **Step 3** — implement. **Step 4** — green.
- [ ] **Step 5** — commit + train + update.

### Task 1.4 — `get recorder:recording-configs`: 1,124/min, 530 rows

Fewer than half find anything: ~594 calls/min ask the disk whether a config
exists and the answer is no. Same case as `readDeviceBlob`, in another addon.

- [ ] **Step 1** — find the caller with a per-call-site census (reuse
      `read-census.ts`, it is already in the `addon-post-analysis` bundle; for the
      recorder replicate the same shape). **Do not guess.**
- [ ] **Step 2** — if it is a per-device poll, mirror the state in memory and
      invalidate it on write (D224: the window belongs to the READER, and
      **every writer in the same process invalidates**).
- [ ] **Step 3** — test, implementation, commit, addon deploy.

### Task 1.5 — `get pipeline-analytics:addon-settings`: 520/min

Addon-level settings re-read 520 times a minute — a value that
changes only when the operator changes it.

- [ ] Same scheme as 1.4. Attention: **do not** introduce a parallel
      `private cachedX` if the cap already has `runtimeState` (repo rule).

### Task 1.6 — `set device-manager:devices`: 2,358 writes at boot

- [ ] **Step 1** — measure how many are really needed: a write that
      rewrites an identical value is noise. Compare before writing.
- [ ] **Step 2** — if they are idempotent, skip the write when the row does not
      change. A test that pins it: no write for an upsert without differences.

---

## Phase 2 — Track media

Mechanism established on 2026-08-25 (byte proof, SHA-256 on 5 tracks out of 6): the
face crop is **not** derived from a saved frame. It is cut from the
frame decoded in RAM, held in memory for the whole track, written at
close under `ownerKind:'face'`, and then **copied onto the track as its
`thumbnail`** by `copy-face-crop-preview.ts:37` only if the track has none of its
own. That is why *"no photo"* and *"only the face"* are the same failure.

### Task 2.1 — Expose the key-frame metrics (**prerequisite of 2.4**)

`key-frame-metrics.ts` already computes per device `nativeMiss` / `ramTier` / `error`
/ `skippedNodeOffline`, but only emits them in an INFO log that the ring eats.

- [ ] **Step 1** — test of the `debug.keyFrameMetrics` action on the model of
      `debug.storeCensus` (`pipeline-analytics/index.ts`), including the rule
      `armMs: 0` reads, does not re-arm.
- [ ] **Step 2** — red. **Step 3** — implement. **Step 4** — green.
- [ ] **Step 5** — commit + `camstack deploy packages/addon-post-analysis`
      (no train: custom actions do not go through the generated routers).

### Task 2.2 — Make the face-crop copy honest

Today the copy is indistinguishable from a real thumbnail on the wire — which is
exactly the reason the operator opened the case. The size
separates them (real thumbnail p50 ≈ 240 KB, face copy 3–6 KB) but no surface
looks at it.

- [ ] **Step 1** — test: after the copy, the media row carries a marker that says
      "this is a face crop, not a scene frame".
- [ ] **Step 2..4** — red, implement, green.
- [ ] **Step 5** — decide **with the operator** between a new `MediaFileKind` (cleaner,
      but it is `packages/types` ⇒ train) and a stamp on the existing record
      (addon deploy). Do not choose alone: the first costs one more shipping
      round.

### Task 2.3 — `verified` on tracks: why it does not work, and the fix

**Established cause:** `TrackFlagsPatchSchema = z.object(TrackFlagFields)` is a
plain Zod object, and Zod **drops** undeclared keys. `{verified:true}`
is removed before the mutation, which runs with an empty patch and answers **200**.
It is not broken: it silently accepts a nonexistent field. It is the **third** instance
of the same cause on the same day (`columns` on the data-door,
`includeCrops` on the gallery routers).

**Files:**
- Modify: `packages/types/src/capabilities/pipeline-analytics.cap.ts` (`TrackFlagFields`, `TrackFlagsSchema`, `TrackFlagsPatchSchema`)
- Modify: the tracks store (`auditedAt` column)
- Test: new spec on the rejection of the unknown key

- [ ] **Step 1** — test: `setTrackFlags` with an unknown key **rejects**
      (400), does not answer 200. And: a written `auditedAt` can be read back.
- [ ] **Step 2** — red (today it passes with 200).
- [ ] **Step 3** — add `auditedAt` to `TrackFlagFields` + the column, and
      `.strict()` on `TrackFlagsPatchSchema`.
- [ ] **Step 4** — green. **Step 5** — `npm run codegen`.
- [ ] **Step 6** — commit + train + node update.
- [ ] **Step 7** — if **Phase 7** has already been done (recommended order),
      `.strict()` is already in place and this task is just `auditedAt` + the column.
      The ADR on the common cause lives in Task 7.4, not here: two records on the same
      fact are worse than none.

### Task 2.4 — Close the capture hole — **blocked by 0.2 and 2.1**

Do not write the fix before knowing which of `nativeMiss` / `ramTier` / `error`
dominates. The correlation with duration suggests that the retry budget loses the
race on ~5 s tracks, **but it is a hypothesis**, and this session has already
shown twice what it costs to treat one as a conclusion.

---

## Phase 3 — Viewer: clip timeline

### Task 3.1 — Delete the dead clip panel

Verified: `TimelineClipsPanel` is referenced only by itself and by a test
that asserts it is **not** hooked up.

**Delete:** `TimelineClipsPanel.tsx`, `components/camera/clips/ClipRibbon.tsx`,
`components/camera/clips/ClipSourceChips.tsx`, `data/use-clips.ts`, and the orphan
exports `layoutClipRibbon` (`clip-timeline.ts`), `filterClipsBySources`
(`clip-model.ts`), `clipSourceIds` (`clip-mapping.ts`).

**DO NOT delete:** `resolveClipAdvance` — `TheaterTimeline` uses it. And the types
`ClipRibbonLayout` / `EMPTY_RIBBON`, alive.

- [ ] **Step 1** — delete by SYMBOL, not by folder.
- [ ] **Step 2** — update `clip-surface-wiring.spec.ts`: the assertion "the
      panel is not hooked up" becomes meaningless when the file does not
      exist. Replace it with one that pins what remains true.
- [ ] **Step 3** — `npm run ts-check` + `npm run test:v2`.
- [ ] **Step 4** — commit.

### Task 3.2 — Turn on the ruler

**The operator's rule, verbatim:** *"va bene discontinuo finché è continuo
nell'intervallo di una clip."* [discontinuous is fine as long as it is continuous within the span of a clip.] This is exactly what the compressed axis can
honour: inside a clip's block time flows linearly, between one block and the next
there is a declared jump.

Today `TheaterTimeline` passes `hideHourTicks: clipsMode` — the ruler is off on
purpose, because regular hour ticks on a discontinuous axis would lie.

- [ ] **Step 1** — pure geometry test (in `clips/` or `theater/`, where the
      logic is testable without mounting): given N clips, it produces ticks ONLY
      inside the clip intervals, never inside a gap.
- [ ] **Step 2** — red. **Step 3** — implement. **Step 4** — green.
- [ ] **Step 5** — connect to the rendering and replace `hideHourTicks: clipsMode` with
      the discontinuous ruler. Commit.

### Task 3.3 — End time on the clip row

Start and duration are already there; the end is missing.

- [ ] Add the end next to start and duration. One commit.

### Task 3.4 — Three lookback bugs, **three separate tasks**

They are three distinct symptoms and must be treated as three. None of the three is
diagnosed yet: **reproduce first**, with `superpowers:systematic-debugging`.

- [ ] **3.4a** — the latest available videos cannot be viewed.
- [ ] **3.4b** — the index goes back to the top.
- [ ] **3.4c** — on day change the cursor goes back to live for an instant.
      Hint: `TheaterTimeline` does `setLookbackDays(1)` on `[dayFrom]`, and
      `lookback-walk.ts` already documents a past failure precisely at midnight.

### Task 3.5 — Remove `TRACKS_MAX_ROWS` in favour of real pagination

`TRACKS_MAX_ROWS = 5_000` is a mute ceiling: it presents itself to the operator as "the
history ends here". `collectTrackPages` already knows how to walk the pages — the ceiling must be
replaced by on-demand loading, not raised.

- [ ] **Step 1** — test of the behaviour at the limit: once the end of the
      pages is reached, the surface must be able to say "there is more" instead of stopping
      silently.
- [ ] **Step 2..4** — red, implement, green. **Step 5** — commit.

---

## Phase 4 — Viewer: camera list and UX

### Task 4.1 — Overlay on the camera list

A button that opens an overlay with: PTZ controls (only if the camera has them),
linked devices, function enable switches. **Operator constraint:
reuse the existing components.** Before writing, take a census of what already exists
(`accessory-controls/`, `DevicesPanel.tsx`, `CameraSwitchGroup.tsx`).

- [ ] Component census → overlay → wiring test → commit.

### Task 4.2 — Remove the yellow "function disabled" icon

- [ ] Find it, remove it, and verify that the state stays readable elsewhere —
      D62: *a switch that is off must be REPORTED off; disabled must never
      look broken*. If the icon was the only place that said so, its
      place must be taken by the overlay of 4.1, not by nothing.

### Task 4.3 — Function switches: compact component

Buttons with dedicated icons plus a helper with the names. To be designed for use,
not only for density.

- [ ] Propose two variants to the operator **before** implementing.

### Task 4.4 — Haptics on the player's back button

- [ ] One line: `hapticTap()` like the other surfaces. `GlassBackButton.tsx`.

---

## Phase 5 — Viewer: translations

**The fact that decides the project:** tier 1 (`label`) is a **sub-class**
(`van`) — taxonomy, it is translated. Tier 2 (`subLabel`) is an **identity** — the
name assigned by ArcFace, a licence plate — and is **never translated**: translating it
would mangle a person's proper name. The common rendering path is
`subLabel ?? label`: a single field that now holds one, now the other.

The resolver already exists (`data/use-event-kind-resolver.ts`, with `resolveLabel`,
`resolveAudioLabel`, glyphs, fallback to the raw id) and **only three files use it**.

### Task 5.1 — The rule, once

- [ ] **Step 1** — test: `className` and tier-1 `label` go through the resolver;
      tier-2 `subLabel` comes out **verbatim**.
- [ ] **Step 2** — red. **Step 3** — implement in `data/track-events.ts`
      (`displayLabel`, line ~308): it is the derivation that feeds thumbnails,
      events and timeline, so that is where the distinction must be imposed — once,
      not in ten components. **Step 4** — green. **Step 5** — commit.

### Task 5.2 — The sites that bypass the resolver

One per commit, verifying the rendering at each step:

- [ ] `theater/detail/DetectionMetaList.tsx:48` — `d.className`
- [ ] `theater/detail/BoundingBoxOverlay.tsx:49` — `d.label ?? d.className`
- [ ] `theater/detail/ClusterDetailBody.tsx:63` — `ev.label ?? ev.className`
- [ ] `theater/ClusterFanOverlay.tsx:108` — `event.label ?? event.className`
- [ ] `camera/MotionBoxesOverlay.tsx:62` — `box.label`
- [ ] `camera/DiscardedBoxesOverlay.tsx:90` — `box.label`
- [ ] `camera/StationaryBoxesOverlay.tsx:77` — `obj.label ?? obj.className`
- [ ] `groups/GroupDetailModal.tsx:124` — `member.className`
- [ ] `grid/timeline/grid-timeline-lanes.ts:94` — grid lanes

### Task 5.3 — Missing keys

- [ ] Classes without a translation degrade to the raw English id (by design).
      Enumerate those that actually appear on the cluster and add
      `locales/en.json` + `locales/it.json`.

---

## Phase 6 — Face review tab (admin)

Option chosen by the operator: **clustering** (group similar faces, confirm
a whole cluster), falling back to assignment alone if the volume does not hold.

### Task 6.1 — Verify `suggestFaceClusters` before building on it

- [ ] Call it on the live cluster with the real volume. Measure latency and response
      size. **If it does not hold, stop and report** — the fallback is
      "accept/reject the suggestion", which is in any case the case described
      by the operator.

### Task 6.2 — The admin gate

`listIdentities` is already `auth: 'admin'`: the gate exists, it has to be exposed.

- [ ] Test: the tab is not reachable without an admin session. Implement. Commit.

### Task 6.3 — Grid and selection

Grid of unassigned crops, sorted by suggestion confidence
descending — the easy ones on top, so that only the doubtful remain. Each cell: crop,
proposed name, confidence as a **bar** (a `0.83` is not a decision, a
bar is). Tap = select, long tap = preview.

- [ ] Test of the selection logic (pure, without mounting). Implement. Commit.

### Task 6.4 — Bulk actions

The two that do the bulk: **"select all suggested as ‹Name›"** and
**"select above threshold"** with a slider. A single confirmation for the batch.

- [ ] Test, implementation, commit.
- [ ] **Then stop and show the operator** — verbatim request: *"prepara una
      prima versione poi la vediamo insieme."* [prepare a first version, then we will look at it together.]

---

---

## Phase 7 — The bug class: arguments lost between one hop and the next

**This phase exists because three different defects found on 2026-08-25 are the
same defect.** It is worth reading the three together:

1. **`columns` on the data-door.** Declared in `settings-store.cap.ts`, absent
   from `data-store-provider.cap.ts`. The field crosses TWO schemas and Zod
   objects **drop** what they do not declare: it vanished one hop before the engine, silently,
   and the caller concluded that the projection did nothing.
2. **`includeCrops` on the gallery routers.** The cap declared an input; the generated
   router still declared `{ nodeId?: string }` and called
   `p.listIdentities()` — **without arguments**. The flag never reached
   the addon.
3. **`verified` on `setTrackFlags`.** `z.object(TrackFlagFields)` drops unknown
   keys: `{verified:true}` → empty patch → **200**.

The common denominator is what the operator noticed: *every single
caller must explicitly send the argument again*. An argument crosses
cap → generated router → remote proxy/UDS channel → provider, and **every hop must
re-declare and re-forward**. A hop that does not does not fail: it loses the field
and answers 200.

A defect that does not fail is worse than one that does, and this one ate
three in a day. It is worth more than any single query in this plan:
the other phases cost lines, this one costs a CLASS.

### Task 7.1 — Survey the hops, before repairing

- [ ] **Step 1** — map the passages of an argument from the cap to the provider:
      `packages/types/src/capabilities/*.cap.ts` → codegen `scripts/` →
      `server/backend/src/api/trpc/generated-cap-routers.ts` → `createRemoteProxy`
      → UDS channel → provider.
- [ ] **Step 2** — for each, answer in writing: does it **re-declare** the schema or
      inherit it? Does it **forward** all the arguments or name them one by one?
- [ ] **Step 3** — write the outcome in `docs/design/`. A map is needed, not
      an impression: the right fix depends on which hop is the one that loses.

### Task 7.2 — The codegen must not be able to emit a call without arguments

Case 2 is a bug of the **template**, not of the caller: no human wrote
`p.listIdentities()`, the generator did.

- [ ] **Step 1** — codegen test: for every method with a non-empty input, the
      generated router must use `<cap>.methods.<m>.input` **and** pass `input`
      to the provider. A method with an input that generates a zero-argument call is
      a **test failure**.
- [ ] **Step 2** — red on a constructed case. **Step 3** — fix the template.
      **Step 4** — green. **Step 5** — `npm run codegen`, verify that the diff is
      only the fix. Commit.

### Task 7.3 — Parity guard between schemas that proxy each other

`data-door-schema-parity.spec.ts` covers ONE pair, by hand. There are others.

- [ ] **Step 1** — a guard in `scripts/` that finds every schema that proxies
      another (same method name on two caps, like `query` on
      `settings-store` and `data-store-provider`) and asserts field parity.
- [ ] **Step 2** — wire it into `.github/workflows/ci.yml`. Repo rule:
      *prefer a guard to a paragraph* — a rule nobody checks
      has already been broken somewhere.
- [ ] **Step 3** — fix what the guard finds. One commit per pair.

### Task 7.4 — An unknown key must fail, not vanish

- [ ] **Step 1** — survey the **input** and **patch** schemas that today are
      permissive `z.object(...)`. Distinguish: a WRITE input must be
      `.strict()` (a typo is a 400); a READ input may stay permissive
      **on purpose** — `LinkedCamerasCache` relies on Zod dropping
      `isCamera`/`projection` against an older hub, and that is deliberate
      compatibility, not a defect. **Do not convert everything blindly.**
- [ ] **Step 2** — a test for each: unknown key ⇒ 400.
- [ ] **Step 3** — `.strict()` where the write requires it. Commit + codegen +
      train.
- [ ] **Step 4** — **ADR**: *"una patch parziale non è una patch permissiva"* [a partial patch is not a permissive patch], with
      the three cases as proof. It replaces the ADR planned in Task 2.3, which must be
      deleted from there so as not to have two on the same fact.

---

## Phase 8 — Weigh the Node upgrade (**last, and it is not a fix**)

**First of all, a clarification: we are not on Node 22.** The number was mine, and
it was wrong — I took it from CLAUDE.md, which says "Node.js 22+" as a **minimum
threshold** and has been left behind. The reality measured on 2026-08-25:

| Where | Version |
| --- | --- |
| `package.json` → `engines.node` | `>=24` |
| `Dockerfile` | `FROM node:24` |
| `Publish Packages` workflow | `NODE_VERSION: 24` |
| production hub (`nodeRuntimeVersion`) | **24.19.0** |
| Development Mac | 24.17.0 |

So the work here is not "upgrade from 22": it is **deciding whether to move up within
the 24 line or beyond**, and aligning the documentation that lies.

### Task 8.1 — Fix CLAUDE.md (free, do it anyway)

- [ ] `camstack-server/CLAUDE.md` says "Node.js 22+" while `engines` requires
      `>=24`. A wrong line in CLAUDE.md is worse than an absent one: it is the first
      thing every session reads, and I just copied it into a plan.
      Fix it to 24 and commit it on its own.

### Task 8.2 — The real question: which line, and what constrains it

To be answered **in writing before touching anything**, because the cost
is not the bump but what hangs off it:

- [ ] **Step 1** — what is the latest LTS at the time of evaluation, and is 24
      still in Active LTS or has it moved to Maintenance? Do not assume it: look it up.
- [ ] **Step 2** — **the native modules are the constraint, not the runtime.** This
      repo loads `better-sqlite3`, `sharp`, the `nodeav` decoder, `shm-ring`.
      A Node major bump changes `NODE_MODULE_VERSION` and **every** native addon
      has to be recompiled. List which ones have a prebuild for the candidate
      major and which would have to be compiled on the host.
- [ ] **Step 3** — the shipping cost is the maximum possible: Node lives
      **in the image**, so it is an image rebuild + container recreation on
      **three nodes**, not an `applyServerUpdate`. And `imageContract` already reports that
      the hub's seed is behind the contract (baked 1.2.108 against
      1.2.168 running): a rebuild converges that too, which is
      an argument in favour, but only if it is planned and not incidental.
- [ ] **Step 4** — verify on a **throwaway** container before touching
      production. Never on the live `CamStack`.

### Task 8.3 — The decision

- [ ] Bring it to the operator with: the proposed line, which native modules have to be
      recompiled, and what is gained in concrete terms. **If the gain cannot be
      named, the right answer is not to do it** — a runtime bump on an NVR
      with 30 cameras in production has an asymmetric downside, and "being
      up to date" is not a measurable benefit. This phase is last in the plan
      for that reason, not out of laziness.

## Recommended order

0.1 and 0.2 in parallel (measurements, they unblock the rest) → **7.1 → 7.2 → 7.3 → 7.4**
→ 2.3 (which at that point is almost only `auditedAt`, because 7.4 has already made the
patch strict) → 2.1 → Phase 1 in order of volume (1.2 → 1.3 → 1.4 → 1.5 → 1.6) → 1.1
when 0.1 answers → Phase 3 → 6.1 (a check that unblocks or changes Phase 6) →
Phase 5 → Phase 4 → 2.2 and 2.4 when the measurements are in hand.

**Phase 7 goes before the others**, and not because it is more urgent: because every
phase below adds new arguments to the same hops. Doing it afterwards means
shipping more fields through a chain that still loses them silently — and
discovering it, as today, three times in a day.

**Phase 8 goes last**, and could legitimately end with "no".
The only part of it to do anyway is Task 8.1: a wrong line in
CLAUDE.md has already produced an error in this very document.

## What is NOT in this plan, and why

- **Pushing `isCamera` into SQL.** `isCameraDevice` checks for the presence of the
  `getStreamSources` method, not the persisted type: a video doorbell
  answers yes while the row says `doorbell`. A `where: { type: 'camera' }`
  would remove the row precisely for those devices, and `toDeviceInfo` reads
  `name`/`location`/`disabled` from the ROW because the copies on the live device are
  stale. The fleet would keep working while showing the pre-rename names.
- **Slim projection as an allowlist.** `decodeDeviceRow` returns `null` if
  one of the five identity fields is missing and the row disappears from every listing with
  only a warn. The denylist is mandatory.
- **10 s → 60 s segments.** Approved by the operator but a provider method
  "how many consecutive GOPs fit in N bytes" is missing. Flipping it today would silently degrade
  every scrub read.
