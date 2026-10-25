---
title: «Migrate to…» — census of what is keyed on the deviceId, and the safe shape of the function
date: 2026-09-02
status: analysis and design (no code written) — decisions for the operator in §9
covers:
  - packages/system/src/builtins/device-manager/device-row-store.ts
  - packages/system/src/builtins/device-manager/device-meta-actions.ts
  - packages/system/src/builtins/device-manager/device-bindings-store.ts
  - packages/addon-pipeline/src/recorder/segment-path.ts
  - packages/addon-pipeline/src/recorder/addon/segment-hour-ledger.ts
  - packages/addon-pipeline/src/recorder/addon/config-store.ts
  - packages/addon-pipeline/src/recorder/addon/placement-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/media-store.ts
  - packages/addon-post-analysis/src/notification-center/zone-ownership.ts
  - packages/addon-provider-homeassistant/src/ha-export/topics.ts
  - packages/addon-export-hap/src/mappers/kind.ts
  - packages/addon-export-alexa/src/handlers/endpoint-id.ts
  - packages/types/src/capabilities/zones.cap.ts
  - packages/types/src/interfaces/camera-switches.ts
---

# «Migrate to…» — what is keyed on the `deviceId`, and what can really be promised

> **Amendment 2026-09-02 (same day, after the draft).** This analysis was
> written when the Home Assistant export was keyed on the `stableId`.
> **It no longer is**: HA moved to the numeric `deviceId`, aligning with the other
> three exporters (Alexa, HomeKit, Google), because `(addonId, stableId)` is
> the provider's *internal* identity and HA was the only place that made it leave
> the hub. The historical reason for that choice — «i numerici vengono
> riallocati da una re-sync» [numeric ids get reallocated by a re-sync] — was **verified false**:
> `allocateNextDeviceId` (`device-meta-store.ts:156-157`) is a monotonic
> counter and never re-emits a freed id.
>
> The three lines that said the opposite are corrected below and marked
> «(superseded)». The consequence for form D is big and must be read in §9: **HA
> is no longer the highest cost of the migration**, because a migration that
> keeps the `deviceId` touches none of its entities. In exchange, the
> change of identity was paid **once**, with a manual rediscovery by
> the operator.

> **What this document is.** A census, made on the files and on the real hub
> (<hub-ip>, 2026-09-02), of everything in CamStack that is addressed by a camera's
> numeric `deviceId`; the classification into four categories
> requested; and the answer to the four design questions. **It does not change a
> line of code.** Every claim is either verified by reading a file / calling
> the hub, or marked *(hypothesis)*.

---

## 0 · The short answer

> **Revision 2 — 2026-09-02.** The operator proposed a **fourth form** and it
> is the best: **the original device row survives and is re-pointed
> at the new hardware, also rewriting the `addonId`.** The `deviceId` never
> changes. It is the recommendation. The other three stay documented as alternatives
> evaluated and discarded, each with its reason.

| Form | What it does | Why it is not the choice |
| --- | --- | --- |
| **A** — move the data | rewrites `deviceId = A → B` in ~20 stores **and moves 264 GB** | hours of copying, merging two namespaces with a guaranteed collision on the ledger, no rollback, and **it still leaves HomeKit/Alexa/Google hanging on the dead camera** |
| **B** — replace the hardware | rewrites only `stableId` | **works only within the same provider** — ruled out by the operator |
| **C** — the on-disk prefix is a property of the row | the history stays where it is, the row declares its key spaces | holds, but requires **a big prerequisite refactor** (33 prefix constructions, 17 inline, 7 authorities inferred from the path) and **does not solve the exports** |
| **D** — the original row changes hardware and provider | `registerDevice` on the old `deviceId` with the new identity; the new camera's row is deleted | **it is the choice** |

**Why D wins, in one sentence**: every identity that this system publishes
to the outside — the HomeKit UUID, the Alexa `endpointId`, the Google id, the on-disk prefix,
the playback URL, the deep links — **derives from the `deviceId`**. If the
`deviceId` does not change, there is nothing to transfer: the hard point of the
exports **disappears** instead of requiring a transferable token.

Zero bytes moved, zero analytics rows rewritten, zero merges, no
prerequisite refactor. And zones, fraction-of-frame thresholds, scene monitors and phantom
cells **stay attached without copying anything**, because they are keyed
on the addon that wrote them plus the `deviceId` — not on the provider (§6.5.3a).

**The primitive already exists**: `upsertRegistration` is a `set` keyed on the
`deviceId` that writes `addonId` and `stableId` verbatim and **preserves the columns
it does not name**. It is what `registerDevice` does at every reconciliation. *(This
corrects what I had written in §1: «not patchable by construction» holds for
`patch`, not in general.)*

**The price, and it is not zero:**

1. **The children's `deviceId`s are not preserved.** A child's `stableId` is
   derived from the parent's, so re-pointing the parent makes them be recreated with new
   ids. Measured: **20 cameras out of 31 have children, 30 in all**. Form D is not
   the rewriting of a row, it is that of **a small tree with a pairing
   step** (§6.5.3c).
2. **The Home Assistant export breaks** — it is the only one of the five consumers of
   `stableId` that costs a manual gesture, and the operator really uses it (§6.5.4).
3. **The driver configuration moves backwards**, from the new row to
   the surviving one: without that step the camera stays offline (§6.5.3a).
4. **Precondition**: the old camera must be switched off or unplugged, or a later discovery
   re-adopts it as a new device (§6.5.3d).

---

## 1 · What makes «the same camera» in this system

There are **three** identifiers, and they live on different planes.

| Identifier | Who assigns it | What it derives from | Who uses it |
| --- | --- | --- | --- |
| numeric **`deviceId`** | the kernel, `allocateNextDeviceId` (`device-meta-actions.ts:83`, `nextDeviceId` counter under the meta lock) | nothing — it is a counter | **almost everything**: SQLite rows, on-disk paths, NC rules, HomeKit, Alexa, Google, share tokens, deep links, viewer grids |
| **`stableId`** | the provider, `generateStableId()` | **the hardware's MAC.** Verified on the hub: all 31 cameras have `stableId = "mac-<mac>"` (e.g. `mac-040312a373d4`). Hikvision: `deviceCache.mac → host-<slug>` as a fallback (`addon-provider-hikvision/src/addon.ts:195-205`); Amcrest and Reolink identical | the provider's reconciliation and 7 other things — table below |
| **fingerprint** (`exportFingerprint`) | the device manager | the set of exposed capabilities | decides when to re-announce a device to the exporters (`DeviceProvisioned`) |

Three facts that decide everything else:

1. **`(addonId, stableId)` is the addon-side identity**, unique by construction
   (`device-row-store.ts:612-618`, index `idx_dm_devices_addon_stable`). A
   provider finds its device again only this way. A new camera has a new MAC
   → a new `stableId` → **the provider allocates a new `deviceId`,
   always**. Today there is no API to rewrite the `stableId` of an existing
   row (no `setStableId`; `registerDevice` takes it from the
   provider).
2. **The `deviceId` is never reused**: `nextDeviceId` is a counter that
   goes up, and `removeDevice` does not decrement it.
3. **The three identity columns are NON-PATCHABLE by construction.**
   `DeviceRowPatch` (`device-row-store.ts:232-249`) deliberately excludes
   `deviceId`, `addonId` and `stableId`; `DeviceRowStore.patch` is an UPDATE that
   cannot touch them. There is no `transferDevice` / `replaceDevice` /
   `migrateDevice` in the whole repo — verified by grep.

**Who is keyed on `stableId` instead of the numeric** (the complete list, and
it is **not** only Home Assistant as one might think):

| Where | Shape | File |
| --- | --- | --- |
| Provider reconciliation | `(addonId, stableId)` → row | `device-row-store.ts:618` |
| **Per-user and per-API-key ACL** | `allowedDevices: Record<addonId, stableId[] \| '*'>` | `local-auth/auth-schema.ts:94,111`; applied in `live-events.router.ts:88-92` and `notification-center/index.ts:5102` |
| **Automations** | `sourceStableId`, serialised **inside the generated code** of the block, `block` column of `core_blocks` | `types/src/expression/binding-source.ts:43`, `types/src/automation/codegen.ts:214` |
| Primary child and child layout | `primaryChildEntityId` (= `sourceInfo.id`, fallback `stableId`) and `childLayout[].childKey` | `device-meta-types.ts:126-129` — **chosen on purpose** to survive a reallocation of the numeric |
| Terminal | `terminalCameraTombstones: stableId[]`, `TerminalInstance.cameraStableId` | `addon-terminal/src/addon.ts:105,123` |
| ~~**Home Assistant export**~~ **(superseded)** | it was `device_id = camstack-<stableId>`, `unique_id = <stableId>_<entity>`; **now** `camstack-<deviceId>` and `<deviceId>_<entity>` | `ha-export/topics.ts` (`deviceKeyFor`), `entity-catalog.ts:308` |
| Alexa endpoint cookie | `cookie.stableId` — but **CamStack never rereads it**; the `endpointId` is the numeric | `export-alexa/src/endpoints/builder.ts:399` |
| Reolink SMTP push | `recipientLocalPart = cam-<stableId>`, written **into the camera's NVRAM** and read back from the RCPT local-part | `addon-provider-reolink/src/email-push-server.ts:313` |

**Direct consequence on the question posed.** The two forms get opposite
things wrong, and there is no choice that gets both:

- **Form A** (the `deviceId` is re-pointed): everything keyed on `stableId`
  stays correct, but HomeKit / Alexa / Google / share links / deep links / grids
  stay on A.
- **Form B** (the `deviceId` is preserved, the `stableId` is rewritten): HomeKit /
  Alexa / Google / share links / deep links / grids / NC rules / recordings /
  events **keep working without touching them**, and the `stableId` column above
  breaks: **HA export, per-user ACL, automations with
  `sourceStableId`, terminal bindings**. That is 4 entries, all with a
  known repair, against the twenty of form A.

> **A defect found during the census, independent of this function.**
> The automations resolver looks up `all.devices.find(d => d.stableId === stableId)`
> **without `addonId`** (`types/src/automation/codegen.ts:365`, and identical in
> `types/src/device/system-mirror.ts:362`). But the `stableId` is unique only for
> `(addonId, stableId)`: two addons with the same `stableId` make the
> automation point at the wrong device. Worth fixing regardless.
>
> **A leftover to delete** (CLAUDE.md: *«un residuo che descrive il design
> giusto è peggio di niente»* [a leftover that describes the right design is worse than nothing]): `packages/system/src/builtins/sqlite-storage/device-store.ts`
> and `config-store.ts` declare a `devices` table with `UNIQUE(addon_id,
> stable_id)` and parentage by `parent_stable_id` — they are **never constructed**
> outside their specs. Reading them suggests that the system already has an identity
> by stableId that it does not have. A textbook case for D183.

---

## 2 · The real numbers (hub <hub-ip>, read on 2026-09-02)

| Fact | Value | Source |
| --- | --- | --- |
| Cameras | **31** (1 disabled), over 5 providers | `deviceManager.listAll {isCamera:true, projection:'slim'}` |
| Providers in play | hikvision 20 · reolink 7 · amcrest 1 · wyze 1 · terminal 2 | same |
| Shape of the `stableId`s | `mac-<mac>` for all except the 2 `terminal` ones | same |
| Recordings on disk (hub node) | **264.3 GB** over 15 cameras. Single maximum: **62.6 GB** (device 1441); 101 = 38.8 GB; 108 = 36.7 GB | `recording.getStorageUsage` |
| Event media | **250,287 rows / 9.10 GB** over 25 cameras. Maximum: device 111 with 49,294 rows / 934 MB | `pipelineAnalytics.getEventStoreFootprint` |
| `motion-events` rows | ~7,200/day/camera (recorded measurement) | `docs/reference/storage.md` §3 |
| Tracks on 101 in ~1.5 days | 148 | `pipelineAnalytics.listTracks` |
| Notification rules | **15**, of which **11 name numeric `deviceId`s** inside the JSON blob; 3 also name `zones.ids` | `notificationRules.listRules` |
| Zones on 101 | 2 polygons normalised 0–1 (`Uscio`, `Aiuola`), with UUID ids | `zones.listZones` |
| Switches per camera | 8 (`stream-broker`, `object-detection`, `privacy-mask`, `device-audio`, `broker-audio`, `audio-analysis`, `recording`, `notifications`) | `pipelineOrchestrator.getCameraSwitches` |
| `device-manager:devices` rows | 974 on the reference hub | `docs/reference/storage.md` |

---

## 2bis · «Common system parts»: the list, because you confirm it

The operator said: *«devono essere migrate solamente le parti comuni di
sistema, configurazioni di camera no»* [only the common system parts must be migrated, camera configurations must not]. Below is the translation of that sentence
onto the census §3, item by item. **I do not want to interpret it myself: look at the three
columns and correct them.**

The criterion I applied: **common system** is what the system has
*accumulated or decided about* that viewpoint, and **camera configuration**
is what describes *how one talks to that hardware*.

### IN — it is migrated

| What | Where | Why it is «common system» |
| --- | --- | --- |
| Tracks, object/motion/audio/sensor events | `pipeline-analytics:tracks`, `:object-events`, `:motion-events`, `:audio-events`, `:sensor-events` | observed history, independent of the driver |
| Media rows + their blobs | `pipeline-analytics:media` | same |
| Faces, plates, gallery samples, CLIP vectors | `:faces`, `:plates`, `:identity-samples`, `:vehicle-samples`, `vec0` index | same |
| Recordings: segments, hour ledger, placement | `recorder:segment-hours`, the files on disk, `placement-store` | same |
| Recording config (`enabled`, `bands`, retention) | `recorder:recording-configs` | it is a **system schedule**, not a driver setting |
| Notification rules that name the camera, mutes, outbox, artifacts | `notification-center:*` | operator intent about the viewpoint |
| Liveness / battery alerts | `:liveness`, `:device-alerts` | system history |
| Name, room, role, icon, display | `device-manager:devices` | operator intent about the place |
| **Zones and zone rules** | `pipeline-orchestrator:<deviceId>.zones` / `.zoneRules` | **moved here on your decision** (they were in category 4) |
| HA export membership | `exportTo:<brokerId>` | it is a system choice, not the driver's |

### OUT — it is not migrated

| What | Where | Why it is «camera configuration» |
| --- | --- | --- |
| Host, credentials, port, channel, `deviceCache` | `config` column of the device row | it is the driver |
| `addonId`, `stableId`, `integrationId` | `device-manager:devices` | **it is the identity of the hardware**: two devices adopted separately stay two |
| Stream profile map, `detectionStreamProfile`, `motionStreamProfile`, `snapshotStreamId` | `stream-broker:profile-map`, per-device settings | they name vendor stream ids: the `sub02` of a Hikvision does not exist on a Reolink |
| Privacy mask regions, PTZ presets, OSD | **on the camera itself** | they are not ours |
| `device-runtime-state`, `device-features`, `probe-snapshots` slices | regenerable mirrors | they re-hydrate by themselves; copying them creates a second authority |
| Node / accelerator pin, `stepOverridesByDevice` | orchestrator | they describe where it ran, not what it is |
| Already-retired keys | `retention/retired-device-settings.ts` | copying them would resurrect them |

### TO BE DECIDED — they fall under the zones logic, and you changed that logic

These are **calibrated on the framing** like the zones. Having decided that the zones
are copied active, the coherent choice is to copy these too — but I do not want to
deduce it in your place.

| What | Where | The question |
| --- | --- | --- |
| Fraction-of-frame thresholds: `minSpawnAreaFracPerson/Vehicle/Animal`, `minFacePx`, `packageDropMin/MaxBboxAreaFrac`, `margin` | orchestrator per-device settings | calibrated on the distance of the subjects in the old framing |
| Scene monitors + reference images | `pipeline-analytics:scenes` | a scene **is** a description of the old framing |
| Phantom cells, package background, stationary objects | `:phantom-cells`, `:package-background`, `:stationary-objects` | learned maps of *where* in the frame the false positives are born |

### The cross-provider constraint that the inventory did not have

Something new, which arises from having admitted cross-provider and is **not** a
matter of categories: **capability bindings are not blindly
transferable.** A per-camera switch is a view onto
`setWrapperActive(capName, …)` (D62), and which caps are bindable depends on the type
and the provider — `deviceManager.listBindableCapsForDeviceType` is what decides
whether the switch exists. A Reolink may not offer a cap that the Hikvision
offered.

So the step «turn the same switches back on at the destination» **can fail
by construction**, and it is not an error: it is a difference between two cameras. It must be
reported entry by entry (`{ switchId, restored | unavailable }`), never presumed —
and a switch that could not be turned back on must not look like one that
the operator turned off (D62).

---

## 3 · The inventory, in four categories

The categories describe **form A** (moving A's data onto B). In form B
the whole inventory becomes empty except the two rows marked **[also in B]**.

### 3.1 Category 1 — re-pointable without loss

A `deviceId` column to rewrite, no possible conflict because the row key
is already globally unique (UUID or a composite id that does not contain the
`deviceId`).

| What | Store / table | Shape | File |
| --- | --- | --- | --- |
| **Tracks** | `pipeline-analytics:tracks` | column `deviceId INTEGER NOT NULL`, indexes `(deviceId,lastSeen)` and `(deviceId,firstSeen)`; PK = `trackId` (UUID) | `store/track-store.ts:313,529` |
| **Object events** | `pipeline-analytics:object-events` | column; each row carries its `trackId`; independent PK | `store/event-store.ts` |
| **Motion / audio / sensor events** | `:motion-events`, `:audio-events`, `:sensor-events` | column; terminal roots age-keyed | `store/event-store.ts`, `store/sensor-event-store.ts` |
| **Media (index rows)** | `pipeline-analytics:media` | column `deviceId INTEGER NOT NULL` + indexes `(deviceId,timestamp)`, `(deviceId,sizeBytes)`. **The row key is `<ownerKind>:<ownerId>:<kind>[:<ts>]` — it does not contain the `deviceId`** | `store/media-store.ts:264,284,431-437` |
| **Face / plate** | `:faces`, `:plates` | id = `face-<trackId>` / `plate-<trackId>`; they **also** carry a `deviceId INTEGER NOT NULL` column of their own → re-pointable without going through the track | `store/face-store.ts:163`, `store/plate-store.ts:35` |
| **Gallery samples** | `:identity-samples`, `:vehicle-samples` | **nullable** `deviceId` column, provenance only (a sample from a photo does not have one). The parents `:identities` and `:vehicles` **have no `deviceId`**: a person is not a camera | `store/identity-store.ts:59`, `store/vehicle-store.ts:48` |
| **Stationary objects** | `pipeline-analytics:stationary-objects` | column; id = UUID | `pipeline/stationary/stationary-registry.ts:73` |
| **Retrain annotations** | `pipeline-analytics:retrain-annotations` | column + index `(deviceId,createdAt)`; opaque id | `retrain/retrain-annotation-store.ts:55` |
| **CLIP vector index** | `vec0` table with metadata column `deviceId integer` | ⚠️ **not updatable with UPDATE**: the store has only INSERT and DELETE (`:231`, `:466`). Re-pointing = re-reading the embedding and re-inserting | `packages/system/src/builtins/sqlite-storage/vector-index-vec.ts:197` |
| **Notification outbox** | `notification-center:outbox` | column `deviceId INTEGER NOT NULL`; id = `<ruleId>:<dedupRef>:<targetId>`, without deviceId. The `deviceId` is however **also inside the blob `payload.subject.deviceId`** and in `payload.subject.systemEvent.deviceId` | `notification-center/outbox.ts:549-558` |
| **NC artifact index** | `notification-center:artifacts` | column `deviceId` + a `deviceIds` array inside the `record` blob | `notification-center/artifact-index.ts` |
| **Liveness / battery alerts** | `notification-center:liveness`, `:device-alerts` | PK `device:<id>` / `battery:<id>` + column | `liveness-ledger.ts`, `alerts/alert-store.ts:112` |
| **Ops log** | `pipeline-analytics:ops-log`, `recorder:ops-log` | nullable `deviceId` column, audit | `store/ops-log-store.ts` |
| **Wrapper activations** | `deviceBindings` blob in the device-manager's `addon-settings` | `Record<String(deviceId), Record<capName,{wrapperAddonId}>>`. **[also in B: no — in B it is not touched]** | `device-bindings-store.ts`, shape in `device-meta-types.ts:53-58` |
| **Per-device settings** (orchestrator, pipeline-analytics, snapshot, OSD, doorbell) | `addon-device-settings`, id = `<addonId>:<deviceId>.<key>` | one row per FIELD. ~80 keys for `pipeline-analytics` alone | `packages/system/src/kernel/settings-door-view.ts:177` | <!-- drift-ok -->
| **Runtime state** | `device-runtime-state`, id = `String(deviceId)` | regenerable; **do not migrate, re-hydrate** | `settings-door-view.ts:225-245` |
| **Recording config** | `recorder:recording-configs`, row key = `String(deviceId)` | `enabled`, `bands`, `profiles`, `retention` | `recorder/addon/config-store.ts:44,183` |
| **Notification mutes** | `notification-center:device-mutes`, id = `String(deviceId)` | absence = not muted (no `false` row) | `device-mute-store.ts:42-51` |
| **Stream broker overrides** | `deviceOverrides` blob in stream-broker's `addon-settings` | `Record<deviceIdString,{audioMuted,preBuffer,…}>` | `stream-broker/addon.ts:464-490` |
| **Device row meta** | `device-manager:devices` | `name`, `location`, `role`, `display`, `integrationId` — copyable | `device-row-store.ts` |

> **Note on cost.** «Re-pointable without loss» does not mean *cheap*.
> `pipeline-analytics:media` has 250,287 rows in total on the hub; re-pointing the
> busiest camera means rewriting ~49,000 rows **and** moving the files that
> those rows index (§3.3).

> **Good news.** No `pipeline-analytics` collection hides a
> `deviceId` inside a JSON blob: where the device matters, it is a typed column.
> And the **media keys** (`<ownerKind>:<ownerId>:<kind>[:<ts>]`) do not contain the
> `deviceId`, so all the cross-references (`Track.snapshots[].mediaKey`,
> `bestEventId`, `keyFrameMediaKey`, `coverMediaKey`) **survive intact** a
> re-pointing. The problem is never the logical key: it is the on-disk path.

### 3.2 Category 2 — re-pointable but with a possible conflict

The destination may already have some of its own, and the key collides.

| What | Why it collides | What the design must decide |
| --- | --- | --- |
| **Recording hour ledger** (`recorder:segment-hours`) | PK = `` `${deviceId}\|${profile}\|${locationId}\|${hour}` `` (`segment-hour-ledger.ts:442-449`). If A and B recorded **the same hour, on the same profile, on the same location** — i.e. always, if both were recording — the row already exists | **mandatory merge**: concatenate the `paths` arrays, sum `bytes`/`segments`, recompute `minStartMs`/`maxStartMs`. An `INSERT OR REPLACE` **deletes B's history** |
| **Segment files on disk** | the file name is `<startMs>-<durMs>-<bytes>.m4s` inside `<deviceId>/<profile>/…/HH/`. Can two cameras have segments with the same `startMs` to the millisecond? Practically no *(hypothesis: the real risk is the directory, not the name)* | the directory `<B>/high/2026/09/02/14/` already exists → one must merge file by file, not rename the tree |
| **Event media paths** | `<deviceId>/events/<ownerKind>/<ownerId>/…`; `ownerId` is a UUID → no file collision, but the directory `<B>/events/` already exists | merge by subdirectory, not `rename` of `<A>` → `<B>` |
| **Per-camera placement** | `assignments['<deviceId>:<profile>'] → locationId` and `pins['<deviceId>']` (`placement-store.ts:77-79,207`) | A and B may be on **different locations**. If they are, the merge is not a `rename` but a **cross-filesystem copy** of tens of GB |
| **Retention** | `trackRetentionDays` and the follow-recordings window are **per camera**. A's history migrates under B's window | if B has a shorter window, the first retention pass **deletes the history just migrated**. It must be frozen or aligned beforehand |
| **Notification rules** | `notification-center:rules`, `:summary-rules`, `:timelapse-rules` declare only `id/name/enabled/updatedAt/rule` — **no `deviceId` column**. The per-camera scope is `conditions.devices: number[]` **inside the JSON blob**, so «which rules touch camera N» is a full scan and a re-pointing is a parse-and-rewrite of every document | decide: replace A with B (the rule follows), or add B (it applies to both). And beware: **a rule also names other devices** — `deviceState.deviceId` (a gate on another device), `actions[].deviceId` (the target of the actuation, on this hub the panel 1023), `systemEvent.deviceIds[]`. They are three independent ids in the same document |
| **Recording config / mutes / bindings** | row per `String(deviceId)`, B already has one | **does the destination or the origin win?** See §9-D4 |
| **HA export membership** | `exportTo:<brokerId>` is `Record<brokerId, deviceId[]>` — **numeric** ids (`ha-export/membership.ts:20`) | the only piece of HA keyed on the numeric: it must be updated by hand in both forms |
| **Collections whose PK *starts* with the `deviceId`** | `pipeline-analytics:scenes` and `:scene-latch` (`<deviceId>:<monitorId>`), `:phantom-cells` and `:package-background` (`<deviceId>:<className>:<cell>`), `pipeline-analytics:stats-5m` (`<subject>\|<series>\|<scope>\|<bucketStart>` with `subject = String(deviceId)`) | **an `UPDATE` is not enough: delete + reinsert is needed.** And `phantom-cells`, `package-background` and `stats-5m` **collide by construction** with B's rows (same class/cell, same time bucket). For `stats-5m` the merge is arithmetic: sum `samples`/`sum`, recompute `min`/`max`. For the phantom/package cells **do not merge**: they are framing geometry → category 4 |

### 3.3 Category 3 — **not** re-pointable

The datum is tied to the physical identity, to an on-disk path, or to an external
system that keeps its own map.

#### 3.3.1 The bytes on disk — the real cost of form A

The `deviceId` **is the first component of the path**, and no reconciliation
repairs it:

```
segmentRelPath()  →  <deviceId>/<profile>/YYYY/MM/DD/HH/<startMs>-<durMs>-<bytes>.m4s
                     packages/addon-pipeline/src/recorder/segment-path.ts:16
buildPath()       →  <deviceId>/events/<ownerKind>/<ownerId>/<kind>[-<ts>].jpg
                     packages/addon-post-analysis/.../store/media-store.ts:439-446
framePath()       →  retrain/<deviceId>/<trackId>/<leaf>.jpg
                     packages/addon-post-analysis/.../retrain/retrain-frame-store.ts:159
exports           →  <dataDir>/exports/<deviceId>/<exportId>.mp4
                     packages/addon-pipeline/src/recorder/addon/index.ts:243,1108
```

For `media` and `retrain-frames` the path is **also a stored `path` TEXT column**:
moving the file and rewriting the row must be one thing.
The only operation that rewrites a path today, `MediaStore.reown`
(`media-store.ts:1155`), **preserves the `deviceId` to the letter** (`:1168`) —
there is no «change device» primitive in the whole addon.

And the code **assumes that path and index cannot disagree**:

- `RecordingIndex.rowFor` **silently discards** a segment whose path
  encodes a `deviceId` different from the one it is hydrating
  (`recording-index.ts:303-316`) — no log. Invisible footage: it takes up disk,
  never plays, and no per-device pass evicts it.
- `RecordingIndex.removeSegments` routes deletions **only** on the id
  encoded in the path, without a `deviceId` argument (`:445-451`).
- The archive walk composes the `deviceId` **from the directory name**
  (`roots.ts:269,297`).
- The ledger keeps the key and the derived `paths` **independently**
  (`segment-hour-ledger.ts:460-462`): a row with key `102|…` whose `paths`
  encode `101/…` would make 102 count the bytes and **delete 101's files**.

> **Technical conclusion, verified**: there is no reconciliation that
> repairs a `deviceId` disagreement. Renaming the files and rewriting the rows
> must be one thing, and the first error is silent.

#### 3.3.2 The exports to external ecosystems

| Ecosystem | Published identity | Derives from | What the external system remembers and we **cannot** move |
| --- | --- | --- | --- |
| **HomeKit** | accessory UUID → HAP MAC | numeric **`deviceId`**: `uuid.generate("camstack:camera:<deviceId>")` (`export-hap/src/mappers/kind.ts:72-76`) | pairing, room, names, scenes, automations **and the HKSV clips on iCloud** — which are a one-way *sink*: «Apple never hands them back» (`docs/design/2026-08-17-videoclips-implementation.md:30`). The namespace is declared **FROZEN** in the code |
| **Alexa** | `endpointId` = `String(deviceId)`, children `<A>__<B>` | numeric **`deviceId`** (`export-alexa/src/handlers/endpoint-id.ts:4-12`) | friendly name, groups, routines. Amazon refreshes its copy **only** on an `AddOrUpdateReport` that we push |
| **Google Home** | `SyncDevice.id = String(deviceId)` | numeric **`deviceId`** (`export-google/src/google-home/device-model.ts:87`) | room, nickname, routines. **There is no `requestSync`**: Google stays misaligned until the operator says «sincronizza i dispositivi» [sync the devices] |
| **Home Assistant** *(superseded)* | **now** `device_id = camstack-<deviceId>`, `unique_id = <deviceId>_<…>` | numeric **`deviceId`**, like the other three | entity registry, area, dashboards, automations **and the HA recorder's history**. The code says so: changing the key *«orphans every entity in an operator's installation, taking its recorder history and dashboard placement with it. Treat a rename here as a migration, not an edit»* (`ha-export/types.ts:6-11`) |
| **Matter / MQTT / Alexa-import** | — | — | they are not exporters: no CamStack identity leaves through them (verified: no `device-export` in their manifests) |

#### 3.3.3 References already distributed outside the hub

| What | Shape | Why it is not re-pointable |
| --- | --- | --- |
| **Share tokens** | `ShareTokenScopeSchema.deviceIds: number[]`, table `share_view_tokens` | the link is already in third parties' hands, can be `expiresAt: 'never'`, **there is no reaper**: the only remedy is manual revocation. Re-pointing the id silently changes *what an already-distributed link shows* |
| **Notification deep links** | `…/viewer/camstack/camera/<deviceId>?at=<ts>` (`default-tap-url.ts:49`) and `/devices/<deviceId>?tab=…` | they live in the notification history on the phones; nobody can rewrite them |
| **Viewer state on the phones** | AsyncStorage: `grid-store` (`cameraIds: number[]`), `camera-prefs-store` (`byId` per deviceId), `last-camera-store`, `events-filter-store`, `track-flag-overlay-store` | it is on **every installed phone**. The hub does not reach it |
| **`core_blocks` automations** | the block is the **operator's source code**; a `deviceId` written inside is a constant | no static analysis can safely rewrite it. (On this hub: 0 blocks — verified) |
| **Server-side snapshot of the viewer settings** | `pipeline-analytics:viewer-settings-snapshots`, `blob JSON` column typed `z.record(z.string(), z.unknown())` (`viewer-settings-actions.ts:25`) | it is an **opaque** document: no schema, no index, no validation. The grid/camera selections that an operator saved live in there as numeric ids, and **there is no safe way to rewrite them**. It must be flagged, not touched |

### 3.4 Category 4 — **not** to migrate by choice

Data that would follow the camera but should not.

| What | Where | Why not |
| --- | --- | --- |
| **Zones** | `addon-device-settings`, `pipeline-orchestrator:<deviceId>.zones` | polygons **normalised 0–1** — normalised because *«zones survive resolution changes and stream profile switches»* (`zones.cap.ts:22-23`), **not** because they are transferable. A polygon is the description of *what is in A's framing*. «Aiuola» [Flowerbed] on another framing is an arbitrary shape |
| **Zone rules** | `pipeline-orchestrator:<deviceId>.zoneRules` | they reference the zone ids: valid only if the zones migrate with their ids intact |
| **Scene monitors** | `pipeline-analytics:scenes`, key `<deviceId>:<monitorId>` | a scene is a description of what A looks at |
| **Privacy mask regions** | **on the camera itself** — no server-side copy (`camera-switches.ts:58-68`) | framing geometry, and anyway not ours |
| **Fraction-of-frame thresholds** | `minSpawnAreaFracPerson/Vehicle/Animal`, `packageDropMin/MaxBboxAreaFrac`, `margin`, `minFacePx` | they are calibrated on the distance of the subjects in A's framing |
| **Node / accelerator pins** | `pipelineNodeId`, `pipelineDeviceKey`, `stepOverridesByDevice[nodeId][deviceKey]` | they describe where A runs, not what A is |
| **Stream profiles** | `detectionStreamProfile`, `motionStreamProfile`, `snapshotStreamId`, `stream-broker:profile-map` | the `sub02` profile of a Hikvision does not exist on a Reolink |
| **Retired keys** | `retentionObjectDays`, `retentionMotionDays`, `retentionAudioDays`, `bufferRetentionDays`, `suggestionMinCosine` | already announced as retired (`retention/retired-device-settings.ts`); copying them would resurrect them |
| **Phantom cells / package background** | `pipeline-analytics:phantom-cells`, `:package-background`, key `<deviceId>:<className>:<cell>` | they are a map of **frame grid cells** — learning about which part of A's framing produces false positives. On another framing it is noise learned and transferred |
| **Stationary objects** | `pipeline-analytics:stationary-objects` | they record where an object is still **in A's frame** (`bbox`, `frameWidth/Height`) |
| **Regenerable mirrors** | `pipeline-orchestrator:device-features`, `stream-broker:probe-snapshots`, `pipeline-analytics:scene-latch`, the `device-runtime-state` slices | they re-hydrate by themselves (`zone-mirror-hydration.ts`); copying them creates a second authority |

#### The trap: zones in cat. 4 + rules in cat. 1 is **a dangerous combination**

Verified in `rule-engine.ts:1372-1394` + `zone-ownership.ts`:

```ts
const scope = scopeZoneIdsForRule({ ids: c.zones.ids, deviceScope: c.devices, deviceId }, zoneOwners)
if (scope.kind !== 'inert') { /* …evaluate the zones gate… */ }
// scope.kind === 'inert'  ⇒  THE GATE IS SKIPPED  ⇒  match on the FULL FRAME
```

`inert` means «this camera owns none of the listed zones», and in
that case the rule **does not fail: it passes on the whole frame**. The semantics are
correct and intended for multi-camera rules («no zone on a camera means
everywhere»), but applied to a migration they produce the worst outcome:

> If the rule *«Animale su Aiuola»* [Animal on Flowerbed] is migrated from 101 to a camera that does not have the
> zone `fa03b60a-…`, the rule **does not stop firing — it fires on everything**.
> Not a silence: a storm of notifications.

**So the classification «zones = do not migrate» is not composable with «rules =
migrate» without a third intervention**: either the zones migrate with their ids (and then
they describe the wrong scene), or **the rules with zone conditions must be
disabled and flagged to the operator**, not re-pointed. See §9-D5.

---

## 4 · Question 2 — the order of operations

The operator proposes: *disable the origin → migrate → enable the destination*.
**The order is right, and the first step already exists as a primitive.**

### 4.1 The quiescing primitive is already there

`pipelineOrchestrator.getCameraSwitches` / `setCameraSwitch` (D62) exposes 8
switches per camera, and **each one writes the authority that already owned the
function** — not a store of its own. Read on the hub for camera 101:

| Switch | Authority | Where the state ends up | Must it be turned off? |
| --- | --- | --- | --- |
| `stream-broker` | `deviceManager.setDisabled` | `PersistedDeviceMeta.disabled` | yes |
| `object-detection` | `setWrapperActive('detection-pipeline')` | `deviceBindings` blob | yes |
| `audio-analysis` | `setWrapperActive('audio-analysis')` | `deviceBindings` blob | yes |
| `recording` | `recording.setDeviceConfig` → `enabled` (**`enabled` only**; touching `bands` destroys the schedule) | `recorder:recording-configs` | yes |
| `notifications` | `notificationRules.setDeviceMuted` | `notification-center:device-mutes` | yes |
| `device-audio` | `privacyMask.setAudioEnabled` | **the camera** | optional |
| `broker-audio` | `streamBroker.setDeviceAudioMute` (**node-pinned**) | `deviceOverrides` blob | optional |
| `privacy-mask` | `privacyMask.setMask({enabled})` | **the camera** | **NO — inverted polarity**: turning it on blacks out the video |

Three constraints that a shutdown sequence must respect, all from the code:

1. **`privacy-mask` must not be included in a "turn everything off"**: `enabled: true`
   means *video blacked out*, and does not count as `switchedOff`.
2. **A write to an unavailable switch is REFUSED loudly**
   (`camera-switch-service.ts:118-128`) — so the shutdown must be verified,
   not presumed.
3. **D62: a switch that is off must be REPORTED off.** If the migration disables A
   through a route other than these authorities, `CameraStatus.switchedOff` does not
   name it and **A appears broken instead of deactivated**.

Cost constraint: `object-detection` and `audio-analysis` are two RMWs of the
`deviceBindings` blob (a fleet-wide 775-byte row) under **a single lock**
(D309). Turning A off and B on = 4 serialised RMWs. Correct, but it is not
free.

### 4.2 What arrives *during* the migration

Even with the switches off, three writes do not stop:

| Write | Why it does not stop | Remedy |
| --- | --- | --- |
| The **continuous recorder never reaches an attach boundary by itself** (documented in `2026-08-29-non-blocking-storage-migration.md` §1) | a shutdown is a `detach`, but an open segment must be closed | `RecordingController.pause()/resume()` is **already** the storage migration's pause primitive; it is the same one needed here |
| **Tracks still in flight**: a track is persisted **at TTL expiry**, not at creation (`storage.md`: *«persistCompleted upserts at TTL»*) | a track started before the shutdown writes afterwards | wait `maxTrackLifetimeSec` after the shutdown, or run the re-pointing again at the tail |
| **Retention** runs on its own clock, per camera | it may run while migrating | freeze the window (§3.2) |

### 4.3 Is a quiet window, a lock, or is it tolerable?

**In form B: a window of seconds, not a lock.** Nothing is moved:
a row is rewritten and the provider is made to re-attach. It is exactly the shape of
D292 («*repoint first, drain behind*»): `pausing → repointing → refreshing →
resuming`, with the long part absent.

**In form A: a durable job with a ledger is needed, not a window.** With
62.6 GB on a single camera and an order of 7–14 MB/s measured for a
cross-disk copy (a number taken from the storage migration design), a cross-location
copy takes **hours**. A `pause()` for that time is unacceptable — and we already know the
answer: **re-point first, drain behind** (D292). But here re-pointing first is what
cannot be done, because `RecordingIndex.rowFor`
silently discards every segment whose path disagrees with the row
(§3.3.1). **The property that makes the storage migration non-blocking — «the
path carries its location, read per row» — has no equivalent for the
`deviceId`, which is in the path itself.**

---

## 5 · Question 3 — reversibility

### 5.1 What state the cluster is left in if it fails halfway

**Form A**, by phase:

| Failure halfway through… | Resulting state | Repairable? |
| --- | --- | --- |
| rewriting SQLite rows | some tables say B, others A. Tracks on B without their events; media on A without their track | yes, if the job keeps a per-table ledger |
| moving files | files under `<B>/` but the ledger says `<A>|profile|loc|hour` | **not automatically**: `rowFor` discards them without a log (§3.3.1). It is invisible footage |
| merging ledger rows | `INSERT OR REPLACE` instead of merge | **B's history is lost, silently** |
| vector index | delete done, insert not | the embedding is lost; the track remains but can no longer be found by similarity |
| NC rules | some re-pointed, others not | repairable by hand, but in the meantime some are `inert` (§3.4) → they notify on everything |

**Form B**: the failure surface is a row and a config blob. An
atomic write under the meta lock leaves either the old state or the new one. The
only possible residue is «the `stableId` changed but the connection config
did not» → the provider does not reach the camera → it is seen immediately and re-modified.

### 5.2 What D333 (and D331) impose

**D333** — *«un'azione che non ha cambiato nulla non risponde mai `success`»* [an action that changed nothing never answers `success`], and
*«un forget purga OGNI sorgente che elenca la cosa»* [a forget purges EVERY source that lists the thing]. Applied here:

- the migration **cannot return a boolean**. It must return the count for
  each source touched: `{ tracks, events, media, segmentHours, filesMoved,
  rules, bindings, settingsKeys, stillOnSource }`, and name the sources that
  did not answer;
- `Promise.allSettled` with the result discarded is exactly the defect that
  D333 records. Every branch that is refused **logs** before answering, with
  `tags: { deviceId }` — a non-negotiable logging rule of this repo;
- a source that did not answer is `unconfirmed`, never `applied`.

**D331** — *«un rename che attraversa due store è UNA chiamata server»* [a rename that crosses two stores is ONE server call]. The
migration crosses twenty. It cannot be a sequence from the browser: it would be
the same fleet-split-in-two-rooms, multiplied. **A single cap method,
server-side, with a durable job.**

**D291** — the order of writes is not a detail: *write the destination row first, then remove the origin one*. The «cheap» order (origin first) has
a window in which the path is listed in **no** hour row, and since
an hour known to the ledger marks the index `hydrated`, **nobody walks that
hour any more**: the segment stays on disk permanently unreachable.

### 5.3 Rollback

- **Form A**: a true rollback requires remembering, for each row touched, the
  previous value **and** the previous path of each moved file. It is a
  second ledger as big as the first. *Recommendation: do not promise it.*
  Promise instead **resumption** (the job restarts from the cursor) and **detection**
  (a verification pass that counts the residues on A and names them).
- **Form B**: the rollback is rewriting the original `stableId`. Trivial.

---

## 6 · The four forms, compared

| | **A — move the data** | **B — replace the hardware** |
| --- | --- | --- |
| What it does | `deviceId: A → B` on ~20 stores + moves 264 GB | rewrites `stableId` + the connection config of A's row |
| Final `deviceId` | B's | **A's, unchanged** |
| Bytes moved | up to 62.6 GB per camera | **zero** |
| Duration | hours (or days, cross-disk) | seconds |
| Recordings | to be merged hour by hour, with PK collision | **intact, untouched** |
| Events / tracks / media | to be rewritten row by row | **intact** |
| Notification rules | to be rewritten; zones → `inert` → storm | **intact** |
| HomeKit / Alexa / Google | **stay on A** (dead camera) | **keep working** |
| Share links, deep links, grids on the phones | **stay on A** | **keep working** |
| Home Assistant export | stays correct | **breaks** (`unique_id` changes): orphan entities, HA history lost. Loud and visible |
| Per-user / API key ACL (`allowedDevices`) | stay correct | **break**: they are `Record<addonId, stableId[]>` → the user loses access to the camera |
| Automations with `sourceStableId` | stay correct | **break**: the binding no longer resolves |
| Failure surface | ~20 stores + the filesystem | one row + 4 references per `stableId` to redo |
| Reversible | in practice no | yes |
| Works **across different providers** (Hikvision → Reolink) | yes | **no** — see below |

### 6.1 The limit of form B, and it is real

`(addonId, stableId)` is the addon-side identity: the row also carries the `addonId`,
and the `config` blob has the provider's shape (host, channel, credentials,
`deviceCache`). **Rewriting `addonId` means rewriting the config in a different
schema** — no existing path does this.

On the real hub the case is anything but theoretical: 20 Hikvision cameras, 7 Reolink,
1 Amcrest, 1 Wyze. A physical replacement often changes brand.

So:

- **same provider** (Hikvision → Hikvision): form B, clean.
- **different provider**: form B additionally requires rewriting `addonId` and
  rebuilding the `config` for the new provider — i.e. *re-adopting the hardware
  while keeping the number*. It is feasible in principle (the `addonId` is a
  column, not a key) but it must be designed: the old config must be **discarded**, not
  translated, and the capabilities change → the `fingerprint` changes → the exporters
  re-announce. *(hypothesis: I did not trace the whole cross-provider
  re-adoption path; it is the first thing to verify if B is chosen.)*

### 6.2 What is missing, today, for form B

**The precedent already exists halfway.** `deviceManager.adoptionResync({ camDeviceId,
resetToSource: true })` (`device-queries.ts:1143-1181`) is the closest thing to
a re-adoption: it removes **all the direct children** and lets the provider
re-derive them, while *«the parent itself (and its operator edits — name, layout,
primary-child pick) is untouched»*. It is exactly the philosophy of form B —
preserve the parent's identity, rebuild what derives from the hardware —
applied however to the children, not to the parent.

**A single primitive is missing.** There is no `deviceManager.setStableId` (nor a
`replaceHardware`), and **it cannot be added with a `patch`**: `DeviceRowPatch`
excludes by construction the three identity columns (§1, point 3). A new cap
method is needed that, **in a single server call** (D331), under the meta lock:

1. refuses if the destination `stableId` is already taken by another row of the
   same `addonId` (the index `idx_dm_devices_addon_stable` makes it a read);
2. rewrites together the `stableId` column **and** the identity keys inside
   `config` (for Hikvision: `deviceCache.mac`, `host`, credentials) — because
   `generateStableId` reads them from there and the next reconciliation must fall
   on the same row;
3. **deletes or absorbs** the row of the device B already discovered, if it exists;
4. answers with what it changed, never with a boolean (D333);
5. logs every branch with `tags: { deviceId }`.

With this primitive the «Migrate to…» function becomes: *choose the new camera
(the one just discovered) → the hub moves its hardware identity into the row
of the old one → the new camera disappears from the list and the old one now sees the
new hardware, with all its history.*

---

### 6.3 Form C — the on-disk prefix becomes a property of the row

**Verdict: it holds, and it is the right form for the current constraints.** Below, the facts
that say so and the exact price.

#### 6.3.1 The shape

Today the first component of the path **is** the `deviceId`. The proposal is that it be
a **numeric** `storageKey` stored on the device row, and that the row
declare the **set** of its key spaces:

```
writeKey : number        — where it writes from now on
readKeys : number[]      — all the spaces that belong to it (writeKey included)
```

The set, not a scalar, and the reason is the most important thing in this whole
section: **the destination already has bytes of its own under `<B>/`.** With a
scalar one would have to merge two histories into a single namespace — i.e. redo
exactly form A. With a set, **the two histories never touch each other**:
they stay in two separate spaces and the row says «both are mine».

> **This is the real gain of form C, even more than the bytes not moved:
> every collision of §3.2 disappears, because it was created by the merge.** The
> hour rows of A and of B have different keys by construction and no longer
> collide. There is no merge to write, hence no merge to get wrong.

The precedent of the fan-out read already exists: `collectRangeSegments`
builds `rootById` from **every** location, not from the default one — the read is already
a union by construction. Adding a second dimension to the union is the
same shape.

#### 6.3.2 Why it is almost free to introduce

Three properties, all verified:

1. **The prefix stays numeric**, so no format changes shape.
   `SEG_RE = /^(\d+)\/([^/]+)\/\d{4}\/…/` (`segment-path.ts`) keeps
   matching; the Alexa parser, which rejects everything that is not a non-negative
   integer (`export-alexa/src/handlers/endpoint-id.ts`), does too. **Only
   what that number means changes, not its syntax.**
2. **The introduction is a no-op.** `writeKey` is born equal to the `deviceId` and
   `readKeys = [deviceId]`. Every on-disk path, every hour row, every existing
   index row is **already correct** under the new interpretation.
   No backfill, no rewrite, no window in which disk and
   rows can disagree. This is rare and should be exploited.
3. **No collision possible**, if the `storageKey`s are allocated from the same
   `nextDeviceId` counter that already mints the `deviceId`s: a single namespace, a
   single monotonic counter, and a key can never equal the `deviceId` of
   another camera. A uniqueness constraint is additionally needed: **a key space
   belongs to exactly one row at a time.**

And the migration becomes: **move a number from A's `readKeys` to B's
`readKeys`.** Zero bytes, zero hour rows, zero files touched.

#### 6.3.3 The census: how much is really threaded through

**Verdict: it is NOT contained behind the existing helpers.** It is the number that
decides, and it must be said before everything else: `segmentRelPath` and `hourDirRelPath`
cover **6 of the 33** device-prefix constructions present in the repo.

| Category | Count | Notes |
| --- | --- | --- |
| Path **constructor** functions | **8** (9 definitions) | 16 production call sites |
| Shared **parser** functions | **1** — `parseSegmentPath` | 7 production call sites |
| **Inline positional** parses (no helper) | **5** | `split('/')[1]`, `Number(deviceDir)`, two HTTP regexes |
| **Inline constructions** that bypass every helper | **17**, in 7 files | the number that decides |
| **Walks** that assume «dirent = deviceId» | **9** | of which **3 destructive** |
| **Authorities inferred from the path** | **7** | eviction, de-index, byte charging, staging recovery, two `rm -rf` |

The 8 constructors: `segmentRelPath` (`segment-path.ts:1`), `hourDirRelPath`
(`roots.ts:370`), `playbackDirFor` (`recording-provider.ts:311`),
`exportSourcePlaylistPath` and `exportSourceConcatPath`
(`export-source-playlist.ts:45,57`), `resolveClassDir`, `buildPath`
(`media-store.ts:439`), `framePath` (`retrain-frame-store.ts:159`).

**Where the problem concentrates — three files:**

1. **`calendar-scan.ts` redoes the `<dev>/<profile>/Y/M/D/H` layout by hand seven
   times** (`:85, :100, :149, :193, :246, :298-306, :334`) without touching either
   `hourDirRelPath` or `parseSegmentPath`. **And it does not read the ledger at all**:
   it is what `getAvailability` and `getDaysWithRecordings` answer from. It must be solved in a
   completely independent way.
2. **`location-class-wipe.ts` exists TWICE, byte for byte identical** — in
   `addon-pipeline/src/recorder/addon/` and in
   `addon-post-analysis/src/pipeline-analytics/retention/`. Both copies
   `readdir` the root and treat **every** dirent as a camera, then
   emit `rm -rf <root>/<name>/<subtree>`. `resolveClassDir` validates the
   *shape* (two levels, no symlink, no escape) but **never** that the name
   is a known device.
3. **`location-occupancy.ts`** derives the camera identity **from the directory
   listing**, not from a device row (`:67, :79-87`) — and it is the verdict
   that authorises the deletion of a location (D327).

Those three files are what makes the change **leak**: two derive the identity
from the filesystem instead of from the registry, and one duplicates the layout.

> **Correction to what I had written just above in this revision.** I had
> said «the recorder is ~90% channelled». It is false, and the full census
> contradicts it: what is channelled is the *core* (finalize, relocate, playlist, index,
> ledger), not the perimeter (calendar, staging, wipe, occupancy, export).

**The practical consequence is one more phase, not a no.** A *prerequisite*
refactor that routes every inline join through
`segmentRelPath` / `hourDirRelPath` / a new `deviceDirRelPath()` **reduces the
17 inline constructions to ~3** and makes the `deviceId → storageKey` swap a
compiler-guided signature change. That refactor is pure tidying, does not
change behaviour, and is verifiable on its own. **Form C must be planned in
two phases, and the first has nothing to do with the migration.**

Gifts found along the way: **`segment-store.ts:132` is dead code** — zero
callers, production or test — so it is one of the 17 to *delete*, not to
migrate. And `index.ts:1110` and `:2620` write **the same expression twice**
for the export path.

**The validation point that the coordinator asked for is a line:**

```ts
// recording-index.ts:314-315, today
const p = parseSegmentPath(path)
if (!p || p.deviceId !== deviceId) return null
```

It becomes `if (!p || !readKeys.has(p.storageKey)) return null`, and the row carries
**the owning `deviceId`**, which the caller already knows. **Yes: the
validation can become "agrees with the declared prefix"**, and it is the right place because it is already
the only point that decides whether a segment row exists. It is
also the one that fails **worst** if forgotten: `hydrateHour` discards
every path whose first component ≠ `deviceId`, so a camera whose
prefix does not match hydrates **zero** segments, with `changed = false` and
**no log line**.

**The 7 authorities inferred from the path** — those that are not solved by changing
a signature, because each must stop *inferring* and start *resolving the
owner*:

| # | Site | What it decides |
| --- | --- | --- |
| 1 | `staging-reconcile.ts:460-478` — `Number(deviceDir)` from the name of a dir in `.rec-tmp` | which `segmentSeconds` bounds the heuristic, **which `deviceId` is stamped on the recovered segment** (`:503`), and the tag of every log (`:513`). The strongest in the repo |
| 2 | `recording-index.ts:448-451` (`removeSegments`) | the only thing that routes a de-index towards a device map. A prefix that does not match **makes the removal a silent no-op** |
| 3 | `recording-index.ts:314-315` (`rowFor`) | whether a row exists — total and mute failure |
| 4 | `segment-hour-ledger.ts:1131-1140` and `:1374-1383` | **to which camera the bytes are charged** and **which footage is deleted** (see the defect below) |
| 5 | `location-class-wipe.ts:89-118` ×2 copies | an `rm -rf` |
| 6 | `location-occupancy.ts:79-87` | whether a location can be deleted |
| 7 | `recording-provider.ts:444` + `authenticated-file-server.ts:93-103` | **see §6.3.3-bis: the URL IS the path** |

> **A latent, PREREQUISITE defect, which holds regardless of this
> function.** `oldestSegments` (`segment-hour-ledger.ts:1134`) and `rowsForHours`
> (`:1377`) build the `SegmentRow` taking the `deviceId` from
> `parseSegmentPath(path)` **instead of from the row's column**. Those rows
> end up in `dropSegments` and `repointSegments`, whose key is
> `hourOf(row)` = `segmentHourKey(row.deviceId, …)`. **So today the
> durable key is re-derived from the first component of the path at every eviction and
> at every drain.** As long as prefix and `deviceId` coincide it is not visible; as soon as
> they diverge, every eviction and drain write **becomes a silent no-op
> while the caller counts it as done**.
>
> The same repo already has the right precedent and documents it:
> `ghost-location-sweep.ts:537-560` takes `deviceId`/`profile`/`locationId`
> **from the row** and only `startMs`/`durMs`/`bytes` from the file name, with a
> docblock explaining that mixing them makes «no-ops silently while the pass counts it
> as done». The two ledger sites do not follow that rule.

#### 6.3.3-bis · The playback URL **is** the on-disk path

The most uncomfortable discovery of the census, and I had not foreseen it.
`recording-provider.ts:444` strips the first component **by position**
(`c.rel.split('/').slice(1).join('/')`) and serves the rest as a URI relative to the
playlist's device directory; `playbackRoots()` (`index.ts:2428`) and
`resolveFilePath` (`authenticated-file-server.ts:93-103`) try the same
`rel` against every root. **The HTTP path `<deviceId>/<profile>/Y/M/D/H/x.m4s` and the
relative on-disk path are the same string.**

So separating identity from storage forces an explicit choice:

- **(a)** the URL keeps carrying the `deviceId` and the plan does a
  `deviceId → storageKey` rewrite at the entrance (`index.ts:1199`) — a single point, but one
  more point on the hot path of every served segment;
- **(b)** the URL carries the `storageKey` — no rewrite, but **a URL space
  changes** that the players hold in hand.

It must be decided before writing code: it is §9-D12.

**Outside the problem, verified**: `addon-remote-storage/**` contains no
`deviceId` anywhere — S3/SFTP/SMB/WebDAV only see an opaque `relativePath`,
and are transparent to the change. `orphan-audit.ts` never touches a
path. `media-relocate-engine.ts` moves the blobs reading `path` **from the
row**, never rebuilding it. And `location-occupancy.ts` treats `<camera>` as
an opaque name: it is already agnostic (but see authority #6 above).

#### 6.3.4 The hour ledger: what it becomes

**There is ONE row shape**, not two — the collection `recorder:segment-hours`
with primary key `key` and the columns `deviceId, profile, locationId,
hourStartMs, paths, bytes, segments, minStartMs, maxStartMs`
(`segment-hour-ledger.ts:107-118`). What looks like «two halves» are **two
projections of the same row** (D287): the summary without `paths` that the boot
reads, and the full one that re-derives the aggregates from `paths`. And `locationKey`
(`:1803`) **is not a durable key**: it is an in-memory `Set` used only by
`refusedPrunes`, it never touches SQLite.

The durable key is
`` `${deviceId}|${profile}|${locationId}|${hour}` `` (`:442-449`).

Under form C the first component becomes the `storageKey`, and the `deviceId`
column stays and means **the owner**. Hence three consequences, all
good:

1. **The key never changes.** Not at introduction (the `storageKey` is born
   equal to the `deviceId`), and not at migration (the key space changes hands
   *with its name*). **No re-key.** Which matters, because the ledger has
   neither a version stamp nor re-key machinery: `repairAggregates` (`:1408-1447`)
   is the right precedent for a *value* backfill — predicate on the default,
   per-pass limits, resumption at the next boot — but it rewrites under an
   existing key, and **no current path does `put(new)` + `forget(old)`
   atomically**. Not having to do it is half the reason form C is
   practicable.
2. **The `paths` are never rewritten.** They are relative to the root and start with the
   prefix; they stay valid as long as the prefix is numeric. At steady state they are
   ~460 MB of projected JSON: not touching them is not a detail.
3. **The migration touches the ledger only with a column UPDATE.** A's rows
   change `deviceId` from A to B. At the measured scale — **~19,000 hour rows
   today across the whole fleet**, ~47,000 projected at 28–30 TB — that is a few
   hundred rows per camera, on an already-indexed column
   (`idx_recorder_segment_hours_device`).

> **Correction to what I had written in §0 of this revision.** I had said
> «the ledger is not touched at all». It is not exact: **keys and `paths` are not
> touched, the `deviceId` column is.** The difference with form A remains
> enormous — no re-key, no merge, no bytes — but «zero rows» was a
> simplification and I correct it.

The three consumers that today read the hour row's `deviceId` as authority
— the charging in `getStorageUsage` (`archiveAccounting`), retention
(`evict-select.ts`) and the placement planner — keep working
**without changes**, precisely because the column stays the owner. It is the
sites that infer from the *path* that have to change (§6.3.3), not those that
read the column.

#### 6.3.5 What form C does NOT solve

It must be said clearly, because it is half of the answer:

- **The analytics rows must be rewritten anyway.** `tracks.deviceId`,
  `media.deviceId`, `object-events.deviceId` … are columns on which every query
  filters. Form C removes **the moving of the bytes**, not the rewriting
  of the rows: ~250,000 media rows remain on the hub, plus tracks and events. They are
  however indexed, transactional and resumable UPDATEs — minutes, not hours, and
  without the filesystem's silent risk.
  *(Those could also be saved by bringing the analytics queries to
  reason by key space instead of by `deviceId` — same idea, but it
  touches every query and every index of the addon. I mention it as an option, I do not
  recommend it.)*
- **It does not solve the exports** — §6.4.
- **It does not solve anything that has already left the hub**: share links, deep links
  in the notifications, grids on the phones. They remain in category 3.

#### 6.3.6 The risk, and it is the one this repo has already paid for

Form C **creates a second identifier per device**. It is exactly the shape
of the «second authority» that produced D62 and D224. It survives only with two
absolute rules:

1. **The derivation from the `deviceId` must be DELETED, not kept as a fallback.** If
   both routes survive, a reader left behind charges the bytes
   to the wrong camera or deletes its files. A fallback here is worse than an
   error.
2. **An unknown key set FAILS CLOSED** — it serves nothing — and in
   particular **does not fall back to the `deviceId`** (D49: the destructive direction
   needs a successful read). And since the key sits on the device row
   while the path is built inside post-analysis, that fact
   crosses an addon boundary: it must be kept fresh **in the addon that owns the
   device** and mirrored by the reader with D224's discipline, never copied.

A third effect to regulate: a directory whose `storageKey` belongs to
no row is a **new state** («orphan»), which does not exist today. An explicit
policy is needed, otherwise it is invisible footage that no pass evicts.

---

### 6.4 The exports under form C — the hardest point

The coordinator is right to call it that, and the honest answer comes in two
beats.

**First beat: form C, on its own, changes nothing here.** A and B remain two
rows with two distinct `deviceId`s, and all three «numeric» exporters
publish the `deviceId`:

| Ecosystem | What happens after the migration |
| --- | --- |
| **HomeKit** | A's accessory (UUID from `camstack:camera:<A>`) stays **paired, in its room, inside the scenes — and empty**: no stream (dead hardware), no history (moved to B). B appears as a **new** accessory, to be added to rooms, scenes and automations |
| **Alexa** | `endpointId` = `String(A)` stays a dead endpoint; B is a new endpoint. Amazon updates only on an `AddOrUpdateReport` that we push |
| **Google Home** | `id` = `String(A)` likewise, and **there is no `requestSync`**: until the operator says «sincronizza i dispositivi» [sync the devices], Google stays misaligned |
| **Home Assistant** | keyed on `stableId`, which form C does not touch: B gets a **new HA device**, and A's stays orphan with its recorder history |

And the **HKSV clips already on iCloud** are attached to A's accessory and are a
one-way sink: **they do not come back in any form**. That is lost, full stop.

**Second beat: it is solved by extending the same idea to the published identity.**
The census says it is possible, because **every exporter has exactly one
derivation point**:

| Ecosystem | The single point | Constraint on the token |
| --- | --- | --- |
| HomeKit | `accessoryUuidFor(kind, deviceId)` (`export-hap/src/mappers/kind.ts:72`) — the docblock says *«One function, because three call sites depend on the answer agreeing»* | none: it is a string hash |
| Alexa | `String(deviceId)` outgoing, `parseCameraEndpointId` incoming (`export-alexa/src/handlers/endpoint-id.ts`) | **non-negative integer** |
| Google | `id: String(facts.deviceId)` (`export-google/src/google-home/device-model.ts:87`) | numeric in fact |
| Home Assistant | `deviceKeyFor(device.stableId)` (`ha-export/topics.ts:27`, called by `entity-catalog.ts:305`) | string |

If each one derived from a **published-identity token** stored on the row
— with initial value exactly today's, hence still a no-op — then
transferring the token transfers the accessory: **HomeKit sees the same
accessory and keeps pairing, room, scenes and automations; Alexa and Google
see the same endpoint; HA sees the same device.**

It is the generalisation of the coordinator's proposal: *every identity that
CamStack publishes to the outside — the on-disk prefix, the HAP UUID,
the Alexa `endpointId`, the Google id, the HA key — is today **derived** from an
internal id. Making it a transferable attribute of the row, with a default equal to
today's derivation, turns «migrating» into «transferring the tokens».*

**What can be promised, and what cannot:**

- ✅ **We will promise** that the HomeKit pairing, room, scenes and
  automations survive — *if* the HAP token is built. The UUID is a string
  hash, so the technical constraint is nil.
- ✅ **We will promise** that Alexa and Google keep seeing the same endpoint,
  **provided that the operator launches a sync** on Google (we do not have
  `requestSync`).
- ✅ **We will promise** that HA keeps entities, area and history — *if* the token
  also covers `deviceKeyFor`.
- ⚠️ **We will NOT promise that the HKSV clips already in iCloud continue their
  history.** Even with the same UUID, the hardware behind changes resolution and
  codec, and **I have not verified** how Apple behaves. It must be treated as
  unknown until proven on a real device.
- ❌ **We will promise nothing** for share links, deep links and grids on the phones:
  those carry the `deviceId`, are already distributed, and no token
  reaches them.

**The flip side, and it must be decided with open eyes**: §1 documents that HAP's camera
namespace is declared **FROZEN** precisely because changing it *«would make
every paired camera a stranger»*, and the HA topics' docblock warns that a
topic is a wire format and changing it *«silently detaches every entity from its
value»*. A token that **preserves** today's value violates neither
— it respects them better than any alternative. But it is the same trap as
the second authority of §6.3.6, multiplied by four exporters: the old derivation
must be **deleted**, never left as a fallback.

---

### 6.5 Form D — the original row survives and changes hardware **and provider**

**Verdict: it holds, and it is the best of the four.** It is the recommendation. But
it is not «a row»: it is a small **tree**, and on this hub the branch concerns
**20 cameras out of 31**.

The operator's idea: the **original** device row survives and is re-pointed
at the new hardware — also rewriting the `addonId`, which was the limit
that confined form B to the same provider. The new camera's row is
deleted. **The `deviceId` never changes.**

#### 6.5.1 Why it is better than the other three

Everything that forms A and C had to move, rewrite or re-attribute
**does not move, because it was never elsewhere**:

| | A | C | **D** |
| --- | --- | --- | --- |
| Bytes on disk | 264 GB moved | 0 | **0** |
| Hour ledger keys | merged (collision) | unchanged | **unchanged** |
| Ledger `deviceId` column | rewritten | rewritten (~600 rows/cam) | **intact** |
| Analytics rows (~250k) | rewritten | rewritten | **intact** |
| Rules, mutes, outbox, ACL, bindings | rewritten | rewritten | **intact** |
| Zones, thresholds, scenes, phantom cells | to be copied | to be copied | **intact** |
| **HomeKit / Alexa / Google** | hanging on the dead camera | hanging on the dead camera | **valid by construction** |
| Share links, deep links, grids on the phones | broken | broken | **valid** |
| Prerequisite refactor | no | **yes, big** | **no** |

The reason is a single one and it is worth isolating: **every identity that this system
publishes to the outside derives from the `deviceId`** — the HomeKit UUID
(`camstack:camera:<deviceId>`), the Alexa `endpointId`, the Google id, the on-disk
prefix, the playback URL, the deep links. If the `deviceId` does not change, **there is
nothing to transfer**: the hard problem of §6.4 is not solved, it *disappears*.
And the published-identity token of §6.4 / D13 **is no longer needed**.

#### 6.5.2 The primitive already exists, and is exercised at every reconciliation

I had written (§1, point 3) that the three identity columns are «not patchable
by construction». It is true for `DeviceRowStore.patch`, and it is **false in general**:
`upsertRegistration` (`device-row-store.ts:806-825`) is a `set` **keyed on the
numeric `deviceId`** that writes `addonId` and `stableId` verbatim. It is what
`registerDevice` calls at **every** provider reconciliation
(`device-meta-actions.ts:165`).

And it writes **only the columns it names**. The comment at `:159-164` is explicit:

> *«Every operator-edited field the blob shape had to re-state to avoid
> clobbering it (`integrationId`, `linkDeviceId`, `primaryChildEntityId`,
> `childLayout`, `role`, `display`, `metadata`) is simply NOT NAMED here: the
> statement lists its columns, so preservation is the default.»*

So the central write of form D **is already `registerDevice`**, called
with the old `deviceId` and the new identity. It keeps the name (with the
`resolvedName`/`userNamed` logic that protects an operator rename), room,
role, icon, metadata; it updates `type` and `features`; it emits
`DeviceMetaChanged`.

> **Correction to an earlier claim of mine, and it is important.** I had
> written that «since the fingerprint changes, `DeviceProvisioned` is emitted,
> which is the signal by which the exporters reconcile». **It is false.**
> `canonicalDeviceFingerprint` hashes **only `{deviceType, features}`**
> (`packages/types/src/utils/export-reconciler.ts:55`) and the `deviceId` that is
> passed to it (`device-meta-actions.ts:154-158`) **is discarded**. The
> `stableId` does not enter the fingerprint at all.
>
> Practical consequence: **replacing a camera with one of the same model
> produces an identical fingerprint**, so `fingerprintChanged === false` and
> `DeviceProvisioned` **is never emitted**. No exporter is notified.
> Form D must **trigger the re-provision explicitly** — it cannot
> count on the signal, which is exactly the case «the action declares success
> without having had it» of D333.

**Correction to §1, point 3**, which I leave on the record: a new primitive
is not needed to rewrite the identity. A **guided operation** is needed that uses it
deliberately and does the surrounding work.

> **And the database does not protect you.** `idx_dm_devices_addon_stable`
> (`device-row-store.ts:169`) is a **plain index, not `UNIQUE`**:
> the uniqueness of `(addonId, stableId)` holds only «by construction», because
> `allocateDeviceId` is the only way that mints a row. A direct rewrite
> bypasses that construction. If the destination pair is already taken,
> `findByStableId` resolves to the row with the **lowest `deviceId`**, emitting
> only a `warn` (`:627`). **The operation must REFUSE when the pair
> is already occupied**, because nothing else will.

#### 6.5.3 The surrounding work, and it is where the real work lies

**(a) The driver configuration moves BACKWARDS.** It is the least
obvious point of form D. The per-device settings have id
`<addonId-of-the-writer>:<deviceId>.<key>`
(`settings-door-view.ts:178`, `:212`), so:

- `pipeline-orchestrator:101.zones`, `pipeline-analytics:101.*` — **are not
  touched**: the key contains the addon that wrote them, not the device's provider. It is the
  check the coordinator asked for: **zones, fraction-of-frame thresholds, scene
  monitors and phantom cells stay attached to the row that survives, without
  copying anything.**
- `provider-hikvision:101.*` (host, credentials, `deviceCache`) stays **orphan**.
  Harmless — `deviceId`s are never reused, so nobody will reread it — but it is
  dead weight to be cleaned up.
- `provider-reolink:4300.*` is where **the new camera's credentials** live,
  and it is the only thing that has to travel: **from 4300 to 101**. Without that step the
  new provider reconciles on 101 and finds an empty config: camera offline.

> Said in one line: **in form D nothing migrates except the driver
> configuration, and that moves the other way** — from the just-adopted row to
> the surviving one. Everything else does not move because it was never
> elsewhere.

**(b) The `integrationId` must be re-stamped.** Row 101 carries `int_0013` (the
Hikvision integration). If it stays, `removeByIntegration('int_0013')` —
or the deletion of that integration — **deletes the migrated camera**. The
comment on `adoptDevice` says so: the `integrationId` is stamped *«so
`removeByIntegration` can cascade it»*.

**(c) The children, and it is the real cost.** Measured on the hub: **20 cameras out of 31 have
child devices, 30 in all** (sirens, lights, switches). A child's `stableId` is
derived from the parent's — `` `${parent.stableId}-acc-${kind}` ``
(`hikvision-camera.ts:3165-3183`) — so re-pointing the parent **breaks the
derivation of every child**: the new provider looks for `mac-new-acc-siren`, does not
find `mac-old-acc-siren`, and **creates a child with a new `deviceId`**.

The composition lives in the **kernel**, not in the providers:
`device-cap-proxy.ts:786` does `` `${parent.stableId}-${spec.stableIdSuffix}` ``, and
the providers only supply the suffix (`acc-${kind}`). And it is the **pruning** side
that bites: `:1229` builds `expected` from the suffixes on the parent's **live**
`stableId` and `:1300` **deletes every linked child that is not in `expected`**.
After a rewrite of the parent, the persisted rows say `mac-old-acc-siren`
while `expected` contains `mac-new-acc-siren`: **all the accessories are
classified orphans, deleted and recreated with a new `deviceId`.**

The same file documents the disaster that already happened for another cause
(`:1279-1283`): *«Observed catastrophic outage on device 54: two onProbe
timeouts in a single day produced two waves of orphan deletion, each rotating
accessory IDs (55/56/57 → 60/61 → …) and breaking persisted bindings.»*

**The good news: the cascade onto the children is automatable and there is already a
precedent in the repo.** `scripts/reolink-stableid-backfill.py:148` implements
exactly this (`if child_stable.startswith(old_stable + '-')`), and so does
`scripts/hikvision-stableid-backfill.py`. Beware: those scripts predate the
migration to the row-store and modify the now-retired `deviceMeta`/`deviceIndex` blobs
— they are a **model, not a tool**.

**`primaryChildEntityId` on the parent** must also be rewritten: for a camera it contains
the child's full `stableId`, because no camera provider ever calls
`updateSourceInfo` (verified on reolink, hikvision, onvif, amcrest, rtsp,
wyze) and the fallback is the `stableId`. Instead `childLayout[].childKey` does **not**
break: it contains only the *suffix* and is recomposed at render time from the
parent's live `stableId` (`ui-library/src/composites/device-item/child-layout.ts:61`).

`adoptionResync({ camDeviceId, resetToSource: true })` is the alternative that
removes the direct children and lets the provider re-derive them — but it **does not
preserve the children's ids**. Therefore:

- **The parent's `deviceId` is preserved; the children's is not**, unless
  the same re-pointing is applied **recursively** to the children — possible only
  where the accessory types **match** (siren↔siren). A Hikvision with a
  siren replaced by a Reolink with siren+light: the siren maps, the light
  is new.
- Everything that names a **child** by `deviceId` — its HomeKit accessory,
  the Alexa endpoint `101__616`, a rule that names 616, an automation — breaks
  anyway.

**Form D is not the rewriting of a row: it is the rewriting of a small
tree, with a children PAIRING step** that somebody must decide. It is
its main complexity, and it concerns two thirds of the fleet.

**(d) The old provider.** `findByStableId('provider-hikvision', 'mac-old')`
after the re-pointing finds nothing. Therefore:

- if the old camera is **physically gone** (the use case), the discovery
  does not find it and **no duplicate is born**;
- if it is **still on the network** (reused elsewhere, not switched off), the next
  discovery sees it as a new candidate and — if the operator adopts it — a
  new device is born with a new `deviceId`. It is not a duplicate of the migrated row:
  it is a different camera, correctly.

**The precondition to impose and to state: switch off or unplug the old camera
before migrating.**

**(e) Two `(device, capability) → addonId` pins that live OUTSIDE the
device-manager.** This is the real answer to «what keeps believing that the old
provider owns that device», and it is not where I was looking: there is no
second per-addon device store: there is something worse, a JSON file.

- **`deviceActivation`, durable and in no storage map.**
  `ConfigManager.setDeviceActivation` (`config-manager.ts:650`) writes
  `deviceActivation[<deviceId>]["<capability>/<addonId>"] = boolean` inside
  **`<dataPath>/runtime-state.json`** (`:179`), not in SQLite — which is why
  it does not appear in `docs/reference/storage.md`. And it is **read on the live
  capability-resolution path**: `isActiveForDevice`
  (`capability-registry.ts:1364`) is consulted at `:1416`, `:1505`, `:1517`,
  `:1524` and `:1579`.
  **It has no live writer** — the only caller is
  `capability-registry.ts:1389`, and nothing calls that. So the file may
  contain only entries left by older builds; but those **survive form D
  and keep gating on the OLD provider's `addonId`**,
  invisible to `deviceBindings` and to `getBindings`.
- **`deviceOverrides`, in memory but settable by the operator.**
  `capability-registry.ts:1444` (`setDeviceOverride`), exposed as
  `capabilities.setDeviceCapability` (admin, `capabilities.router.ts:98` and
  `:210`). It names a provider addon per device; **it is lost at restart**, so
  after form D it keeps pointing at the old provider as long as the process
  lives.

**Consequence for the procedure**: form D must **inspect and clean up
both** for the migrated `deviceId`, and cleaning `deviceActivation` is a
file rewrite, not a tRPC. It is also an excellent candidate to become a
leftover to delete entirely (D183): a durable state that nobody writes
any more but that still decides.

**(f) The `addon:` prefix trap.** `AddonContext.id` is bare for forked
addons and prefixed `addon:` for the hub-main builtins
(`packages/types/src/utils/addon-id.ts`), while every durable store writes the bare
form — including `providerAddonId` and `wrapperAddonId`. The post-mortem is D72
(`virtual-doorbell.addon.ts:310`). **Every new comparison introduced by form
D must go through `bareAddonId()` / `isSameAddonId()`**, and
`scripts/check-addon-id-comparison.ts` enforces it.

#### 6.5.4 Does the `stableId` leave the system? Yes, through **three** doors — and one is the SDK

The operator asks explicitly. The answer is **yes, and it is worse than a
single loss**: besides Home Assistant and the Reolink NVRAM, the
`stableId` is on the **public surface of the extensions** —
`@camstack/sdk` exposes `getDeviceByStableId(stableId)`
(`packages/sdk/src/system.ts:746`). Any operator block or
third-party extension may have `mac-040312a373d4` written inside it, in
code that CamStack does not see.

**Where it does NOT reach** (verified: zero occurrences of `stableId` in those
packages): **HomeKit, Google Home, Matter and the MQTT broker** are all
keyed on the numeric `deviceId`. In form D nobody touches them.

| Reference | What breaks | Automatically repairable? |
| --- | --- | --- |
| ~~**Home Assistant export**~~ **(superseded — it no longer breaks)** — the key is now `camstack-<deviceId>`, so a migration that KEEPS the numeric does not touch any HA entity. What follows describes the earlier world | HA sees a **new** device; the old one **never goes away** — the protocol has no removal message (`PushMessage` is `state_update \| entity_change \| heartbeat \| batch`, `types.ts:227`). It stays as an *unavailable* orphan next to the duplicate, with recorder history, area, dashboards and HA automations attached | **No.** The target of the write is HA's registry. Operator gesture, mandatory. **It is the highest cost of form D** |
| **`allowedDevices` ACL** (`auth-schema.ts:94` users, `:111` API keys) | the user loses live access (`live-events.router.ts:83-93`, *«Access denied»*) and **silently drops out of the notification fan-out** (`notification-center/index.ts:5101-5102`) | **Users: yes** — `userManagement.updateUser`. **API keys: NO** — the cap exposes only list/create/revoke/validate, there is no `updateApiKey`. The row *is* patchable (`api-key-manager.ts:63-67`, and the `tokenHash` is preserved) but no path does it: a new write route is needed, or revoke + reissue + redistribute |
| **Automations** (`sourceStableId`, serialised **twice** per binding: `codegen.ts:67` and `:218`) | the leaf does not resolve and **is evaluated `false` for ever**, with a log and no error (`codegen.ts:344-348`) | **Yes**, but the replacement must be written through the update path that **recompiles** (`core-block-store.ts:11-13`): a direct SQL `UPDATE` bypasses that guarantee. (On this hub: **0 blocks**) |
| **Reolink SMTP push** (`cam-<stableId>` in the camera's NVRAM) | the resolver looks for `cam-<new-mac>` (`email-push-server.ts:194`); if the new camera was adopted normally its firmware is already configured that way and **matches**. If auto-configure never ran on it, every delivery is refused with `550 Unknown recipient` and **motion events stop silently** | **Yes** — re-run `setupEmailPushToManager` + `refreshCameraEmailConfig`, but the camera must be **awake** |
| **Alexa endpoint cookie** (`builder.ts:399` and 3 others) | **nothing.** CamStack never rereads it: every handler routes on `endpointId`, which is numeric | no repair needed |

**Correction to what I had written**: I had listed **Terminal** among the
references that break. **It is out of scope**: the `stableId`s of the terminal
cameras derive from the **nodeId**, not from a MAC
(`terminal-camera-declarations.ts:31-38`, `terminal-camera-${nodeId}`).
Replacing a physical camera cannot touch them. And I had said that Reolink SMTP
«does not break by construction»: it is true **only if** the new camera was
adopted with auto-configure active — it must be verified, not presumed.

**Two more operational traps:**

- **The notification centre's route cache has no TTL and no invalidation**
  (`notification-center/index.ts:5042`, `:5089-5090`): after the rewrite the
  notification centre keeps the old `stableId` **for the whole life of the
  process**. `userGrantsCache` has 60 s, this one does not. An explicit invalidation
  or a runner respawn is needed.
- **`DeclaredDevices.sweepWithdrawn` prunes by `stableId`**
  (`declared-device.ts:438-440`). If a driver starts declaring the new MAC
  **before** the column is rewritten, the old row is reaped
  as «withdrawn» and **its `deviceId` is lost**. The order is non-negotiable:
  **first rewrite the column, then let the provider re-declare.**

#### 6.5.5 The new camera: what is lost by deleting its row

Little history (it was just adopted), but **not zero, and it does not delete
itself**. `removeDevice` deletes the row, the per-device config, the runtime state,
the bindings and the remote-cap cache — it does **not** touch recordings or
analytics. So 4300's bytes stay on disk at `<root>/4300/…`, count
towards the location's occupancy (`location-occupancy.ts`) and may prevent its
deletion, and no retention pass reaches them any more because the
camera's retention config was deleted with the row.

**Ordering constraint: purge BEFORE removing.**
`recording.deleteFootprint({ deviceId: 4300 })` and
`pipelineAnalytics.wipeAllAnalytics({ deviceId: 4300 })` — after the removal
that `deviceId` is no longer addressable by the normal APIs.

The new camera's **exports**, instead, clean themselves up: all four
exporters have `unexposeDevice` and HA is subscribed to
`DeviceUnregistered` (`ha-export.addon.ts:449`).

#### 6.5.6 What is NOT preserved anyway, in form D

1. **The children's `deviceId`s** (§6.5.3c) — 20 cameras out of 31 on this hub.
2. **The camera's Home Assistant export** (§6.5.4).
3. **The old driver configuration**: host, credentials, channel, stream
   profile map. It is intended — it is the «camera configuration» that the
   operator excluded — but it must be said that it *disappears*, not that it *adapts*.
4. **The capability bindings that the new provider does not offer.** A per-camera
   switch is a view onto `setWrapperActive` (D62) and
   `listBindableCapsForDeviceType` decides whether it exists: a Reolink may not offer
   a cap that the Hikvision offered. It must be reported entry by entry
   (`{ switchId, restored | unavailable }`), because a switch that cannot be reactivated
   must not look like one turned off by the operator.
5. **The HKSV clips already on iCloud** stay associated with the accessory — which here
   **survives**, so in theory they continue. *I have not verified it*: the hardware
   behind changes resolution and codec, and I do not know how Apple behaves (§10).
6. **The history that the new camera had accumulated** since adoption (§6.5.5).

---

## 7 · The proposed procedure, step by step

### 7.0 Form D (RECOMMENDED) — «replace hardware and provider, keep the number»

Operator precondition: **the old camera is switched off or unplugged**, and the
new camera has already been adopted normally (row B, e.g. 4300).

| # | Step | Note |
| --- | --- | --- |
| 0 | **Refuse** if B has significant history, or if the device type does not match | B must be a freshly adopted camera, not a second installation |
| 1 | **Propose the children pairing**: A's children by type, B's children by type, and the map that the operator confirms | it is the step that form D adds, and it concerns 20 cameras out of 31 (§6.5.3c) |
| 2 | **Purge B's history**: `recording.deleteFootprint({deviceId:B})` + `pipelineAnalytics.wipeAllAnalytics({deviceId:B})` | **before** removing it: afterwards it is no longer addressable (§6.5.5) |
| 3 | Freeze the framing on A: turn off `stream-broker`, `object-detection`, `audio-analysis`, `recording`, `notifications` via `setCameraSwitch`, and **verify** that they answer off. **Never `privacy-mask`** | and **freeze the list**: it is the one that is turned back on at step 10 |
| 4 | `RecordingController.pause()` on A; wait for the TTL of in-flight tracks | existing primitives (§4.2) |
| 5 | **Move the driver config** from `provider-<new>:B.*` to `provider-<new>:A.*` | without this the camera stays offline (§6.5.3a) |
| 5b | **REFUSE if `findByStableId(<new>, <new-mac>)` already resolves to another row** | the index is **not `UNIQUE`**: the database does not stop you, and a duplicate pair silently resolves to the lowest `deviceId` (§6.5.2) |
| 6 | **The central write**: `registerDevice({ addonId: <new>, stableId: <new-mac>, id: A, type, name, features, … })` under the meta lock | preserves room, role, icon, metadata and the operator's rename (§6.5.2). **It must happen BEFORE the new provider re-declares**, or `sweepWithdrawn` reaps the old row and the `deviceId` is lost |
| 7 | **Re-stamp `integrationId`** with the new provider's | otherwise `removeByIntegration` on the old one deletes the migrated camera (§6.5.3b) |
| 8 | Apply the children pairing: cascade onto every child row whose `stableId` starts with `<old-mac>-`, keeping the suffix; then rewrite `primaryChildEntityId` on the parent | model in `scripts/reolink-stableid-backfill.py:148`. `adoptionResync(A, resetToSource:true)` is the alternative that recreates everything losing the ids (§6.5.3c) |
| 9 | `removeDevice(B)`; then let the new provider reconcile and **verify that A answers from the new hardware** (snapshot or probe) | if it does not answer, step 6 is reversible by rewriting the old identity |
| 10 | **Turn back on, on A, exactly the switches frozen at step 3**, and report entry by entry `{ switchId, restored \| unavailable }` | a cap that the new provider does not offer is **not** a switch turned off by the operator (D62) |
| 10b | **Trigger the exporters' re-provision EXPLICITLY** | the fingerprint does not change on a camera of the same model, so `DeviceProvisioned` **does not arrive by itself** (§6.5.2) |
| 10c | **Invalidate the notification centre's route cache** (or respawn the runner) | it has no TTL: without this the notification centre uses the old `stableId` as long as the process lives (§6.5.4) |
| 10d | **Inspect and clean up the two `(device, cap) → addonId` pins outside the device-manager**: the `deviceActivation` entries for this `deviceId` in `runtime-state.json`, and every in-memory `deviceOverride` | they gate capability resolution on the **old** provider's `addonId`, invisible to `getBindings` (§6.5.3e) |
| 11 | **Rewrite the `allowedDevices` ACLs** replacing the old `stableId` with the new one, for every **user**, **counting the replacements**. For **API keys** there is no write route: either one is added, or the operator revokes and reissues | (§6.5.4) |
| 11b | **Rewrite the automations** that name the old `stableId`, through the update path that **recompiles** — never with a direct SQL UPDATE | (§6.5.4). On this hub: 0 blocks |
| 12 | **Answer with the counts, never with a boolean** (D333): `{ identityRewritten, configKeysMoved, childrenRepointed, childrenRecreated[], integrationRestamped, switchesRestored[], switchesUnavailable[], aclsRewritten, staleStableIdRefs[] }`, and name the sources that did not answer | |
| 13 | **Flag to the operator**, doing nothing automatically: this camera's Home Assistant export changed `unique_id` — the old entities must be removed by hand in HA, and the HA automations that name them must be re-pointed | it is the only manual cost (§6.5.4) |

**Reversibility.** Until step 8 the failure surface is a row and a
set of settings keys: rewriting the old identity brings everything back.
From step 8 (children) and 9 (`removeDevice(B)`) onwards it no longer does.
**The order is chosen so that the point of no return falls as late as
possible** — and step 2, which is destructive on B, is deliberately before
everything, so that «purge failed» means «we have not started yet».

### 7.1 Form B (discarded: same provider only) — «replace the hardware»

| # | Step | Who | Note |
| --- | --- | --- | --- |
| 0 | **Precondition**: A and B have the same `addonId`. Otherwise refuse with a message saying so | server | see §6.1 |
| 1 | Freeze the framing: **turn off** on A `stream-broker`, `object-detection`, `audio-analysis`, `recording`, `notifications` via `setCameraSwitch`, and **verify** that each answers off | server | never `privacy-mask` |
| 2 | `RecordingController.pause()` for A: close the open segment | server | existing primitive |
| 3 | Wait for the TTL of in-flight tracks (the camera's `maxTrackLifetimeSec`) | server | otherwise a track is persisted afterwards |
| 4 | **The atomic write**: A's `stableId` + identity `config` ← B's, under the meta lock, with refusal on duplicate | server | the only thing that changes on disk is a row |
| 5 | Remove B's row (`removeDevice`) | server | B has no history to lose: it was just discovered |
| 6 | Let the provider reconcile; verify that A answers from the new hardware (snapshot or probe) | server | if it does not answer: step 4 in reverse |
| 7 | **Turn back on, on A, exactly the switches turned off at step 1** — the list frozen at step 1, not «all» | server | D62: a switch that is off must be reported off, not turned on again by mistake |
| 8 | **Flag to the operator**, doing nothing automatically: (a) A's zones describe the old framing → redraw them; (b) the rules with `zones.ids` have been **disabled** pending the redrawing of the zones; (c) phantom cells / package background / stationary objects have been reset; (d) the four references by `stableId` to redo: HA export, `allowedDevices` per user/API key, automations with `sourceStableId`, terminal bindings | server → UI | see §9-D5, D6 |
| 9 | **Final verification that answers with the counts, not with a boolean** (D333): `{ stableIdChanged, configKeysRewritten, destinationRemoved, switchesRestored[], staleStableIdRefs[] }` — and names the sources that did not answer | server | `staleStableIdRefs` is what makes step 8 a measured fact, not a reminder |

Note on (b): disabling is the safe choice. Leaving them active with zones that no
longer describe anything does not silence them — it makes them `inert`, i.e. active on the whole
frame (§3.4).

### 7.2 Form A (if chosen) — «move the data»

Only the skeleton, because it is the plan that I recommend **not** building as a single
function:

```
plan → quiesce(A and B) → seal → repoint-rows(cursor per table)
     → move-files(per hour, target-first D291) → merge-hour-ledger
     → rewrite-rules → verify(counts the residues on A) → resume
```

Non-negotiable constraints if it is done:

- **one cap method, one durable job, one ledger** (D331). Never a sequence from the client.
- **target-first always** (D291): write the destination row before
  removing the origin one, otherwise the hour becomes unreachable for ever.
- **the hour ledger is MERGED, not overwritten** (§3.2), otherwise
  B's history is silently deleted.
- **a final verification pass that counts the residues on A and NAMES them** — on the
  model of `recording.reconcileLedgerAgainstDisk`, which already returns
  `byDevice[]` with `hoursMissing`, `ghostSegments`, `orphanFiles`.
- **freeze B's retention** beforehand, or the first pass deletes the history
  just arrived.
- no `Promise.allSettled` with the result discarded (D333).

---

## 8 · What we will NOT promise

The honest list, to be shown to the operator **beforehand**.

**In form D (recommended) — the list that counts:**

1. **The `deviceId`s of the child devices are not preserved** where the accessory types
   do not match. 20 cameras out of 31 have children on this hub. Everything that
   names a child (its HomeKit accessory, the Alexa endpoint `<parent>__<child>`,
   a rule, an automation) must be redone for those children.
2. **The camera's Home Assistant export breaks**: `unique_id` changes, the
   old entities stay orphan with recorder history, area and HA automations.
   It must be fixed by hand in HA.
3. **The old driver configuration disappears** — host, credentials, channel,
   stream profile map. It is intended, but it disappears: it does not adapt.
4. **The capabilities that the new provider does not offer stay off**, and are
   reported as `unavailable`, not as «switched off by the operator».
5. **The history that the new camera had accumulated since adoption must be purged**
   before removing its row, or it stays orphan on disk for ever.
6. **We will not promise that the HKSV clips already in iCloud continue their history.**
   The accessory survives, so in theory yes — but the hardware behind changes
   resolution and codec and **I have not verified it**.
7. **The old camera must be switched off or unplugged**, or a later discovery
   re-adopts it as a new device.

> **Beware of reading the list below as if it applied to D.** Almost
> nothing that follows applies to the recommended form: in form D nothing
> is copied, so zones, thresholds, scene monitors, phantom cells, automations
> that name the `deviceId`, share links, deep links and grids **keep
> working**, because the row they were attached to is the one that survives.
> The list stays because it documents the cost of the discarded alternatives.

**In forms A and C (discarded), in addition:**

1. **The zones must be copied explicitly** (the operator decided: copied
   **active**). They remain however the description of the old framing, and the
   trap of §3.4 — a destination without zones makes the gate `inert`, i.e.
   the rule fires on the WHOLE frame — is real only in these two forms.
2. **The privacy mask regions do not follow**: they live on the camera.
3. **The fraction-of-frame thresholds** (`minSpawnAreaFrac*`, `minFacePx`,
   `packageDropMin/MaxBboxAreaFrac`, `margin`) do not follow: they are calibrated on the
   distance of the subjects in the old framing.
4. **The scene monitors do not follow.**
5. **The stream profiles and the node/accelerator pins do not follow.**
6. **The `core_blocks` automations are not rewritten**: a `deviceId` inside
   the operator's code stays as it is.
7. **The anti-false-positive learning does not follow**: phantom cells, package
   background and stationary objects are maps of the old framing. The new
   camera starts from zero, and for a few days it will be noisier.
8. **The viewer-settings snapshots saved on the hub**
   (`viewer-settings-snapshots`) are not rewritten: they are opaque documents.

**In form B (discarded), in addition:**

9. **This camera's Home Assistant export breaks.** The entities change
   `unique_id`; HA recorder history, dashboard position and HA automations
   stay hanging on entities that nobody feeds any more. It is visible.
10. **The HA export membership** (`exportTo:<brokerId>`) must be rechecked by hand.
11. **The per-user and per-API-key ACLs** (`allowedDevices`, keyed by
    `stableId`) must be rewritten, or that user loses access to the camera.
12. **The automations that name the camera by `sourceStableId`** stop
    resolving it. They must be reopened and resaved.
13. **The terminal cameras' bindings** (`cameraStableId`, tombstone) must be redone.
14. **It does not work across different providers** without the extra work of §6.1.

**In form A, in addition:**

15. **HomeKit, Alexa and Google stay on the old camera**, silently. The
    HKSV clips already on iCloud are **unrecoverable and cannot be moved**.
16. **The share links already distributed** keep showing the old camera,
    and some never expire.
17. **The notification history on the phones** points to the old camera.
18. **The grids and preferences on every phone** stay on the old ids.
19. **There is no rollback.** Only resumption and detection of the residues.
20. **It is not instantaneous**: up to 62.6 GB per camera, hours if the two cameras are
    on different locations.

---

## 9 · Decisions for the operator

### D1 — Which form do we build?

Settled by revision 2: **form D**. A is too costly and does not solve the
exports; B is ruled out by cross-provider; C holds but asks for a big
prerequisite refactor and still does not solve the exports. They remain documented
in §6 with their reason.

**Consequence: D10, D11, D12 and D13 lapse** — they concerned form C and the
published-identity token, which form D does not need. I leave them on the record
because C's prerequisite refactor (§6.3.3) has a **value of its own**: it closes
the latent defect of the hour ledger. See D14.

### D2 — If we choose B: what happens to the device B already discovered?

- **Option 1** — removed automatically (`removeDevice`) at step 5.
- **Option 2** — left there, disabled, and you remove it.

→ **I recommend option 1**, but with a condition verified by the server:
remove only if B **has no history** (zero tracks, zero segments). If it does,
refuse the whole operation and say so — because that case is form A in disguise.

### D3 — If we choose A: on the row conflict (recording config, mutes, bindings, settings), who wins?

- **Option 1** — the origin wins (the settings follow the camera).
- **Option 2** — the destination wins (B keeps its own).
- **Option 3** — refuse if they disagree, and ask.

→ **I recommend option 1 for the settings not tied to the framing, with
a preview that shows you what will be overwritten.** Option 3 on twenty stores
becomes a questionnaire that nobody reads.

### D4 — If we choose A: the hour-ledger rows that collide?

- **Option 1** — merge (`paths` concatenated, counters recomputed).
- **Option 2** — refuse the migration if A and B recorded the same hour.

→ **I recommend option 1**, because option 2 would refuse practically every real
migration. But the merge must be written **target-first** (D291) and tested
by disarming it (a wrong merge deletes B's history silently).

### D5 — The notification rules that name zones

- **Option 1** — disable them and tell me.
- **Option 2** — leave them active (⇒ they fire on the whole frame).
- **Option 3** — also migrate the zones, with the same ids, so the rules stay
  valid *formally*.

→ **I recommend option 1.** Option 2 is a notification storm verified
in the code; option 3 gives you rules that fire on polygons that
correspond to nothing, which is worse because it looks like it works.
**Question for you**: do you prefer the zones to be **copied as a draft** (to be
dragged again onto the new framing) or **deleted**?

### D6 — The Home Assistant export, in form B

- **Option 1** — do nothing, just warn.
- **Option 2** — try to remove the old entities via HA.
- **Option 3** — keep the old `stableId` as the export key (an alias),
  so that HA does not notice the change.

→ **I recommend option 1.** Option 3 is tempting and wrong: it would create a
second identity identifier with a life of its own, i.e. exactly the kind of
second authority that this repo has already paid for several times (D62, D224). And it would not
save the other three consumers of `stableId` (ACL, automations,
terminal) anyway.
**Question for you**: do you really use the Home Assistant export on these cameras, or is it
active and unused? If it is unused, this whole column disappears.

### D9 — The `allowedDevices` ACLs in form B

`users.allowedDevices` and `api_keys.allowedDevices` are
`Record<addonId, stableId[]>`. Changing the `stableId` **removes that user's
access to the camera**, silently (an ACL that does not match is not an error:
it is an exclusion).

- **Option 1** — the migration rewrites them automatically (replaces the
  old `stableId` with the new one, for every user and every API key).
- **Option 2** — leaves them alone and flags them.

→ **I recommend option 1**, and it is the only automatic rewrite that I
recommend in the whole document. Reason: it is an exact string substitution,
in a list, with no semantics to interpret — and option 2's failure
mode is *silent loss of access*, the worst that
exists in an ACL. It must however be counted in the response (D333), never presumed.

### D10 — Do we build form C? And in two phases?

- **Option 1** — **Phase 1** (prerequisite refactor: route the 17 inline
  constructions through the helpers, fix the ledger's latent defect,
  delete the dead code and the duplicated copy of
  `location-class-wipe.ts`) → **Phase 2** (introduce `storageKey`, which at that
  point is a signature change) → **Phase 3** (the real migration).
- **Option 2** — Phase 1 only, and we stop there for a while. Phase 1 has a
  value of its own: it closes a defect that today makes eviction and drain silently
  no-ops if ever prefix and `deviceId` diverge.
- **Option 3** — form A (moving the bytes), accepting hours of copying, the ledger
  merge and no rollback.

→ **I recommend option 1**, and to treat **Phase 1 as work that has to be done
anyway**, regardless of whether «Migrate to…» is ever built.
Reason: the latent defect found by the census is not hypothetical — it is
a mine that goes off at the first misalignment between path and `deviceId`, and form C
is exactly what would produce it.

### D11 — The analytics rows: are they rewritten, or also brought to key-space?

Form C removes the **moving of the bytes**, not the rewriting of the rows:
~250,000 media rows plus tracks and events remain to be re-pointed from A to B.

- **Option 1** — they are rewritten (indexed, transactional, resumable UPDATEs:
  minutes, not hours).
- **Option 2** — the analytics queries also reason by key space, and nothing is
  rewritten. But it touches **every query and every index** of the addon.

→ **I recommend option 1.** Option 2 is coherent and tempting, but the
risk/gain ratio is terrible: it saves minutes of UPDATE at the
price of rewriting the hottest read path of the system.

### D12 — Does the playback URL carry the `deviceId` or the `storageKey`?

Today **they are the same string** (§6.3.3-bis).

- **Option 1** — the URL keeps carrying the `deviceId`, and the plan rewrites
  `deviceId → storageKey` at the entrance: a single point, but on the hot path of
  every served segment.
- **Option 2** — the URL carries the `storageKey`: no rewrite, but it changes
  a URL space that the players already hold.

→ **I recommend option 1.** A URL is a contract with clients that we do not
control, and this repo has already decided once to keep a tab id
so as not to break bookmarks (session note 2026-08-30). The rewrite is a
map lookup over ~31 entries.

### D13 — Do we extend the idea to the PUBLISHED identity (HomeKit, Alexa, Google, HA)?

It is the only thing that solves the pairing hanging on the dead camera (§6.4).

- **Option 1** — yes, a published-identity token per exporter, with initial
  value equal to today's derivation (hence still a no-op), transferred
  together with the `storageKey`.
- **Option 2** — no: we accept that HomeKit/Alexa/Google/HA must be redone by
  hand on the new camera, and write it in the list of what we do not
  promise.

→ **I recommend option 1 only AFTER form C is up**, and as a separate
decision. Reason: technically it is the same idea and every exporter has
**a single derivation point**, so it is little code; but it multiplies by
four the «second authority» risk (§6.3.6), and each of the four
namespaces is declared frozen or is a wire format. Doing it together with
form C means not being able to say which of the two broke what.
**Question for you**: among HomeKit, Alexa, Google and HA, which would hurt most
to redo by hand? If the answer is «only one», the token is built for that one and
that is it.

### D14 — Do we do C's prerequisite refactor anyway?

Form D does not need it. But the census done to evaluate C found
**a real latent defect**: the hour ledger's durable key is
re-derived from the first component of the path at every eviction and every drain
(`segment-hour-ledger.ts:1134`, `:1377`), instead of being read from the row's
column — unlike what `ghost-location-sweep.ts:537-560` does, which
documents exactly why it is wrong.

- **Option 1** — fix those two sites and nothing else (small, surgical).
- **Option 2** — also the complete tidy-up: route the 17 inline constructions
  through the helpers, delete `segment-store.ts:132` (dead code)
  and the duplicated copy of `location-class-wipe.ts`.
- **Option 3** — nothing, form D does not require it.

→ **I recommend option 1 now**, as separate work independent of
«Migrate to…». It is a mine that has not gone off yet only because prefix and
`deviceId` always coincide. Option 2 is useful hygiene but can wait.

### D15 — The children: guided pairing or recreation?

It concerns 20 cameras out of 31.

- **Option 1** — the operator confirms a map (siren↔siren, light↔light) and the
  paired children **keep their `deviceId`**; the unpaired ones are recreated.
- **Option 2** — `adoptionResync(resetToSource: true)` and that is it: all the children
  are recreated with new ids, always.

→ **I recommend option 1.** Option 2 is much simpler to build, but
throws away the identity of 30 devices on this hub — and on a camera with a siren
exported to HomeKit that siren is an accessory that the operator put in
a room and in a scene.
**Question for you**: how many of your child accessories (sirens, lights, switches)
are really used in automations or scenes? If the answer is «almost none»,
option 2 becomes defensible and saves quite a lot of work.

### D7 — Where the button goes

You said «under General in the camera detail». In the admin UI the device detail
is `packages/addon-admin-ui/src/pages/DeviceDetail.tsx` with structural
tabs (`overview` / `config` / `pipeline` / `bindings`) — **there is no
section called «General»**; the `tabGeneral` key that exists in the viewer
(`locales/en.json:255`) is not referenced by any viewer file, so it is
dead.

→ **I recommend: the admin UI's Overview tab, next to the device's destructive
actions** (where «remove» already lives), with the same explicit confirmation.
**Question for you**: did you mean the admin UI or the viewer app?

### D8 — Who can do it

→ **I recommend `admin`**, like `removeDevice`. Not `protected`: it is
an operation that rewrites a device's identity.

---

## 10 · What I have not verified

Honestly marked, because it is needed before writing code:

- **The complete cross-provider re-adoption path** (§6.1): I know that `addonId`
  is a column and that the `config` is provider-shaped, but I have not traced what
  happens to the registered capabilities and to the `fingerprint` when it changes. It is the
  first prerequisite if D1 chooses to support different brands.
- **Whether `sqlite-vec` supports an `UPDATE` on a metadata column** in the
  version used: the code has none (only INSERT/DELETE), so I
  assumed that re-pointing means re-reading the embedding and re-inserting.
- **Whether two cameras can produce two segments with the same `startMs`** to the
  millisecond (file-name collision inside a merged hour). The practical risk
  that I verified is the directory, not the name.
- The `<camera>` level in `location-occupancy.ts` / `location-class-wipe.ts` is
  a string: every writer emits `String(deviceId)`, but I did not find a
  guard that rejects a non-numeric directory name.
- **What happens to the NATIVE capabilities already registered by the old provider in its
  process**, and whether that provider keeps a handle to the device in memory after
  the row has changed `addonId`. I found the two persistent pins
  (§6.5.3e); this is the *process* state and I have not traced it. It is the first
  check to do before writing code.
- **Whether the Reolink SMTP auto-configure actually ran** on the new
  camera at the time of its adoption. Whether the email push
  matches by itself or must be re-run depends on it (§6.5.4).
- **The Reolink cameras adopted behind a hub/NVR** have `stableId`
  `${hub.stableId}-${childNativeId}` (`reolink-hub.ts:975`). There are 7
  Reolink cameras on the hub; **I have not verified how many are behind a hub**, and for those
  form D applies to the wrong parent.
- **Whether Apple preserves and CONTINUES the HKSV clips** when the accessory keeps
  the same UUID but the hardware behind changes resolution and codec (§6.4). It is the
  single point on which I would promise nothing without a proof on a real
  device.
- **The RAM and latency cost** of the `storageKey → deviceId` map on the
  hot path (`recordSegment` runs at ~3.4/s across the fleet). At 31 cameras it is
  trivial; I did not measure it.
- **Whether `location-class-wipe.ts` and `location-occupancy.ts` can be made
  to resolve the owner from a device row** instead of from the filesystem.
  They derive the identity from the directory listing *by design* (it is what
  makes them robust to a deleted device), so the conversion might not be
  desirable: it is the biggest open question of Phase 1.
- **The count of inline constructions on the analytics/retrain/export side**: the
  census covered the recorder in depth and verified precise *exclusions*
  elsewhere, but the total of 17 is weighted on the recorder. *(hypothesis: the
  analytics side adds very few, because it never reparses the paths.)*
- **I did not measure** how long an intra-filesystem `rename()` of
  ~40,000 files for a 62 GB camera would really take. The 7–14 MB/s figure that I cite is for a
  **cross-disk** copy and comes from the storage migration design, not from a
  measurement made here.

---

## 11 · References

- D62 — a per-camera switch is a VIEW onto the authority that owned the function
- D291 — a relocation moves the durable hour row, and the destination row
  is written first
- D292 — a migration re-points first and drains behind
- D309 — a fleet-wide record is read-modify-written under a single lock
- D331 — a rename that crosses two stores is ONE server call
- D333 — a forget purges every source that lists the thing; an action that changed
  nothing does not answer `success`
- D49 — the destructive direction needs a second read
- `docs/design/2026-08-29-non-blocking-storage-migration.md` — the job shape
  that form A would have to copy
