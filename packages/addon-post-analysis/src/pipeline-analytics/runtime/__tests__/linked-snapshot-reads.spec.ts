/**
 * The two capture-free snapshot reads the linked-camera shelf is given
 * (ADR 0632): which camera must not be dialled, and how old a cached frame is.
 * Neither may ever capture — a capture wakes a battery camera.
 */
import { describe, expect, it } from 'vitest'
import {
  buildLinkedSnapshotReads,
  type LinkedSnapshotReadClient,
} from '../linked-snapshot-reads.js'

interface Calls {
  readonly debug: number[]
  readonly overview: number[][]
}

function client(calls: Calls): LinkedSnapshotReadClient {
  return {
    getDebugState: {
      query: async ({ deviceId }) => {
        calls.debug.push(deviceId)
        return {
          battery: null,
          state: { isBattery: true, reason: deviceId === 102 ? 'sleeping' : null },
          frame: { capturedAt: null, ageMs: null },
          waking: false,
        }
      },
    },
    getSnapshotOverview: {
      query: async ({ deviceIds }) => {
        calls.overview.push([...deviceIds])
        return deviceIds.map((deviceId) => ({
          deviceId,
          lastCapturedAt: deviceId === 101 ? 1_000 : null,
          cacheAgeMs: null,
          etag: null,
        }))
      },
    },
  }
}

describe('buildLinkedSnapshotReads', () => {
  it("reads a camera's wrapper state reason off the capture-free debug state", async () => {
    const calls: Calls = { debug: [], overview: [] }
    const reads = buildLinkedSnapshotReads(client(calls))
    expect(await reads.getSnapshotState(102)).toEqual({ reason: 'sleeping' })
    expect(await reads.getSnapshotState(101)).toEqual({ reason: null })
    expect(calls.debug).toEqual([102, 101])
  })

  it("reads every camera's cached-frame instant in ONE cache-only batch", async () => {
    const calls: Calls = { debug: [], overview: [] }
    const reads = buildLinkedSnapshotReads(client(calls))
    const at = await reads.getFrameCapturedAt([101, 102])
    expect([...at]).toEqual([
      [101, 1_000],
      [102, null],
    ])
    expect(calls.overview).toEqual([[101, 102]])
  })

  it('no cameras → no call (the batch refuses an empty list)', async () => {
    const calls: Calls = { debug: [], overview: [] }
    const reads = buildLinkedSnapshotReads(client(calls))
    expect((await reads.getFrameCapturedAt([])).size).toBe(0)
    expect(calls.overview).toEqual([])
  })
})
