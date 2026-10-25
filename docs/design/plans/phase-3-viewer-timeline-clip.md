---
title: Phase 3 plan — viewer, clip timeline
date: 2026-08-25
status: proposed
---

# Phase 3 — viewer: clip timeline

Sub-plan of `../2026-08-25-viewer-track-query-plan.md`. All the work is in
the `camstack/` submodule (the Expo/React Native viewer).

## Context needed before touching anything

The live surface is **not** `TimelineClipsPanel`: it is `clipsMode` inside
`src/components/camera/theater/TheaterTimeline.tsx`, which renders clips as
CARDS in the normal cluster list. The panel is dead code (Task 3.1).

The axis in clips-mode is **compressed** (`buildClipAxis`): time is discontinuous
between one clip and the next, linear within a clip. That is why today
`TheaterTimeline` passes `hideHourTicks: clipsMode` — regular hour ticks on
that axis would lie.

## Constraints

- The global constraints of the parent plan apply.
- Commands: `npm run ts-check`, `npm run test:v2`. CI runs `ts-check` on every push.
- **Every `@types/*` that an import requires must be in THIS `package.json`.**
  The working copy lives inside camstack-server and TypeScript climbs the tree: CI,
  which builds the repo on its own, does not have those types. `@types/react-dom` has already
  been borrowed this way and CI went red on a commit that was green
  locally.
- The viewer ships with `npm run update:patch` (OTA) → `build:orchestrator` →
  `camstack deploy packages/addon-pipeline-orchestrator` → submodule pin.
  **Do not ship**: leave the commits, the main session does the shipping.

---

## Task 3.1 — Delete the dead clip panel

**Verified:** `TimelineClipsPanel` is referenced only by itself and by a
test that asserts it is NOT wired in.

**Delete:**
- `src/components/camera/theater/TimelineClipsPanel.tsx`
- `src/components/camera/clips/ClipRibbon.tsx`
- `src/components/camera/clips/ClipSourceChips.tsx`
- `src/data/use-clips.ts` (`useCameraClips`)
- orphaned exports: `layoutClipRibbon` (`src/clips/clip-timeline.ts`),
  `filterClipsBySources` (`src/clips/clip-model.ts`), `clipSourceIds`
  (`src/clips/clip-mapping.ts`)

**Do NOT delete:**
- `resolveClipAdvance` — used by `TheaterTimeline`
- the `ClipRibbonLayout` / `EMPTY_RIBBON` types — alive
- `src/clips/clips-status.ts` and `ClipsStatusNote` — alive (`TimelineView` imports them)

- [ ] **Step 1** — delete **by symbol**, not by folder. After each
      deletion: `npm run ts-check`.
- [ ] **Step 2** — `src/components/camera/clips/__tests__/clip-surface-wiring.spec.ts`
      contains assertions of the kind "the panel is not wired in". They become meaningless
      when the file no longer exists: **replace them** with assertions about what
      remains true (e.g. that clips-mode does not introduce a second playback
      path), do not just delete them. A rule that nobody checks has already been
      broken somewhere.
- [ ] **Step 3** — `npm run ts-check && npm run test:v2`.
- [ ] **Step 4** — commit.

---

## Task 3.2 — Turn on the ruler

**Operator's rule, verbatim:** *"va bene discontinuo finché è continuo
nell'intervallo di una clip."* [discontinuous is fine as long as it is continuous
within a clip's interval.]

- [ ] **Step 1** — PURE test on the geometry, in a module with no JSX (put it
      next to `src/clips/clip-axis.ts` or `theater/timeline-geometry.ts`, where
      the logic is testable without mounting): given N clips on a compressed axis,
      the function produces ticks ONLY inside the clip intervals and NEVER
      inside a gap. Include the edge case of a clip shorter than the step between
      two ticks.
- [ ] **Step 2** — red.
- [ ] **Step 3** — implement the pure function.
- [ ] **Step 4** — green.
- [ ] **Step 5** — connect it to rendering: replace `hideHourTicks: clipsMode` with
      the discontinuous ruler. The geometry lives in the pure function — the
      component only positions (same principle already documented in
      `ClipRibbon`: this file cannot be mounted at real size in
      tests, so geometry that lived here would be verified by nothing).
- [ ] **Step 6** — commit.

---

## Task 3.3 — End time on the clip row

Start and duration are already there; the end is missing.

- [ ] Add the end next to start and duration on the clips-mode card. One
      commit. Check that it does not overflow in width on long names
      (`numberOfLines`).

---

## Task 3.4 — Three lookback bugs — THREE SEPARATE TASKS

They are three distinct symptoms, none yet diagnosed. **Use
`superpowers:systematic-debugging`: reproduce first, one hypothesis at a time.**

Relevant mechanics, already read:
- `TheaterTimeline`: `lookbackDays` grows by 1 per hit near the bottom, cap
  `MAX_LOOKBACK_DAYS = 30`; `useEffect` does `setLookbackDays(1)` on `[dayFrom]`.
- `src/components/camera/theater/lookback-walk.ts`: the latch, which already
  documents a past failure right at midnight and how it was resolved.
- `use-timeline-scrub.ts`: the near-bottom threshold, with
  `COMPRESSED_LOOKBACK_THRESHOLD_PX = 32` specific to the compressed axis.

- [ ] **3.4a** — the latest available videos cannot be viewed.
- [ ] **3.4b** — the index jumps back to the top.
- [ ] **3.4c** — on a day change the cursor goes back to live for an instant.

One commit per bug, each with a test that fails first.

---

## Task 3.5 — Remove `TRACKS_MAX_ROWS` in favour of real pagination

`TRACKS_MAX_ROWS = 5_000` (`src/data/use-device-tracks.ts`) is a mute ceiling: it
presents itself to the operator as "history ends here". `collectTrackPages` already knows how to
walk the pages — the ceiling must be **replaced** by on-demand loading,
not raised.

- [ ] **Step 1** — test: once the end of the loaded pages is reached, the surface
      must be able to tell "there is nothing more" from "there is more, ask for it". Today
      the two are indistinguishable, and that is the defect.
- [ ] **Step 2** — red.
- [ ] **Step 3** — implement. The criterion: **no silent limit**. If a
      bound remains for memory reasons, it must be LOGGED and made visible to the
      surface, never suffered in silence.
- [ ] **Step 4** — green. **Step 5** — commit.
