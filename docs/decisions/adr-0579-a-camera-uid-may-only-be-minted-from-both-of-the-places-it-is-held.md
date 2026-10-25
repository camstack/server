---
id: D579
title: A camera uid may only be minted from BOTH of the places it is held
status: accepted
date: 2026-09-21
applies-to:
  - packages/addon-provider-reolink/src/clips/clip-addressing.ts
  - packages/addon-provider-reolink/src/reolink-camera.ts
  - packages/addon-provider-reolink/src/__tests__/clip-uid-source.spec.ts
last-verified: 2026-10-04
---

## Context

3825 (stanza caldaia, a hub child) answered `videoclips.listClips` with
`unreachable: uid-missing` — no catalog, no stills, no bytes — **while holding
a uid**. Read off the running hub on 2026-09-21:

| device | `metadata.uid` | `config.uid` | lists clips |
| --- | --- | --- | --- |
| 3825 | `9527000MSU931AUT` | *absent* | **no** |
| 3628 | `9527000HXOHJ142G` | `9527000HXOHJ142G` | yes |
| 3629 | `952700093ABW14UB` | `952700093ABW14UB` | yes |

The uid is held **twice**. `deviceMeta.metadata.uid` is written when the device
is adopted and refreshed from the firmware afterwards. `config.uid` is a COPY
taken at adoption — `reolink-hub.ts`, `...(entry.metadata.uid ? { uid } : {})`
— and never written again. A camera adopted before that line existed, or whose
discovery payload carried no uid at the time, keeps an empty one for ever.

`getClipDeviceRef` read `this.config.get('uid')`. The frozen one.

This is [D224](adr-0224.md) wearing a vendor hat: *a device fact is kept fresh
in the addon that owns the device — a consumer never keeps a second copy.* What
makes it worth a record is that the rule was already written down and still did
not hold: `clip-addressing.ts`'s own docblock named the right authority — *"The
CAMERA's own uid, as `deviceMeta.metadata.uid` holds it"* — and the reader
consulted the other one anyway, for months, on one camera, silently.

## Decision

**`CameraUid` is a branded type that only `resolveCameraUid` can mint, and
`resolveCameraUid` is handed both places a uid lives.**

```ts
export type CameraUid = string & { readonly [CameraUidBrand]: true }
export function resolveCameraUid(s: CameraUidSources): CameraUid | undefined
```

`ClipDeviceRef.uid` is `CameraUid | undefined`. So `uid: this.config.get('uid')`
does not produce a subtly wrong answer — **it does not compile**. A reader that
reaches for one copy is a type error at the moment it is written, not a camera
that lists nothing eight months later.

The brand is assignable *to* `string`, so every consumer that passes the uid on
to the library is untouched; only the producer changes. Four sites failed to
compile when the brand landed: the one production defect and three test
fixtures, which now mint theirs the way production does.

Supporting parts:

- **The metadata is the authority, the config is the fallback.** Not
  metadata-only: until the first read lands the adoption copy is all there is,
  and it is correct for most cameras — the fallback is what keeps this from
  regressing 3628 and 3629.
- **An empty or whitespace-only value is ABSENT**, never a uid. It is how a
  cleared settings field arrives, and passed on it addresses no camera while
  making the refusal name the wrong cause.
- **The metadata uid is read SYNCHRONOUSLY, from `ctx.deviceMeta.metadata`.**

  It took two wrong answers to get there, and both are worth keeping because
  each looked right and shipped.

  1. **An RPC in `onProbe`.** `onProbe` is the one lifecycle point that fires
     for both topologies — true, and not enough: it returns EARLY for a
     sleeping battery camera (D173), and 3825 *is* one. The fix written for
     that camera lived on the one path it skips.
  2. **The same RPC, moved above the gate.** Deployed, and every camera logged
     `miss=no-route`: `ctx.api.deviceManager.getDevice` exists in the generated
     router type and **not in the addon's runtime `ctx.api`**. The
     type-vs-runtime trap `camstack/CLAUDE.md` documents for the viewer, on the
     server side, where nothing warns about it.

  `ctx.deviceMeta.metadata` was one property access away the whole time — no
  RPC, no lifecycle point, no cache, no gate. The reader, its named misses and
  its spec were deleted rather than left: a helper nobody calls reads as a
  feature that works.

  What survived is the part that was right — `resolveCameraUid` and the brand.
  The authority was never the question; where to read it was.

  Verified live: 3825's onboard source went from `unreachable: uid-missing` to
  `ok`, and its clip list from a refusal to an honest empty.
- **The read is cached in memory, never persisted.** A third copy of a fact the
  device manager already owns is exactly what produced this. A physical
  camera's uid does not change, so one read per process is enough.

## Alternatives rejected

**Repair 3825's config on the hub.** It would have fixed one camera tonight and
left the defect for the next one in that state. `deviceManager.updateConfig`
also takes the whole values record, so a mistake there costs that camera its
host, credentials and channel — a live write with real downside, buying less
than the compile-time fix.

**Back-fill `config.uid` from the metadata whenever they disagree.** That is
keeping two copies in sync, which is the thing D224 forbids. The copy is not
the problem; believing it is.

**A guard script asserting nobody reads `config.get('uid')`.** A grep that
checks a mechanism exists, which is the shape of guard this repo has already
found green for the wrong reason six times. The type system makes the same
claim and cannot be satisfied by accident.

## Consequences

- 3825 lists clips from the first probe after the deploy, with no data repair.
- Any future camera whose adoption copy is empty is now indistinguishable from
  one whose copy is full — which is the point.
- `resolveCameraUid` is the only mint. A new surface that needs a uid gets it
  from there or does not type-check; there is no second place to add the rule
  to, and therefore no second place to forget it.
- Three revert proofs: config-wins-over-metadata, empty-string-is-a-uid, and a
  reader that may throw each turn exactly their own test red. The brand's proof
  is different in kind — removing it does not fail a test, it makes the
  original defect compile again.
