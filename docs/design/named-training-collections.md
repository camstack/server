---
title: Named training collections — still-from-playback
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/retrain/**
  - packages/types/src/capabilities/pipeline-analytics.cap.ts
  - camstack/src/components/camera/theater/**
---

# Named training collections — still from playback

> Status: **implemented 2026-10-08, with a different storage shape** — see
> [D793](../decisions/adr-0793-a-recording-still-is-a-trackless-retrain-frame-and-a-collection-is-a-set-over-the-corpus.md).
> A recording still is a trackless row of the one `retrain-frames` table (not a
> second copy ledger), and a collection is a membership set over that corpus,
> so annotation, completeness and export work on collection frames from day
> one. Rename and delete shipped with V1 (decision 7 below is superseded); the
> theater button in the viewer ships as `SendFrameToTrainingControl` under the
> playback bar (admin-only); the admin recording timeline already has the
> action. The rest of this document is the original proposal.
>
> Original status: **design proposed, V1 scoped thin** (2026-10-03).
> Companion plan: (planning repo: superpowers/plans/2026-10-03-named-training-collections.md).
> Prior census: `docs/design/training-screen.md` (global retrain corpus + admin canvas).

## Intent

An operator scrubbing theater playback wants to **save the current frame into a
named training collection** — not only mark a whole track ★ for the single global
retrain corpus. Today `markForTrain` / Retrain curation address tracks and one
implicit dataset; they do not name corpora or accept a recording timestamp.

## What already exists

| Piece | Role | Gap |
| --- | --- | --- |
| `setTrackFlags` / `markForTrain` | Pin track in `staging` (D81) | Track-level only |
| `pipeline-analytics:retrain-frames` + annotations | One global copy-on-select corpus | No collection name |
| Admin Retrain page | Annotate / export that corpus | No multi-collection UX |
| `GET /addon/recorder/still/<deviceId>/<epochSec>` | JPEG from LOW recording | Not wired into retrain |
| Theater playhead `epochMs` | Viewer knows "now" on the tape | No "add to collection" action |

## Operator-facing decisions (V1)

These are the product choices an implementer must not re-open casually. Correct
them in this document if they change.

1. **Named collections are first-class.** An operator creates a collection with a
   human name (`"packages porch night"`, `"false-positive cars"`). The global
   retrain corpus remains; V1 does **not** migrate existing `retrain-frames` rows
   into a default named collection. Unscoped export stays as today.

2. **Auth is admin.** Creating collections and adding frames is the same privilege
   as Retrain curation (`auth: 'admin'`), not the viewer-level ★ mark. A non-admin
   theater session does not see the button.

3. **Membership is a still at `(deviceId, epochMs)`, not a track.** The primary V1
   ingest is "this moment on this camera's recording." Optional later: attach an
   existing track keyframe (`mediaId`) into a collection. Track ★ staging is
   unchanged and does not auto-join a named collection.

4. **Bytes are owned by the dataset (copy, not reference).** Same D81 rule as
   `selectRetrainFrames`: ingest **copies** JPEG bytes under the `retrain/`
   prefix (or a sibling prefix `retrain-collections/<collectionId>/…`) so retention
   cannot evaporate the training material. A failed still capture is a **named
   refusal**, never a silent skip.

5. **Still source preference for V1.** Prefer `recorder` still at the playhead
   epoch (LOW profile, existing still route / `StillFrameService`). Fallback
   (V1.1): nearest surviving track `keyFrame` within a small window if still
   decode fails — only if the operator is on a track-context surface; theater
   playback without a selected track reports `still-unavailable`.

6. **Annotation is out of V1.** V1 is collect-and-list. Boxes / assist / export
   filtered by `collectionId` are follow-ons that reuse the existing Retrain
   canvas against collection members.

7. **Delete is explicit.** V1 ships create / list / addFrame. Deleting a
   collection or removing a frame is V1.1 (destructive, same pattern as
   `deselectRetrainFrame`).

8. **Names are unique per hub (case-insensitive trim).** Empty names refused.
   No folders / nesting in V1.

9. **Viewer UX (after API).** One theater control: "Add frame to collection…" →
   pick or create collection → toast with named success/refusal. No full
   curation canvas in the viewer in V1.

## Architecture (V1)

```
  theater playhead                 hub (pipeline-analytics)              disk
  ────────────────                 ────────────────────────              ────
  [Add to collection]              createRetrainCollection
    admin only                     listRetrainCollections
          │                        addRetrainFrameFromRecording
          ▼                          { collectionId, deviceId, epochMs }
  mutation ─────────────────────▶  still JPEG (recorder) ──copy──▶ retrain/…
                                   row: retrain-collections
                                   row: retrain-collection-frames
```

### SQLite (logical owner `pipeline-analytics`, engine `sqlite-settings`)

**`pipeline-analytics:retrain-collections`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | UUID |
| `name` | TEXT NOT NULL | unique (normalized) |
| `nameKey` | TEXT NOT NULL | lower(trim(name)) for uniqueness |
| `createdAt` | INTEGER NOT NULL | epoch ms |
| `updatedAt` | INTEGER NOT NULL | epoch ms |

**`pipeline-analytics:retrain-collection-frames`**

| Column | Type | Notes |
| --- | --- | --- |
| `id` | TEXT PK | UUID (= frame id / mediaKey for later annotation) |
| `collectionId` | TEXT NOT NULL | |
| `deviceId` | INTEGER NOT NULL | |
| `epochMs` | INTEGER NOT NULL | playhead requested |
| `path` | TEXT | NULL until bytes land |
| `sizeBytes` / `width` / `height` | INTEGER | NULL until bytes land |
| `sourceKind` | TEXT | e.g. `recordingStill` |
| `status` | TEXT | `pending` \| `ready` \| `refused` |
| `refusalReason` | TEXT | named when refused |
| `copiedAt` | INTEGER | when ready |
| `createdAt` | INTEGER NOT NULL | |

V1 stub may persist collection rows only and have `addFrame` return
`still-capture-unimplemented` until the still path lands — membership rows with
bytes follow in the same plan's later task, not a parallel half-built UI.

### Cap methods (proposed)

All `auth: 'admin'`, on `pipelineAnalytics`:

| Method | Input | Output |
| --- | --- | --- |
| `createRetrainCollection` | `{ name }` | `{ id, name, createdAt, frameCount: 0 }` |
| `listRetrainCollections` | `{}` | `{ id, name, createdAt, frameCount }[]` |
| `addRetrainFrameFromRecording` | `{ collectionId, deviceId, epochMs }` | discriminated `added` \| `refused` |

## Non-goals (V1)

- Viewer annotation canvas / `retrain-core` package (`training-screen.md` Steps 4–5)
- Export filtered by collection
- Auto-staging tracks into a collection when ★ is toggled
- Cross-node still fetch redesign (reuse existing recorder still / recorded-still)
- Changing D81 track lifecycle

## Success criteria

- Operator can create two named collections and list them.
- From theater (admin), playhead frame lands as a ready JPEG member **or** a
  named refusal the UI can show.
- Existing Retrain page and `markForTrain` behaviour unchanged.
