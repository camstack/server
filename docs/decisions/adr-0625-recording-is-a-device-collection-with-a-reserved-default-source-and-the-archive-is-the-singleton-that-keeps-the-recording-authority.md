---
id: D625
title: "`recording` is a device COLLECTION whose default source is a reserved id, and `recording-archive` is the singleton that keeps the recording authority"
status: proposed
date: 2026-09-24
supersedes:
applies-to:
  - packages/types/src/capabilities/recording.cap.ts
  - packages/types/src/capabilities/recording-archive.cap.ts
  - packages/types/src/capabilities/reserved-collection-sources.ts
  - server/backend/src/api/trpc/device-collection-dispatch.ts
  - packages/addon-pipeline/src/recorder/addon/recording-source-provider.ts
  - scripts/check-reserved-collection-sources.ts
---

## Context

The operator asked for the clips model on three more subjects: *"vorrei fare
esattamente come per le clips, avere una sorgente diversa (in questo caso
onboard) per le recordings, motion, events"* [I would like to do exactly as for the clips, have a different source (onboard in this case) for the recordings, motion, events]. The analysis
(`docs/design/2026-09-24-onboard-source-for-recordings-motion-events.md`)
recommended against it for recordings and for motion. He overruled both: *"non
importa se una camera registra in continuo o ad eventi, recordings deve avere
lo stesso un modo per dipingere la timeline continua"* [it does not matter whether a camera records continuously or on events, recordings must still have a way to paint the continuous timeline], and
*"trasformiamo recording allora in una collection… il default va SEMPRE su
quello attuale di sistema"* [let's turn recording into a collection then… the default ALWAYS goes to the current system one].

`recording` was the wrong shape for that and the mismatch was not cosmetic:
`scope: 'system'`, `mode: 'singleton'`, 33 methods, declared by `recorder`
alone. A camera provider could not become a second `recording` provider without
implementing 22 storage methods it has no business implementing — relocation,
rebalance, eviction, the placement table, the ops log — plus six `mfra`
byte-range reads defined over our own MP4 segment tree.

The cut turned out clean because the groups share no schema and no call site.
Three per-camera COVERAGE reads (`getAvailability`, `getDaysWithRecordings`,
`getPlaybackManifest`) are what a picker drives. Everything else is about OUR
store. The byte plane's only callers are feeders in other addon processes (the
stream broker, the replay-clip source), never a surface.

Two things were nearly got wrong, and both are measured rather than aesthetic.

**The default.** `clip-sources.ts` ends with `?? sources[0]`, and
`videoclips.listSources({deviceId: 107})` answers the ONBOARD row FIRST. For
clips that fallback was argued for. For a timeline it is a silent downgrade: on
592, ours covers 85 362 s of the day and the card 21 388 s. A first-row fall
would swap a 98.8 % bar for a 24.8 % one with nothing saying so — the "99 %
empty bar reads as a broken recorder" failure arriving through a door nobody
opened.

**The config pair.** `getDeviceConfig`/`setDeviceConfig` carry a `deviceId` and
look like per-camera reads, so the first cut grouped them with the coverage
methods. They are the D62 recording authority (`CameraSwitch.authority`). Behind
a collection fan-out a write could reach a different provider than the read, and
the symptom — recording silently off, or a `bands` array clobbered by a partial
write — is durable and silent.

## Decision

**`recording` is a device-scoped wrapper COLLECTION** (`scope: 'device'`,
`mode: 'collection'`, `kind: 'wrapper'`, `defaultActive: true`,
`deviceTypes: [Camera]`) carrying FIVE methods: `listSources`,
`getAvailability`, `getDaysWithRecordings`, `getPlayback` and
`getPlaybackOptions`. `provider` is `z.string().min(1)` — REQUIRED in the
schema — on every one but `listSources`, because an un-narrowed fan-out unions
two sources into one bar, which is "two sources are never drawn together" broken
where it matters most.

**`getPlaybackManifest` became `getPlayback`**, answering a discriminated union
(`hls | clip | none`). A "manifest" is an HLS master playlist, which is a
property of our recorder and of nothing else; the old shape survives verbatim
as the `hls` arm, so no new media transport is built — an onboard source
DELEGATES its bytes to the `videoclips` transport its vendor already has.

**`recording-archive` is a new system singleton** holding the other 30 methods:
22 storage-and-intent, the 6 byte-plane reads, and the 2 batch reads that take
`deviceIds` and have nothing for a device-scoped mount to route on. **The
config pair stays there, and must never move.**

**OUR source id `camstack` is RESERVED.** The absence of an operator choice
MEANS that value; a surface therefore has nowhere to put a "first row"
fallback. `RESERVED_COLLECTION_SOURCES` is the one table that says so.

**Every singular read says whether anybody LOOKED.** `read: 'read' |
'unreadable'` is required on `getAvailability` and `getDaysWithRecordings`, not
only on the batch rows, and a failure answers `unreadable` rather than an empty
list — logged with `tags: { deviceId }`.

## Consequences

- A half-converted fleet during the deploy is acceptable (the operator's
  ruling) and is legible by construction: a node on the old build registers the
  old singleton, the new hub finds no device-scoped binding, `listSources`
  carries no `camstack` row, and a surface says "CamStack has no recordings for
  this camera" — wrong, but NAMED, and it resolves on deploy. The reverse
  direction is a 412 naming the capability.
- The multi-camera grid stays ours-only. The batches cannot be narrowed by
  provider over an array of device ids (`device-collection-dispatch.ts` takes
  `deviceId`, singular), so a per-camera choice on a grid has to be N per-device
  calls. That cost is declared here rather than discovered.
- Nothing that writes durable state moved. The ledger, the placement table and
  the relocation jobs are unchanged in shape and still answered by one provider.
  The only durable-state hazard in the whole cut was the config pair, and it did
  not move.
- Consumers that read OUR archive name it: `recorder`, through
  `RECORDING_SOURCE_CAMSTACK_ADDON`. The design's §15 said `provider:
  'camstack'`; that is wrong against the code — `pinnedProvider` matches
  `source.addonId`, so the pin is an ADDON id, and `camstack` is the SOURCE id
  a row carries. Both constants are exported and the distinction is documented
  where each is declared.
- `liveness-monitor` (a kernel builtin) asks ours by name and gains no
  dependency on the viewer's picker.

## Enforcement

- **`scripts/check-reserved-collection-sources.ts`**, wired into
  `.github/workflows/ci.yml`. It reads `RESERVED_COLLECTION_SOURCES` textually
  and fails on any package but the owner's that spells a reserved id — as a
  `source: '<id>'` row literal, or by naming the exported constant that holds
  it. Proven to bite both ways before it shipped. It also fails when it can
  parse no entries at all, because a table it cannot read is an unguarded
  reservation.
- **`device-collection-dispatch.ts`** drops a `listSources` row carrying a
  reserved id from any addon but its owner, naming the impostor with
  `tags: { deviceId }`. It drops the row rather than throwing — one lying
  provider must not empty a camera's picker — and the one-source fast path is
  not a hole in it.
  Pinned by `server/backend/src/api/trpc/__tests__/reserved-collection-source.spec.ts`.
- **`recording-cap.spec.ts`** pins the shape, the five-method list, the required
  `provider`, the reservation, `read` being unomittable, and that the config
  pair is on the archive and not on the collection.
- **`system-scope-device-refs.spec.ts`** pins the scope gate BOTH ways: the
  F1 #3 system-scope branch over `recordingArchive.getDeviceConfig`, and the
  device-scoped branch over `recording.getAvailability`, which must refuse the
  same out-of-scope camera the old branch refused.
- **`timeline-batch-rows.spec.ts`** pins that the archive's batch row and the
  collection's singular answer are field-for-field identical, including the
  `read` mark.
- Codegen: `npm run codegen`, which writes both generated trees
  (`packages/types/src/generated/*` and
  `server/backend/src/api/trpc/generated-cap-{routers,mounts}.ts`).
