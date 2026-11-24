/**
 * THE age bound on a native crop lease (ADR-0419).
 *
 * ## The measurement
 *
 * Mac agent node (`MacMiniAgent.localdomain`), 2026-09-09, a 54-minute
 * window: 332 `native crop miss` lines, every one of them `worker-lease-gone`,
 * at a MEDIAN `handleAgeMs` of 30 099 ms — thirty seconds. The node-wide
 * {@link ../session-decode/native-crop-registry.NativeCropRegistry} sat pinned
 * at `registrySize 4096 / registryCap 4096` for the whole window. Measured
 * consequence: on track `d64ace88` (device 111) the frontal-face frames never
 * reached the face detector, because every native fetch missed.
 *
 * ## Why an AGE bound and not a bigger cap
 *
 * The pinned cap is what the miss line shows, so raising it is the instinctive
 * move, and it is wrong twice. It keeps more full-resolution surfaces alive
 * (real RAM, on a ring that has leaked a VAAPI surface pool before), and it
 * only moves the threshold at which the same pinning returns. It also cannot
 * work: the decode worker's own tile store expires a frame's tiles at
 * `NATIVE_TILE_TTL_MS` (30 s), so a handle 30 s old has nothing behind it at
 * ANY registry size. The operator's decision, 2026-09-09: **a native lease
 * lives at most ten seconds**; a crop asked for later than that cannot be
 * useful, and the caller's detection-frame fallback — which
 * `native-frame-ring.ts` calls FREE and expected — is the right answer.
 *
 * ## Why the bound is enforced at the registry
 *
 * The registry is the only place in the system where a handle's registration
 * wall-clock exists: `FrameHandle` carries no correlatable clock (`pts` is
 * explicitly process-local and must never be compared against another), so
 * neither the hub-side requester nor the decode worker can decide this
 * question correctly. It is also the single node-wide chokepoint every native
 * path funnels through — the `getNativeCrop` cap, `getNativeCropForDetail`,
 * and `runDetailSubtree`'s rung 1 — so ONE rule covers all of them, and it
 * sits in-process, in FRONT of the round trip that the 332 misses paid for.
 * Refusing here makes the wasted work impossible rather than merely faster.
 *
 * Deliberately a constant and not an operator knob: it is a property of the
 * pipeline, not of a node's hardware (same argument as the lease knobs in
 * `@camstack/types` `pipeline/native-lease.ts`), and a per-node value would
 * make the same camera produce different crop quality depending on where the
 * balancer placed it.
 */

/**
 * How long a registered handle may be asked for a native crop. Inclusive: an
 * ask at exactly this age is still served, one millisecond later is refused.
 *
 * ## Ten seconds was tried on the fleet, and the fleet refused it
 *
 * The operator's number was ten seconds, chosen on the belief — stated in this
 * file's first version, and sourced from `@camstack/types`
 * `pipeline/native-lease.ts` sizing prose rather than from a measurement of
 * THIS path — that a p90 ask lands at 4.3 s and a p50 at 367 ms. Deployed
 * 2026-09-09 ~14:00, it produced, on the hub, **3 371 `no-registry-entry`
 * misses in fifteen minutes** (2 036 of them on `hall` alone) against
 * essentially ZERO in the half hour before the deploy: the registry held 46
 * entries where it had held 4 096, and the asks arriving between 10 s and 30 s
 * found nothing at all. The operator saw it as tracks with missing media.
 *
 * So the bound is the worker's own tile TTL (`NATIVE_TILE_TTL_MS`, 30 s,
 * `decode-worker-child.ts`) — the age past which there is provably nothing
 * behind the handle at ANY registry size. It still bounds the lease by AGE
 * rather than by a 4 096-entry capacity eviction, which is what D419 set out
 * to fix; it simply stops refusing asks the worker could still have answered.
 *
 * The real defect is caller-side and is not fixed here: a ~1 Hz
 * `TrackDetailDispatcher` re-asks a frozen handle for the life of a coasted
 * track. ADR-0419 also named the by-handle key-frame and group-shot captures
 * as omitting `staleAfterMs`; both are gone (the key frame reads a parked
 * parcel since D422, the group shot is deleted by D680). Until the dispatcher
 * is fixed a tighter bound cannot be told apart from a broken one.
 */
export const NATIVE_CROP_LEASE_MAX_AGE_MS = 30_000

/**
 * Whether a handle registered `ageMs` ago may still be served.
 *
 * Pure and separate from the registry so the bound can be asserted on its own
 * — the boundary (10 000 served / 10 001 refused) is the part a future retune
 * is most likely to get wrong by a millisecond.
 */
export type NativeCropLeaseAge = 'live' | 'expired'

export function classifyNativeCropLeaseAge(
  ageMs: number,
  maxAgeMs: number = NATIVE_CROP_LEASE_MAX_AGE_MS,
): NativeCropLeaseAge {
  return ageMs > maxAgeMs ? 'expired' : 'live'
}
