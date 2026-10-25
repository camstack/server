---
title: Live group tracking — assign in RAM during the session, persist at idle (DELETED 2026-09-01)
status: historical
date: 2026-08-24
---

# Live group tracking — assign during the session, persist at idle

> **Status: DELETED 2026-09-01. Nothing described below is in the codebase.**
> It was implemented on 2026-08-24 and killed the same day (duplicate sealed
> rows made Library → Gruppi unusable). It stayed switched off for eight days
> and cost three days of whole-frame digests before the operator decided to
> remove it rather than re-open it
> ([D330](../decisions/adr-0330-a-kill-switched-feature-is-deleted-or-it-is-re-opened.md)).
> `pipeline-analytics/group/` is gone, both tables are in
> `RETIRED_COLLECTIONS`, and `listGroups` / `getGroup` are off the wire.
>
> The notification-center burst merge ([D143](../decisions/adr-0143.md)) is a
> DIFFERENT mechanism and is untouched.
>
> Kept as the record of what was built and why it did not work — read it before
> proposing a group entity again, not as a description of the system.

The group is a second detection line beside the track. Clustering runs **in
RAM on every track upsert**, on the hub post-processing node, in
`pipeline-analytics`. Groups/Events still show only **sealed** rows: persist
happens when that group has been idle 30 s. There is no census of cameras
and no boot backfill.

---

## 1. Why this replaces the sealer census

Phase 1 born groups at session close by sweeping stored tracks (`sealRecent`
every 5 s → `listDeviceIdsSince` → `queryHistorical` → `clusterGroups` over
the whole overlap). That is a **lookback census**, not tracking. It wedged
hub-main when the lookback was 48 h at boot; even bounded to 10 minutes it
is the wrong mechanism: grouping waits for idle, then re-partitions a closed
window, and a peeler who walked with someone is glued back onto them.

The operator wants:

- tracking **during** the session, on the same upsert path as tracks;
- **grow / shrink** on one group id (join / peel), not a retrospective
  partition;
- Groups/Events **only after idle** (the live work is the assignment, not
  the gallery row);
- **no** global camera walk, **no** 48 h backfill.

---

## 2. Lifecycle

1. **Same path as tracks.** After `trackStore.upsert` on the post-processing
   node, `GroupLiveBuffer.observe(track)` updates that camera’s RAM
   assignment. `SortTracker` is not touched. The notification burst
   (`notification-center:track-groups`) is a different question and stays.
2. **Grow / shrink in RAM.** Two people close → one group id. A third joins
   that id. A peeler leaves after hysteresis and is born as a group of one.
   Rejoining later gets a **new** id. Two multi-member groups that meet do
   **not** merge ids.
3. **Persist only at idle.** 30 s (`GROUP_SESSION_IDLE_MS`) after every
   current member’s `lastSeen` → insert sealed row + membership + crop.
   `listGroups` sees it then. A peeler’s singleton can seal while the others
   still walk.
4. **Crash.** RAM is gone. No boot scan. Recover per camera only: short
   lookback on that camera’s next activity, and `sealWindow` on the digest’s
   already-known window. Both use the **same live replay**, not
   `clusterGroups` over the full overlap.
5. **What dies.** `sealRecent()` as a SQLite census (`listDeviceIdsSince` /
   10-minute `queryHistorical` of every recently-seen camera). The 5 s TTL
   tick still runs; it only asks the RAM buffer who is idle.

Hub-only writes (`isPostProcessingNode`). Agents must not hit settings-store
for groups.

---

## 3. Together / peeled

The measured predicate stays: proximity yes, crossing no. The **interval**
changes.

| | Phase 1 sealer | Live assigner |
|---|---|---|
| Interval | whole temporal overlap | `[now − 3 s, now]` |
| Sample | 500 ms | 500 ms |
| `D_MAX` / `COHESION_MIN` / `MOVE_EPS` / `COS_MIN` | 1.5 / 0.5 / 0.35 / 0.3 | same |
| Displacement / cosine | whole track | **the window only** |
| Eligibility | drop `stationary-promotion`, drop `audio` | same |
| `< 2` positions in window | singleton (clusterer) | stay ungrouped / singleton |

**Hysteresis**

- **Join** after the pair is true for **1.5 s** (3 samples) against at least
  one member of the target group.
- **Leave** after it is false for **3 s** against **all** remaining members.
  Leave is slower than join so a dirty bbox does not split the group.
- A peeler is immediately a RAM group of one. Re-join uses the join rule and
  a new id.

**No fusion of two full groups.** A singleton (or a group reduced to one) is
absorbed into the group of the nearest together-member (smallest normalised
gap this instant). Two pairs that meet stay two groups until someone peels
and joins the other. One join per upsert.

`pairTogether` on the full overlap remains in `group-clusterer.ts` for tests
and for any offline measurement. The hot path and `sealWindow` call
`pairTogetherNow` / the assigner, not `clusterGroups`.

---

## 4. Persist, media, crash

The DB row is written **once**, `sealed: true`, with **current** RAM members.
Peeled tracks are not members of this row.

**Triggers** (never a camera census):

1. The existing 5 s TTL tick: `buffer.idleGroups(now)` → persist. Cost = open
   groups in RAM.
2. An upsert on camera N may also notice another group on N that just went
   idle.

Idle = every **current** member has `lastSeen + 30 s ≤ now`. Persist success
drops those ids from the buffer. Persist failure leaves them in RAM, logs
with `tags: { deviceId }`, retries next tick.

**Media** — same as today’s `persistPartition`, at persist time:

- `chooseGroupInstant` on **current** members only;
- union crop with `{ containSubject: true }`;
- `nativeKey` pointer at the longest-lived member that owns a clean frame;
- singleton: no group blob (picture is the member’s);
- no clean pixels → row still born, log it, do not invent a frame.

`openedAt` = birth of **this** RAM id. `closedAt` = max `lastSeen` of remaining
members.

**Crash / reboot**

- RAM empty. No `backfill()`.
- On first activity for camera D: `queryHistorical` D since `now − 2 min`,
  skip ids already in `membersOfTracks`, replay the assigner, persist idle
  groups. Other cameras are not walked.
- Digest: `sealWindow(deviceId, since, until)` = the same replay over that
  window. **Not** `clusterGroups` on full overlap — that would re-glue a
  peeler the live path already split.
- A camera silent for the whole downtime stays ungrouped until one of those
  two fires. Accepted.

---

## 5. Pieces

| Unit | Responsibility | Depends on |
|---|---|---|
| `group-live-assigner.ts` | Pure: `pairTogetherNow(a, b, now)` over 3 s (same constants as the clusterer) and join/leave given window snapshots + current membership. No store. | `group-clusterer` constants + `bboxCentroid` |
| `group-live-buffer.ts` | Per-device RAM groups, `observe(track)`, `idleGroups(now)`, drop after persist | assigner |
| `group-live-replay.ts` | Walk stored tracks in time order, drive the assigner, return groups that went idle inside the window | assigner |
| `group-sealer.ts` | `persistPartition` kept. `flushIdle(buffer)` replaces `sealRecent`. `sealWindow` calls replay. | buffer / replay / store / media |
| `index.ts` | After upsert (hub only): `buffer.observe`. Sweep: `flushIdle`, never `listDeviceIdsSince`. | sealer + buffer |

`TrackGroupStore.insert` stays write-once. Membership rows are the members at
persist, not the historical join set.

Do not put grouping in `SortTracker`. Do not write live (`sealed: false`)
group rows. Do not resurrect `backfill()`.

---

## 6. Tests (red first)

Pure assigner (`group-live-assigner.spec.ts`):

- Two walkers within `D_MAX` for 1.5 s share an id; at 1.0 s they still do not.
- Crossing (`cos < 0.3`, both moving) never joins, even when close.
- After 3 s apart, the peeler is a new singleton; the original id keeps the
  rest.
- Two pairs that meet do not merge ids.
- Stationary-promoted and `audio` never join.
- Displacement/cosine use the 3 s window: a walker who went north then south
  in the window is not vetoed by whole-life heading.
- Remove the leave-hold (or set it to 0) and confirm a 500 ms gap **does**
  split — the hysteresis test must fail without the hold.

Buffer + sealer:

- `flushIdle` persists only groups idle 30 s; an overlapping active member
  blocks.
- Persist failure keeps the group in RAM (fake store throws once, then
  succeeds).
- A peeler seals as a singleton while the parent group is still active.
- Replay of stored positions over a window equals the incremental `observe`
  sequence on the same positions.
- `group-sealer-boot.spec.ts`: source must **not** contain
  `groupSealer?.sealRecent()` nor `listDeviceIdsSince` on the sweep; must
  contain `flushIdle` / buffer observe; must still contain `sealWindow`.
- Digest `sealWindow` on a peeler window produces two groups, not one
  (force `clusterGroups` there and confirm the test fails).

No new cap. No viewer change. Embed `entity=groups` already lists sealed
rows.

---

## 7. Out of scope

- Live rows in Groups/Events while people are still in frame.
- Merge of two multi-member group ids.
- Cross-camera groups.
- Putting grouping in the tracker.
- Replacing the notification burst table.
- Parked-car / snapshot / dangling best-frame quality (separate; the 12 h
  debug audit is not this spec).
- Boot backfill of any lookback.

---

## 8. Mandate (one page)

- Assign in RAM on track upsert, hub post-processing node only.
- `pairTogetherNow` on 3 s, same constants, window-local motion.
- Join 1.5 s / leave 3 s. Peel → new singleton id. No full-group merge.
- Persist sealed at 30 s idle of **that** group; media as today’s crop.
- Sweep tick flushes RAM idle groups only. `sealWindow` = live replay.
- Crash recover = 2 min lookback on the camera that just moved, plus digest
  windows. Never walk every camera. Never boot-scan 48 h.
- Eligibility, tables, cascade, digest consumers, singleton-has-no-blob:
  unchanged from 2026-08-21 §9 except birth and the clusterer on the hot path.
