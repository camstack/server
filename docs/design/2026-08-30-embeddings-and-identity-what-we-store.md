---
title: Embeddings and identity — what we store, what is genuinely duplicated, and what can go
last-verified: 2026-08-30
covers:
  - packages/addon-post-analysis/src/pipeline-analytics/store/object-embedding-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/identity-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/face-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/plate-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/store/vehicle-store.ts
  - packages/addon-post-analysis/src/pipeline-analytics/face-reembed-pass.ts
  - packages/addon-post-analysis/src/pipeline-analytics/photo-enrollment.ts
  - packages/addon-post-analysis/src/pipeline-analytics/rebuild-source-loader.ts
  - packages/addon-post-analysis/src/pipeline-analytics/retention/orphan-audit-settings.ts
  - packages/system/src/builtins/sqlite-storage/vector-index-vec.ts
  - packages/system/src/builtins/sqlite-storage/vector-index-shared.ts
  - packages/types/src/capabilities/vector-store.cap.ts
---

# Embeddings and identity — what we store, what is genuinely duplicated, and what can go

> **The operator's question.** *"Per gli embedding, cosa conserviamo? Non
> abbiamo tutto sul DB vettoriale già? Usiamo questo momento per eliminare il
> superfluo ed ottimizzare."* [For the embeddings, what do we store? Don't we already have everything in the vector DB? Let us use this moment to remove the superfluous and optimise.]
>
> **The premise is false, and that is the first useful answer.** There is
> exactly ONE vector index — `object-clip`, the per-track CLIP search vector.
> The vectors that matter for IDENTITY — ArcFace face embeddings — are not in
> it and never were: they sit as JSON text in two settings-store collections.
> `vector-store.cap.ts:5` says this in its own words ("six stores in
> `addon-post-analysis` already hold vectors … every one of them keeps its
> vectors in a `JSON` settings-store column"); only one of the six migrated.
>
> **The second answer: this is not a byte problem.** Everything in this
> document — both vector stores, every identity row, every face and plate row,
> every gallery blob — totals **≈122 MB** against 41.05 GB of track media
> measured the same hour. Do not expect GB here. What is here is ~9,000
> unreachable rows, a class prefilter that silently returns nothing, and 47 MB
> of photographs no code path can read.

Companions: [post-analysis.md](../architecture/post-analysis.md) (the capture
and rebuild paths this measures), [object-detection.md](../architecture/object-detection.md),
and [2026-08-30-event-media-inventory-and-debug-flag.md](2026-08-30-event-media-inventory-and-debug-flag.md)
(the `pipeline-analytics:media` cut this ran alongside).

All figures below were read off the live hub on 2026-08-30 between 07:15 and
08:10 UTC through `settingsStore.aggregate` / `settingsStore.query` /
`vectorStore.stats` / `vectorStore.query`, and off Loki for the production log
lines. Counts drift by a few rows between calls because the hub is live.

---

## 1. The inventory

| Store | Where it lives | Rows | Bytes | Growth | Retention |
| --- | --- | --- | --- | --- | --- |
| `object-clip` | sqlite-vec `vec0` table, hub SQLite, same file and handle as the settings store (`vector-index-vec.ts:4`) | **22 128** vectors · dim 512 · cosine · `exact: true` | **≈49 MB** (arithmetic, see §6) | ≈2 000–3 400/day | no clock of its own — the track cascade, plus a report-only orphan audit |
| `pipeline-analytics:faces` | settings store | **1 558** — 1 386 unassigned / 168 assigned; 859 carry a suggestion | **17.5 MB**, of which 16.8 MB is the JSON embedding | 344/day, 625 in the last 24 h | track-owned cascade + per-device capacity cap; `assigned` rows exempt forever |
| `pipeline-analytics:identity-samples` | settings store | **128** — 116 `detected` / 12 `photo` · dim 512 | **≈1.4 MB** | 3–43/day over 9 days, operator-driven | **none**, whole table exempt |
| `pipeline-analytics:identities` | settings store | **4** | negligible | operator | none |
| `pipeline-analytics:plates` | settings store | **51**, 0 assigned | text + score, **no vector at all** | 16–34/day, table is 2 days old | track-owned + cap 50/device |
| `pipeline-analytics:vehicles` / `:vehicle-samples` | settings store | **0** / **0** | 0 | — | none |
| `media` · `ownerKind: 'identity'` | `galleryMedia` location, all 140 rows | **140** | **47.85 MB** | 12 photos in 9 days | exempt, immortal |
| `media` · `ownerKind: 'face'` | `eventMedia` (footage) | **1 411** `crop` | **6.08 MB** (4 306 B avg) | — | track-owned |
| `media` · `ownerKind: 'plate'` | `eventMedia` | **43** | **0.13 MB** | — | track-owned |

The identity gallery's 140 blobs, broken out — this is where the surprise is:

| kind | rows | bytes | avg |
| --- | --- | --- | --- |
| `crop` (aligned template, `source: 'detected'`) | 116 | 0.47 MB | 4 275 B |
| `faceCrop` (aligned template, `source: 'photo'`) | 12 | 0.08 MB | 7 217 B |
| **`fullFrame` (the original photograph)** | **12** | **47.29 MB** | **4 132 262 B** |

116 + 12 = 128, which is exactly the `identity-samples` row count, split exactly
as `source` reports it. The gallery's row bookkeeping is intact. Its byte
footprint is **98.8 % twelve phone photographs**.

**What one vector index entry holds.** Read off a live hit: the base64
Float32LE vector (2 048 B raw for 512 dims), the row id (the trackId, a UUID),
four PROMOTED indexed columns — `deviceId`, `timestamp`, `className`, `modelId`
(`vector-index-shared.ts:14`) — and everything else as an `extra` JSON string
(`trackId`, `confidence`, and optionally `mediaKey` / `keyFrameMediaKey`).
**No copy of the crop.** The index holds no pixels at all.

---

## 2. What is genuinely duplicated — precisely

The operator's framing — "the same information kept twice" — mostly does not
apply, and being exact about that is more useful than a list of savings.

**Not duplicated: a vector and a crop.** A CLIP vector answers "what is this
scene like"; the stored crop answers "show me the thing". Different questions,
neither derivable from the other cheaply.

**Not duplicated: the aligned face template.** `assignFace` **re-owns** the
blob face→identity (`face-gallery-provider.ts:535`) — it moves it, it does not
copy it. That is why `identity/crop` (116 rows, 4 275 B avg) and `face/crop`
(1 411 rows, 4 306 B avg) have the same average size and are disjoint sets, and
why enrolling a face does not grow the media table.

**Genuinely duplicated (1): the ArcFace vector of an enrolled face.**
`face-gallery-provider.ts:556` copies `currentFace.embedding` into a new
`identity-samples` row. Both copies are then retention-exempt forever — the
`faces` row through `RETENTION_EXEMPT_FAMILIES`' `enrolled-faces` predicate
(`assigned = 1`), the sample row through the whole-table exemption. 168 assigned
face rows × 11 209 B ≈ **1.8 MB**. The `faces` copy is not readerless: a
REASSIGNMENT re-reads it (`face-gallery-provider.ts:517`, then `:556`), so
moving an enrolled face to a different person needs it. Cost of dropping it is
"that path must re-embed from the crop, which is still there". Worth knowing;
not worth doing for 1.8 MB.

**Genuinely duplicated (2): `identities.sampleCount` and
`identities.coverMediaKey`.** Both are derivable from the sample rows
(`identity-store.ts:53`), and both are mirrors the code already carries scar
tissue for — the `== null` cover comment inside `addSample`, and the
cover-heal-on-`removeSample` branch that promotes a surviving sample's media.
Four rows; the byte saving is zero. It is listed because the operator asked
"what is kept twice", and the honest answer is: **almost nothing is.** These two
fields are the only metadata mirrored between an identity row and its samples.

---

## 3. What each stored artefact is FOR — the reader map

A copy with no reader is a candidate. A copy that is the only thing standing
between us and "cannot re-analyse, ever" is not (D58).

| Artefact | Read by | Can it be re-created? |
| --- | --- | --- |
| `object-clip` vector | `searchObjectEvents` (`index.ts:12622`) — semantic search, and nothing else | **Yes, while the track lives**: `rebuildObjectEmbeddings` loads the track's stored `keyFrame` + its best object event's bbox (`rebuild-source-loader.ts:82`) and re-runs `clip-embedding`. **No, once the track row is gone** — no key frame, no event, no substitute (D52/D58) |
| `faces.embedding` | enrolment and re-assignment (`face-gallery-provider.ts:517`), `suggestFaceClusters` over UNASSIGNED rows only (`face-gallery-provider.ts:776`) | Only from the aligned crop, and no code does it today |
| `faces` crop blob | the operator's Faces review UI, as a `cropUrl` | No |
| `identity-samples.embedding` | `loadGallery()` → the live matcher at every recognition (`identity-store.ts:304`); `enrollmentPromiscuity` on every enrolment | **Yes** — `reembedFaces` re-runs `face-embedding` over the stored 112×112 template (`face-reembed-pass.ts:19`), automatically on a cluster model flip |
| `identity-samples.mediaKey` (aligned template) | the re-embed pass's only input; the gallery tile | No. This is the single load-bearing blob of the whole enrolled gallery |
| **`identity-samples.sourceMediaKey` (the photograph)** | **`listSamples` (`identity-store.ts:267`) and `removeSample` (`face-gallery-provider.ts:280`), which deletes it. Nothing else.** | It IS the master — nothing can re-create it |
| `plates.text` | the plate matcher and review UI | Yes, from the crop |
| `identities` row | the People page, label attribution | No — operator-created |

**The face/plate source requirement is NOT the same as the object one, and this
matters for any deletion proposal.** A CLIP vector is re-derivable from
`keyFrame` + event bbox. A face sample is re-derivable from its own aligned
template — **not** from the track's key frame, and not from any frame:
`face-reembed-pass.ts:19` records why re-running detection + alignment over a
template is silently wrong (SCRFD upscales it to 640, finds a face at 90–110 px,
clears the 24 px landmark floor, and the aligner applies a SECOND warp; every
gate passes and the vector is plausible and useless). So the enrolled gallery's
re-analysis capability rests entirely on `mediaKey`, and nothing else in this
system can substitute for it.

---

## 4. Findings, ranked by what they save — with the arithmetic

### F1 — ≈9 000 vectors in `object-clip` point at tracks that no longer exist, and the backstop that exists to find them is blind to 82 % of the index and reclaims nothing

*Saving ≈20 MB · ≈40 % of the index · cost: nothing · confidence: high on the
mechanism, medium on the exact count*

**Measured.** 22 128 vectors against 16 693 track rows. Even if every surviving
track had a vector, **≥5 435 vectors (24.6 %) are orphans by arithmetic alone**.
The real number is higher, because 13–26 % of live tracks have no vector at all
(sampled: 93.5 % coverage at 0–1 d, 73.5 % at 2–3 d, 86.0 % at 5–6 d).

Membership-tested per day bucket — vector ids drawn from the index, then looked
up in `pipeline-analytics:tracks` by primary key:

| age | vectors | track rows in the same window | sampled orphan rate |
| --- | --- | --- | --- |
| 0–1 d | 3 405 | 3 225 | 9 % |
| 1–2 d | 2 470 | 2 449 | 24 % |
| 2–3 d | 1 971 | 2 031 | 37 % |
| 3–4 d | 2 016 | 2 143 | 19 % |
| 4–5 d | 2 102 | 2 773 | 22 % |
| 5–6 d | 2 175 | 1 973 | 39 % |
| 6–7 d | 2 176 | 2 086 | 17 % |
| **7–8 d** | **413** | **17** | **97 %** |
| 8–9 d | 344 | 1 | 99 % |
| 9–14 d | 1 348 | 3 | 100 % |
| **> 14 d** | **3 193** | **0** | 100 % by construction |

Track retention cuts at about seven days. The vector index does not: **5 298
vectors sit entirely beyond the track horizon**, against 21 surviving tracks.
Weighting each bucket by its sampled rate gives **≈9 080 orphans, 41 %**. Two
independent probe vectors agree within 13 points on the mid buckets (37 % vs
50 % at 2–3 d, 39 % vs 42 % at 5–6 d), so the honest band is **8 000–10 000**.

**Why nothing removes them — two separate defects, both visible in production
logs from this morning.**

The hub, 2026-08-30T04:48:26Z:

```
analytics orphan audit
  {"mode":"report","collection":"vector-index:object-clip",
   "examined":4096,"orphans":956,"reclaimed":0,"refused":false}
```

and, from `hub/sqlite-settings` one minute earlier:

```
sqlite-vec: topK clamped to the extension ceiling
  {"index":"object-clip","requested":20000,"k":4096,"ceiling":4096}
```

1. **The audit can only ever see 4 096 of 22 128 rows (18.5 %).**
   `EMBEDDING_ORPHAN_SCAN_LIMIT` is 20 000 (`index.ts:129`) and reaches the
   index as a KNN `topK`, which sqlite-vec clamps to `VEC_KNN_MAX_K`
   (`vector-index-vec.ts:76`). The clamp warns — correctly — but the audit
   consumes the short result as if it were the index, and its `examined: 4096`
   has read as "we looked" ever since. Its 956 orphans are 23.3 % **of a slice**,
   not of the index.
2. **`mode` defaults to `'report'`** (`orphan-audit-settings.ts:20`), so even
   the 956 it does find are never deleted. That default is deliberate and its
   safety argument is sound; what is missing is that nobody has ever flipped it.

**What deleting an orphan costs: nothing, and this is the D58 check.** A vector
whose track row is gone cannot be re-embedded — `loadRebuildSource` needs the
track's stored `keyFrame` and its best object event (`rebuild-source-loader.ts:82`),
and both left with the track. It also cannot be RETURNED: `searchObjectEvents`
joins every ranked hit back to an `ObjectEvent` by `trackId` and drops what it
cannot resolve (`index.ts:12622`). These rows are unreachable in both
directions. They are not a cheap copy of something — they are nothing.

**What it does not save.** ≈20 MB. The reason to do it is that the index is the
one store in this document with the media table's shape: no clock of its own
(deliberately and correctly — `object-embedding-store.ts:422` records that a
second clock produced 1 446 orphans of 2 222 rows on device 104), a cascade
that is demonstrably incomplete, and a backstop running in report mode against
18 %. If the cascade were complete the index would hold ≈14 200 rows. It holds
22 128, and the excess accumulates.

### F2 — every single vector carries `className: "embedding"`, so class-scoped semantic search returns nothing

*Saving: 0 bytes · cost: nothing · this is a correctness finding, not a cleanup*

Counted through the index's own prefilter: `className = 'embedding'` → **22 122**.
`person`, `vehicle`, `animal`, `car`, `package`, `''` → **0 each**.

`className` is one of the four columns PROMOTED to real, indexable `vec0`
columns (`vector-index-shared.ts:14`) for the sole purpose of pushing a class
prefilter into the KNN statement. It holds one constant across the entire index.

The consequence is worse than a wasted column. `searchObjectEvents` maps its
`classFilter` argument straight onto `className` equals
(`object-embedding-store.ts:380`), so **any class-scoped semantic search matches
zero rows** — not a truncation, not a warn, an empty result that looks exactly
like "nothing matched your text".

The cause is that the index has two writers that disagree. `index.ts:8067`
passes `t.className`, the track's real class. `index.ts:7922` passes
`detail.className` — the `clip-embedding` STEP's output class, which is the
literal string `embedding`. The docblock immediately above the second one
(`index.ts:7905`) states that since Phase-3 session-time dispatch it is the
DOMINANT writer, and the measurement confirms it: 22 122 of 22 124.

Either `className` is made real at `index.ts:7922`, or the column and its index
are dead weight and the cap's `classFilter` is a lie. It cannot stay as it is.

### F3 — 47.29 MB of enrolled photographs that no code path can read

*Saving ≈43 MB by bounding (not deleting) · cost: see the warning · confidence:
high — the reader set was enumerated exhaustively*

Twelve `identity/fullFrame` blobs, 49 587 139 bytes, averaging **4 132 262 B
each**. Against 128 aligned templates totalling 0.55 MB, that is **98.8 % of the
enrolled gallery's byte footprint**. They are written verbatim at
`photo-enrollment.ts:479` — `normalizePhotoOrientation` (`index.ts:12459`)
re-encodes for EXIF but bounds no dimension, so a phone photo lands at full
resolution.

**Their reader set, enumerated:** `IdentityStore.listSamples`
(`identity-store.ts:267`) surfaces `sourceMediaKey`; `removeSample`
(`face-gallery-provider.ts:280`) deletes it. That is all.
`IdentitySampleInfoSchema` (`face-gallery.cap.ts:16`) has **no field for it**, so
it never reaches any client; the admin UI never names it; and
`listSamplesForReembed` (`identity-store.ts:328`) carries only `mediaKey`, so
the re-embed pass — the exact capability the field's own docblock
(`identity-store.ts:65`) says it exists for — never touches it.

**This is a leftover that describes the right design, and it reads as
verification.** D201 and `post-analysis.md` both state that the photograph is
"the reloadable master — why a photo gallery survives a model change". It is
not, today: the pass reloads the TEMPLATE.

**Do not delete them.** This is the D58 case cutting the other way. The
photograph is the only thing that could survive an **aligner** change — the
template cannot, for the reason `face-reembed-pass.ts:19` spells out — and these
12 samples are the only ones in the gallery that have one. Deleting them closes
that door permanently.

The proposal is: **bound the stored master** (re-encode to a long edge of, say,
1 600 px — a 4.1 MB photo becomes ≈250–400 KB, ≈90 % off, and still detects and
aligns an order of magnitude above the 24 px landmark floor, which is measured
in the photograph's own space and which `post-analysis.md` is explicit must not
be relaxed), **and wire `sourceMediaKey` into `listSamplesForReembed`** so the
claimed capability becomes real. Bounding without wiring shrinks a file no code
can reach; wiring without bounding leaves 4 MB per enrolment.

**Do not conflate this with the media cut.** All 140 identity blobs carry
`locationId: galleryMedia`, verified row by row. They are on the data volume by
D197 and are not part of the 152.6 GB → 38 GB reduction. Nothing proposed here
couples enrolment lifetime to footage lifetime.

### F4 — a 512-float vector costs 10.8 KB in the two identity stores and 2.7 KB in the index built to fix exactly that

*Saving ≈13.5 MB at rest, and ≈11 MB per 30 s poll on the read path · cost:
nothing*

Measured over 60 real `faces` rows: the embedding's JSON text is **10 767 B**
average, the whole row **11 209 B**. The same 512 dims are 2 048 B raw and
2 732 B as base64 — the encoding the vector store already speaks.

| | as JSON today | as base64 | saving |
| --- | --- | --- | --- |
| `faces` (1 558 rows) | 16.8 MB | 4.3 MB | 12.5 MB |
| `identity-samples` (128 rows) | 1.4 MB | 0.35 MB | 1.0 MB |

`vector-store.cap.ts:5` describes this situation as the reason the capability
exists. `object-clip` migrated (`object-embedding-store.ts:7`); `faces`
(`face-store.ts:125`) and `identity-samples` (`identity-store.ts:60`) still
declare `type: 'JSON'`.

**The read cost is the larger number, and it needs no migration to fix.**
`FaceStore` uses **no `columns` projection on any read** — the only `columns:`
in the file is the collection declaration (`face-store.ts:303`).
`listAllRecentFaces` (`face-store.ts:661`) pages **1 000 full rows at a time**,
and the admin UI's Unassigned Faces asks for `limit: 500, includeCrops: false`
on a **30 s `refetchInterval`** (`UnassignedFaces.tsx:259`) — against a cap
output, `FaceInfoSchema` (`face-gallery.cap.ts:25`), that **has no embedding
field at all**. So roughly 11 MB of 512-float JSON is read from SQLite, parsed,
and discarded every 30 seconds per open tab, to answer a query that cannot use
it. `pruneCapOverflow` does the same on its own sweep; the store's docblock
(`face-store.ts:54`) already names the 11 MB peak without drawing the
conclusion.

This is not duplication. It is one encoding choice and one projection nobody
added, and the projection is the cheapest win in this document.

### F5 — the duplicated enrolled-face vector

*Saving 1.8 MB · cost: re-assignment must re-embed · **not recommended***

Covered in §2. Listed for completeness because it is the only true
"stored twice" in the identity domain, and it is 1.8 MB.

---

## 5. Retention — is this the media situation again?

Partly. Three different shapes, and only one of them is the media shape.

**Correct and must not be changed.** `identities`, `identity-samples`,
`vehicles`, `vehicle-samples` have **no clock, by explicit exemption**
(`RETENTION_EXEMPT_FAMILIES`, `retention-model.ts:101`). Pruning them breaks
recognition itself rather than the history of it. Growth is operator-driven:
128 samples across 4 people in 9 days. Giving these a clock would be a defect,
not an optimisation.

**Bounded, working, and priced higher than anyone has said.** `faces` and
`plates` cascade with their track AND carry a per-device capacity cap. The
cascade is verifiably working: of the oldest 300 face rows, 99 point at tracks
that are gone — and **all 99 are `assigned`**, which is the exemption doing
exactly what it claims. Of the newest 300, 2. Nothing is leaking.

But the ceiling is real and unstated. Faces are produced on **23 cameras**, each
with a 50-row unassigned budget plus a separate 200-row suggested budget
(`face-settings.ts:128`, `deriveSuggestedBufferCap`). That is **5 750 rows ≈
64 MB** at the measured row width, against 1 558 rows / 17.5 MB today — and
device 104 is **already at its ceiling** (317 rows, 259 unassigned against a
250-row budget). 859 rows cluster-wide already carry a suggestion, so the
suggested tier is the one filling. Separately, the `assigned` tail (168 rows) is
exempt from every bound and grows forever with enrolments. None of this is
alarming; it is simply a bound that has never been converted into megabytes.

**This IS the media shape: `object-clip`.** No clock of its own — deliberately,
and the reasoning is right (`object-embedding-store.ts:422`). But the cascade
is the entire mechanism, the cascade is demonstrably incomplete (§F1), and the
backstop built for precisely that runs in `report` mode over 18 % of the rows.
Vectors go in at 2 000–3 400/day and the standing excess is ~7 900 and rising.
Unlike the media table it is only ~49 MB, so there is time — but the mechanism
is the same one that produced 152 GB.

---

## 6. What I could not determine

- **Actual bytes on disk, for the vector index.** `VectorStatsResultSchema`
  declares an optional `bytes` (`vector-store.cap.ts:168`) and the live call
  returns none — `VectorIndexStats` (`vector-index-shared.ts:24`) has no such
  field, so the only backend that exists cannot fill it. Every index byte figure
  here is arithmetic on the row shape (2 048 B vector + a 36-char id + four
  promoted columns + an `extra` JSON of ~110 B, plus `vec0` chunk overhead),
  **±25 %**. Opening the production SQLite was out of bounds. The settings-store
  figures are measured from real row payloads (high confidence) and the `media`
  figures are exact — a `SUM` of a stored `sizeBytes` column.
- **The exact orphan count.** The membership test is exact per sampled id, but
  the sample is drawn by KNN ordering, which I cannot make uniform. **5 435 is a
  certain floor**; 8 000–10 000 is the band; 9 080 is the point estimate.
- **Which deletion path drops the vectors.** I established THAT vectors outlive
  their tracks and by how much. I did not trace WHICH of the track-removal paths
  (`track-drain.ts`, `trackless-root-sweep.ts`, the per-device retention sweep)
  fails to call `deleteByTracks`. `object-embedding-store.ts:443` says only
  "retention pruned by two different rules". **This is the next thing to look
  at, and F1's proposal deliberately does not depend on knowing it** — the
  audit is a reconcile, and its own docblock argues that a reconcile which
  cannot explain how it got work to do is still the right shape.
- **Whether semantic search is used at all.** Zero occurrences of the string
  `searchObjectEvents` in 24 h of Loki, including its truncation warn and its
  `ranked tracks without events` line. With 40 % orphans that second line would
  fire on almost any real search, so the silence is strong evidence that nothing
  searched — but those lines only fire on a fault, so silence is also consistent
  with "used and healthy". I could not separate the two, and F1's value does not
  rest on it.
- **The two vectors not carrying `className: 'embedding'`** (22 124 total vs
  22 122 counted). The two counts were taken ~90 s apart on a live index and the
  difference is within its drift; I did not chase them.

---

## 7. The ranked list, restated for a decision

| # | Change | Saves | Costs | Do it? |
| --- | --- | --- | --- | --- |
| 1 | Make the orphan audit see the whole index (page the KNN, or count another way), then let it reclaim | ≈20 MB, ≈9 000 unreachable rows, and closes the one unbounded-growth path here | Nothing — the rows are re-creatable from nothing and returnable to nobody | **Yes.** Two code fixes, then one operator flip of `orphanAuditMode` |
| 2 | Bound the enrolled photograph on write, AND wire `sourceMediaKey` into the re-embed pass | ≈43 MB now, ≈4 MB per future enrolment | Nothing today; deleting instead of bounding would cost the ability to survive an aligner change, permanently | **Yes, as a pair.** Never one without the other |
| 3 | Add a `columns` projection to the three `FaceStore` reads that do not need the vector | ≈11 MB per 30 s poll, per tab; the same on every cap sweep | Nothing — `FaceInfo` has no embedding field | **Yes.** Cheapest item here |
| 4 | Fix `className` at `index.ts:7922` | 0 bytes; restores class-scoped semantic search from "silently empty" | Vectors already written keep the wrong value until a rebuild | **Yes** — it is a bug, not an optimisation |
| 5 | Move `faces` / `identity-samples` vectors into the vector store | ≈13.5 MB at rest | A migration, two callers, and a second index to keep consistent | Later. The projection in #3 gets most of the read win for none of the risk |
| 6 | Drop the duplicated enrolled-face vector | 1.8 MB | Re-assignment must re-embed | **No** |
