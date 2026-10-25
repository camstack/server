import { describe, expect, it } from 'vitest'
import { summarizeEvictionsByDevice } from '../storage-evictable-provider.js'
import type { SegmentRow } from '../types.js'

const row = (deviceId: number, startMs: number, durMs: number, bytes: number): SegmentRow => ({
  deviceId,
  profile: 'low',
  startMs,
  durMs,
  bytes,
  path: `${deviceId}/low/${startMs}-${durMs}-${bytes}.m4s`,
  locationId: 'recordingsLow:default',
})

describe('summarizeEvictionsByDevice', () => {
  it('returns empty for no victims', () => {
    expect(summarizeEvictionsByDevice([], new Set())).toEqual([])
  })

  it('groups victims per device with byte totals and time span', () => {
    const victims = [
      row(104, 1_000, 10_000, 100),
      row(102, 5_000, 10_000, 200),
      row(104, 21_000, 10_000, 300),
    ]
    const out = summarizeEvictionsByDevice(victims, new Set())
    expect(out).toHaveLength(2)
    const d590 = out.find((s) => s.deviceId === 104)
    expect(d590).toEqual({
      deviceId: 104,
      locationId: 'recordingsLow:default',
      segments: 2,
      bytes: 400,
      fromMs: 1_000,
      toMs: 31_000,
      reason: 'oldest-first',
    })
    const d617 = out.find((s) => s.deviceId === 102)
    expect(d617?.segments).toBe(1)
    expect(d617?.bytes).toBe(200)
  })

  it('splits a device across aliased locations into separate summaries', () => {
    const hi = (deviceId: number, startMs: number, bytes: number): SegmentRow => ({
      deviceId,
      profile: 'high',
      startMs,
      durMs: 10_000,
      bytes,
      path: `${deviceId}/high/${startMs}-10000-${bytes}.m4s`,
      locationId: 'recordings:default',
    })
    const out = summarizeEvictionsByDevice(
      [row(104, 1_000, 10_000, 100), hi(104, 2_000, 200)],
      new Set(),
    )
    expect(out).toHaveLength(2)
    expect(out.find((s) => s.locationId === 'recordingsLow:default')?.bytes).toBe(100)
    expect(out.find((s) => s.locationId === 'recordings:default')?.bytes).toBe(200)
  })
})

describe('summarizeEvictionsByDevice — the reason reaches the activity history', () => {
  it("files a confirmed-gone camera's share as `orphaned-device` and everyone else's as `oldest-first`", () => {
    // 104 is gone; 102 is a live camera whose OLDER footage was still needed to
    // finish the round. One round, two reasons — which is the whole point: the
    // operator's question after a disk fills is "did I lose footage of a camera
    // I still have?", and a single reason for both cannot answer it.
    const out = summarizeEvictionsByDevice(
      [row(104, 21_000, 10_000, 300), row(102, 1_000, 10_000, 200)],
      new Set([104]),
    )
    expect(out.find((s) => s.deviceId === 104)?.reason).toBe('orphaned-device')
    expect(out.find((s) => s.deviceId === 102)?.reason).toBe('oldest-first')
  })

  it('keeps one reason across every segment of the same camera', () => {
    const out = summarizeEvictionsByDevice(
      [row(104, 1_000, 10_000, 100), row(104, 21_000, 10_000, 300)],
      new Set([104]),
    )
    expect(out).toHaveLength(1)
    expect(out[0]?.reason).toBe('orphaned-device')
    expect(out[0]?.segments).toBe(2)
  })
})
