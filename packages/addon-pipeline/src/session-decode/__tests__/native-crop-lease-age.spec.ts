/**
 * A native lease lives AT MOST {@link NATIVE_CROP_LEASE_MAX_AGE_MS} (ADR-0419).
 *
 * The measurement this pins, from the Mac agent node
 * (`MacMiniAgent.localdomain`, 2026-09-09, a 54-minute window): 332
 * `native crop miss` lines, ALL `worker-lease-gone`, at a MEDIAN
 * `handleAgeMs` of 30 099 ms, with the node-wide registry pinned at
 * `registrySize 4096 / registryCap 4096` throughout. Every one of those 332
 * paid a cross-process round trip to the decode worker to be told that a
 * thirty-second-old frame is gone — which no cap size can ever change, because
 * the worker's own tile store expires at 30 s.
 *
 * So the age is the bound, and the registry is where it is enforced: it is the
 * only place in the system where a handle's registration wall-clock exists
 * (`FrameHandle.pts` is explicitly process-local and must never be correlated),
 * and it sits in-process, in front of the round trip.
 */

import type { FrameHandle } from '@camstack/types'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NATIVE_CROP_LEASE_MAX_AGE_MS } from '../native-crop-lease-age.js'
import { NativeCropRegistry } from '../native-crop-registry.js'
import { mkNativeCropRequester } from '../../__tests__/support/native-crop-requester.js'

const DEVICE_ID = 111

/** The median measured on the Mac agent, to the millisecond. */
const MEASURED_MEDIAN_AGE_MS = 30_099

function handle(seq: number): FrameHandle {
  return {
    shmId: 'csr.dev1443',
    slot: 0,
    seq,
    width: 3840,
    height: 2160,
    format: 'rgb',
    pts: 0,
    byteLength: 1,
    nodeId: 'MacMiniAgent.localdomain',
    slotCount: 8,
  }
}

const mkRequester = mkNativeCropRequester

describe('the native crop lease is bounded by AGE, not by registry capacity', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-09-09T10:00:00Z'))
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  // Ten seconds was the operator's number and it was deployed on 2026-09-09.
  // It produced 3 371 `no-registry-entry` misses in fifteen minutes against
  // ~zero before the deploy: the asks landing between 10 s and 30 s found a
  // registry that had already swept their entry. The bound is now the worker's
  // own tile TTL — the age past which nothing is behind the handle anyway.
  it('the bound is the worker tile TTL, the age past which nothing can answer', () => {
    expect(NATIVE_CROP_LEASE_MAX_AGE_MS).toBe(30_000)
  })

  it('REFUSES the measured 30 099 ms handle without ever reaching the worker', () => {
    const reg = new NativeCropRegistry(4096)
    const requester = mkRequester()
    reg.register(handle(1), requester, DEVICE_ID)

    vi.advanceTimersByTime(MEASURED_MEDIAN_AGE_MS)
    const lookup = reg.lookup(handle(1))

    expect(lookup.kind).toBe('expired')
    // The whole point: the cross-process round trip is not merely faster, it
    // does not happen.
    expect(requester).not.toHaveBeenCalled()
    // …and the refusal still names the camera and the age, or the next
    // measurement of the same 332 misses learns nothing new.
    if (lookup.kind !== 'expired') throw new Error('unreachable')
    expect(lookup.deviceId).toBe(DEVICE_ID)
    expect(lookup.ageMs).toBe(MEASURED_MEDIAN_AGE_MS)
  })

  it('SERVES a two-second handle — the bound refuses the late ask, not the live one', () => {
    const reg = new NativeCropRegistry(4096)
    const requester = mkRequester()
    reg.register(handle(2), requester, DEVICE_ID)

    vi.advanceTimersByTime(2_000)
    const lookup = reg.lookup(handle(2))

    expect(lookup.kind).toBe('live')
    if (lookup.kind !== 'live') throw new Error('unreachable')
    expect(lookup.request).toBe(requester)
    expect(lookup.ageMs).toBe(2_000)
    expect(lookup.deviceId).toBe(DEVICE_ID)
  })

  it('"at most 10 s" is inclusive: 10 000 ms is served, 10 001 ms is refused', () => {
    const reg = new NativeCropRegistry(4096)
    reg.register(handle(3), mkRequester(), DEVICE_ID)
    vi.advanceTimersByTime(NATIVE_CROP_LEASE_MAX_AGE_MS)
    expect(reg.lookup(handle(3)).kind).toBe('live')

    reg.register(handle(4), mkRequester(), DEVICE_ID)
    vi.advanceTimersByTime(NATIVE_CROP_LEASE_MAX_AGE_MS + 1)
    expect(reg.lookup(handle(4)).kind).toBe('expired')
  })

  it('a handle that was never registered is UNKNOWN, not expired — two different fixes', () => {
    const reg = new NativeCropRegistry(4096)
    expect(reg.lookup(handle(99)).kind).toBe('unknown')
  })

  it('an expired lookup RELEASES the worker-side lease and drops the entry (it can never be served again)', () => {
    const reg = new NativeCropRegistry(4096)
    const requester = mkRequester()
    reg.register(handle(5), requester, DEVICE_ID)

    vi.advanceTimersByTime(MEASURED_MEDIAN_AGE_MS)
    reg.lookup(handle(5))

    expect(requester.release).toHaveBeenCalledTimes(1)
    expect(reg.size).toBe(0)
    // Dropped, but still attributable to its camera — a miss line without a
    // deviceId cannot answer "why is 102 worse than 101?".
    expect(reg.deviceIdFor(handle(5))).toBe(DEVICE_ID)
    // And a second ask is STILL a refusal — the registry refused this handle
    // once and keeps saying so — but it does not release twice.
    expect(reg.lookup(handle(5)).kind).toBe('expired')
    expect(requester.release).toHaveBeenCalledTimes(1)
  })

  // 2026-09-09, 14:00–15:58, the fleet under the 10 s bound: the refusal line
  // (`native crop refused`, `handle-expired`) fired 79 times in two hours,
  // while `native crop miss reason=no-registry-entry handleAgeMs=null` fired
  // 20 980 times — from ZERO in the six hours before. Same cause: an ask that
  // arrived AFTER `register`'s sweep had already dropped the entry. The sweep
  // turned 99.6 % of the refusals into an anonymous miss with no age, and the
  // one number ADR-0419 promised would make the bound tunable said "79".
  it('a handle SWEPT by age before the ask is still a REFUSAL, with its age — never an ageless miss', () => {
    const reg = new NativeCropRegistry(4096)
    const stale = mkRequester()
    reg.register(handle(10), stale, DEVICE_ID)

    vi.advanceTimersByTime(MEASURED_MEDIAN_AGE_MS)
    // Any registration past the bound sweeps handle(10) out.
    reg.register(handle(11), mkRequester(), DEVICE_ID)
    expect(stale.release).toHaveBeenCalledTimes(1)

    const lookup = reg.lookup(handle(10))
    expect(lookup.kind).toBe('expired')
    if (lookup.kind !== 'expired') throw new Error('unreachable')
    expect(lookup.deviceId).toBe(DEVICE_ID)
    expect(lookup.ageMs).toBe(MEASURED_MEDIAN_AGE_MS)
    // The sweep already released it; the refusal must not release it again.
    expect(stale.release).toHaveBeenCalledTimes(1)
  })

  it('a CAPACITY eviction is still UNKNOWN — the cap binding is a different finding from a late ask', () => {
    const reg = new NativeCropRegistry(1)
    reg.register(handle(12), mkRequester(), DEVICE_ID)
    vi.advanceTimersByTime(1_000)
    reg.register(handle(13), mkRequester(), DEVICE_ID)
    expect(reg.lookup(handle(12)).kind).toBe('unknown')
    expect(reg.deviceIdFor(handle(12))).toBe(DEVICE_ID)
  })

  it('SWEEPS expired entries on registration, so the registry stops sitting pinned at its cap', () => {
    const reg = new NativeCropRegistry(4096)
    const stale = mkRequester()
    reg.register(handle(6), stale, DEVICE_ID)

    vi.advanceTimersByTime(MEASURED_MEDIAN_AGE_MS)
    reg.register(handle(7), mkRequester(), DEVICE_ID)

    // The frame nobody could ever ask for again no longer occupies the
    // node-wide registry, and its worker-side lease was released 20 s earlier
    // than the capacity eviction would have released it. That is removing the
    // allocation, not raising the ceiling.
    expect(reg.size).toBe(1)
    expect(stale.release).toHaveBeenCalledTimes(1)
  })

  it('the sweep never drops an entry a request could still have been served from', () => {
    const reg = new NativeCropRegistry(4096)
    const fresh = mkRequester()
    reg.register(handle(8), fresh, DEVICE_ID)
    vi.advanceTimersByTime(9_999)
    reg.register(handle(9), mkRequester(), DEVICE_ID)

    expect(reg.size).toBe(2)
    expect(fresh.release).not.toHaveBeenCalled()
    expect(reg.lookup(handle(8)).kind).toBe('live')
  })
})
