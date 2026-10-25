# Face Gallery & Detection Intelligence — Design

**Date:** 2026-06-18
**Status:** Approved (brainstorming) → ready for implementation plan
**Repos:** `camstack-server` (types, addon-post-analysis, admin-ui) + `camstack-viewer` (RN app)
**Builds on:** the deployed face-recognition system (Phase 0 + 1a/1b/1c). See
`2026-06-18-face-recognition-{design,phase0,phase1a,phase1b,phase1c}-*.md`.

---

## 1. Goal

Complete the face/embedding feature end-to-end and improve the detection event UX:

1. **Cluster card** (viewer) shows only the `crop` image of each collected event.
2. **Event detail** (viewer) becomes a two-level gallery: a thumbnail per event in the
   group (parent `fullFrame`/`thumbnail`), and on tap a detail strip with all linked
   images (`crop`, `faceCrop`, `plateCrop`) plus **inline face manipulation**
   (assign to a person / dissociate / create a person on the fly).
3. **Face gallery management** (admin-ui) — a new "Detection intelligence" sidebar page
   whose first section, **People**, manages identities and faces: per-person galleries,
   the unassigned-faces buffer, assign/create/dissociate.
4. **Embeddings feature finished**: a **global** management capability + per-device
   capture settings + durable enrolled images.

Non-goals (explicitly deferred): photo-upload enrollment (arcface-on-demand on the
runner — a later phase); a vector database (current scale uses JSON + in-memory cosine).

---

## 2. Architecture overview

### 2.1 Capability split (the key decision)

- **`pipeline-analytics` (`scope: 'device'`)** — unchanged role: per-camera events,
  tracks, media. We only **extend `getEventMedia`** here.
- **NEW `face-gallery` (`scope: 'system'`)** — the **global** face/identity management
  surface. Identities are global; faces are collected from every camera into one global
  gallery. Registered by `addon-post-analysis` alongside its device-scoped cap, using the
  same singleton stores (`identityStore`, `faceStore`, `mediaStore`). The admin-ui and the
  viewer call it **once, globally** — no per-device enumeration.

Rationale: in this system "hub/global" scope is `scope: 'system'` (only `'system' | 'device'`
exist — `capability-definition.ts:293`). The addon already returns a **list** of
`{capability, provider}` from `onInitialize` (`index.ts:610`), so adding a second,
system-scoped capability is a natural extension.

### 2.2 Data model (states a face can be in)

A `Face` row (`pipeline-analytics:faces`, id = `face-${trackId}`) carries `deviceId`,
`trackId`, `timestamp`, `embedding` (JSON `number[]`), `mediaKey`, `recognizedIdentityId?`,
`assigned` (boolean), and **NEW `assignedSampleId?`** (the identity-sample created on
assign, so dissociation can remove exactly that sample).

| State | `recognizedIdentityId` | `assigned` | Meaning |
|---|---|---|---|
| Unknown | null | false | unrecognized buffered face |
| Recognized | set | false | auto-matched (suggestion), not enrolled |
| Enrolled | set | true | confirmed → has a durable `identity-sample` |

Embeddings are **not** in a vector DB: `identity-samples.embedding` and `faces.embedding`
are JSON `number[]` in the SQLite-backed settings-store; matching is brute-force cosine
over `loadGallery()` in memory. Adequate at current scale; vector DB is a future option.

### 2.3 Media model & durability

`MediaStore` gains a new `ownerKind: 'identity'` (alongside `event | track | face`).
`MediaFile.kind` enum gains **`faceCrop`** and **`plateCrop`**.

Per object event, `EventMediaDispatcher` already writes (ownerKind `event`):
`crop`, `thumbnail`, `fullFrame`, `fullFrameBoxed`. We add, **when the event has the
corresponding child detail bbox**: `faceCrop` and `plateCrop` (cropped from the same
synchronously-held frame). → a single `getEventMedia(eventId)` returns every image the
detail view needs.

**Durability fix (critical):** today an enrolled `identity-sample` references the buffer
face crop (`ownerKind:'face'`), which the buffer-retention prune can delete → orphaned
sample image. On **`assignFace`** we therefore **re-own the crop** to
`ownerKind:'identity'`, `ownerId:identityId` and point the sample's `mediaKey` at the new
durable copy. Buffer prune then only deletes truly-unassigned face crops; enrolled images
are permanent and are removed only by `removeSample` / `deleteIdentity`.

---

## 3. Server work (`camstack-server`) — one deploy

### 3.1 `@camstack/types` (workspace, no npm publish needed)

- `MediaFile.kind` enum: add `'faceCrop'`, `'plateCrop'` (kept additive; no exhaustive
  switch exists over kinds in the monorepo — verified in the prior session).
- `pipeline-analytics.cap.ts`: extend `getEventMedia` input to `{ eventId, kind?: MediaFileKind }`.
- New `face-gallery.cap.ts` — `scope: 'system'`. Methods (mutations `auth: 'admin'`):
  - `listIdentities()` → `Identity[]` (`{ id, name, sampleCount, coverMediaKey? }`)
  - `createIdentity({ name })` → `Identity`
  - `renameIdentity({ id, name })` → `void`
  - `deleteIdentity({ id })` → `void` (cascade samples + their durable media)
  - `listIdentitySamples({ identityId })` → `IdentitySample[]` (`{ id, mediaKey?, base64?, source, addedAt, deviceId? }`, crop base64 inline)
  - `removeSample({ identityId, sampleId })` → `void` (also deletes the durable media)
  - `listRecentFaces({ limit?, filter?: 'unassigned' | 'recognized' | 'all' })` →
    `FaceInfo[]` (`{ faceId, deviceId, trackId, timestamp, recognizedIdentityId?, identityName?, assigned, base64? }`, crop base64 inline). **Global, all devices.**
  - `getFaceByTrack({ deviceId, trackId })` → `FaceInfo | null`
  - `getFaceMedia({ faceId })` → `MediaFile[]`
  - `assignFace({ faceId, identityId })` → `void`
  - `unassignFace({ faceId })` → `void`

  No raw embedding is ever sent over the wire.

### 3.2 `addon-post-analysis`

- **Register** `face-gallery` in the `onInitialize` capability list, provider = a small
  adapter over `this.identityStore/faceStore/mediaStore` (or `this` with the new methods).
- **`getEventMedia({ eventId, kind? })`** — server-side filter (`files.filter(f => f.kind === kind)`).
- **`EventMediaDispatcher`** — accept child detail bboxes (face, plate) for the event; when
  present, crop (reusing `padBbox` + the synchronously-held frame) and `mediaStore.put`
  `faceCrop` / `plateCrop` under the event owner. Plumb the child bboxes from the event
  producer (the parent object event's child details are already available in post-analysis).
- **`FaceStore`**: add `assignedSampleId?` column; add `listAllRecentFaces({ limit, filter })`
  (global, mirrors `pruneAll`'s cross-device iteration); add `get(faceId)`; extend prune to
  **skip `assigned` faces** (their crops are re-owned to identity anyway, but guard regardless).
- **`MediaStore`**: add `'identity'` to `OwnerKind`; add `reown(fromOwnerKind, fromOwnerId, toOwnerKind, toOwnerId, key)` (or copy-then-delete) used by `assignFace`.
- **`assignFace`** = `faceStore.get` → `identityStore.addSample({ identityId, embedding, mediaKey(re-owned), modelId, source:'detected', deviceId })` → store `assignedSampleId` on the face → `faceStore.markAssigned(faceId, identityId)` → label propagation (`trackStore.setLabel` + `eventStore.setLabelForTrack`) → `faceRecognizer.refreshGallery()`.
- **`unassignFace`** = look up `assignedSampleId` → `identityStore.removeSample` (deletes durable media) → clear `recognizedIdentityId`/`assigned`/`assignedSampleId` on the face → revert label (`setLabelForTrack(trackId, undefined)`), forward-only semantics → `refreshGallery()`.
- **Settings** (`globalSettingsSchema` + per-device contribution): a "Face recognition"
  section mirroring tracking/audio — `enabled`, `similarityThreshold`, `margin`,
  `minFaceConfidence`, `confirmFrames`, `bufferRetentionDays`, `bufferMaxPerDevice`.
  Per-device override exists because **hardware/camera placement affects face capture
  quality** (the device-scoped settings must remain). Enable on cam99.

### 3.3 Deploy

Rebuild `@camstack/types` (`npm run build -w packages/types`), then
`camstack deploy packages/addon-post-analysis --server https://localhost:4443`.
Verify on cam99: events produce `faceCrop`/`plateCrop`; `face-gallery` methods reachable.

---

## 4. Admin-UI work (`camstack-server/packages/addon-admin-ui`)

New top-level page **Detection intelligence** (sidebar entry + `requireAdmin` route),
first section **People**. Uses the auto-generated tRPC hooks for the **system-scoped**
`face-gallery` cap (`useFaceGalleryListIdentities`, `…ListRecentFaces`, `…AssignFace`, …) —
**no device enumeration**.

Components (built on `@camstack/ui-library`: `Card`, `Dialog`, `Button`, `Badge`, grid; base64→`<img>`):
- **People list** — cover (`coverMediaKey` via sample base64) + sample count; create / rename / delete.
- **Per-person gallery** — `listIdentitySamples(identityId)`; remove a sample.
- **Unassigned buffer** — `listRecentFaces({ filter })` with a filter (unassigned /
  recognized / all); per face: assign to existing person (selector), **create person on
  the fly**, or dissociate.

Page is structured so "People" is the first of possibly several future sections.
Deploy: `camstack deploy packages/addon-admin-ui`.

---

## 5. Viewer work (`camstack-viewer`)

### 5.1 Cluster card = crop only (WS-A)
`EventThumb` requests `getEventMedia({ eventId, kind: 'crop' })` (drop the "first base64"
path for cards) and renders `contentFit="contain"` (already changed). Cap calls stay
untyped via `capQuery` — no `@camstack/types` bump.

### 5.2 Event detail redesign (WS-C)
Evolve `srcV2/components/camera/theater/detail/`:
- **Top gallery** — one thumbnail per event in the group; image = `fullFrame`
  (fallback `thumbnail` → `snapshot`), `contain`.
- **Selected-event detail** — horizontal scroll of that event's linked media via one
  `getEventMedia(eventId)`: `crop` (person), `faceCrop`, `plateCrop`. The bbox overlay
  stays on the clear `fullFrame` (existing `containRect`/`bboxToScreen` geometry is correct).
- **Inline face manipulation** — if the event's track has a face (`getFaceByTrack`), show
  the current identity + actions: **Assign to person** (selector listing global
  `listIdentities` + "Create new person"), **Dissociate**. Calls `assignFace` /
  `unassignFace` / `createIdentity` on the `face-gallery` cap (untyped `capQuery`).
- **Plate** — show `plateCrop` + the OCR plate text (event label).

---

## 6. Error handling & validation

- All cap methods validate input via their Zod schemas (cap layer). Mutations are
  `auth:'admin'`; the viewer/admin handle a `FORBIDDEN` by surfacing a message.
- `capQuery` already swallows/logs failures and returns null; viewer parsers narrow
  `unknown` defensively (existing pattern: `isRecord`, `extractBase64`).
- Re-own / sample-delete operations are best-effort per row with `logger.warn` (matches
  store conventions); a failed media delete never blocks the index update.
- Empty states: empty gallery → recognizer stays collect-only (no crash); detail view with
  no face → manipulation UI hidden; event with no `plateCrop`/`faceCrop` → those tiles omitted.

---

## 7. Testing

- **Server (vitest, `--exclude '**/.claude/**'`):** `face-gallery` provider methods
  (assign re-owns media + creates sample + sets `assignedSampleId`; unassign removes the
  exact sample + media; `listRecentFaces` filters; `getEventMedia` kind filter); dispatcher
  `faceCrop`/`plateCrop` saving given child bboxes; FaceStore `listAllRecentFaces` + prune
  skips assigned; MediaStore `reown`. Type gate `tsc --noEmit` per package.
- **Empirical (cam99):** after deploy, an event produces `faceCrop`/`plateCrop` on the FS;
  assign a buffered face → sample appears, image survives a buffer prune; dissociate → gone.
- **Viewer:** pure helpers stay unit-tested (`cluster-detail.ts`); manual QA of the detail
  gallery + inline assign/dissociate against the live hub.

---

## 8. Execution order (most efficient)

1. **WS-A** — cluster card crop-only (viewer; independent; tiny).
2. **WS-Server** — types + addon-post-analysis (cap, faceCrop/plateCrop, re-own, settings,
   FaceStore/MediaStore), **single deploy**.
3. **WS-Admin** — Detection intelligence / People page (depends on WS-Server cap).
4. **WS-C** — viewer detail redesign + inline manipulation (depends on WS-Server cap).

Each work-stream: implement → `tsc` + vitest → review → commit (`--no-verify`); server
deploys after WS-Server is green; admin-ui deploys after WS-Admin.
