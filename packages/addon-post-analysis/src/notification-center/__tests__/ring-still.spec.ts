/**
 * A departure's picture from the clip ring, at the moment it happened (D691).
 *
 * The still shelf asks `getPastStill(deviceId, atMs)` when a became-free edge
 * names nobody who left. The production answer cuts a two-second window of the
 * ring centred on `atMs` and decodes the frame ONE SECOND before its end —
 * `atMs` itself — on the pinned ffmpeg. These pin the cut, the frame choice,
 * the staged file's removal, and that every miss is a THROW the shelf names on
 * its tagged line, never a silent null that reads as "no snapshot".
 */
import { describe, expect, it } from 'vitest'
import type { NcRecordedGifRunResult } from '../recorded-gif.js'
import {
  cutRingStill,
  NC_RING_STILL_HALF_WINDOW_SEC,
  type NcRingStillPorts,
  type NcRingStillRecorded,
  ringStillArgs,
} from '../ring-still.js'

const DEVICE = 102
const AT = 1_790_833_816_310

interface Recorded {
  readonly cuts: Array<{ deviceId: number; aroundMs: number; halfWindowSec: number }>
  readonly runs: Array<{ cmd: string; args: readonly string[] }>
  readonly staged: string[]
  readonly removed: string[]
  readonly recordedAsks: Array<{ deviceId: number; aroundMs: number; halfWindowSec: number }>
}

function ports(opts: {
  readonly mp4?: Uint8Array | null
  readonly ringThrows?: string
  readonly run?: NcRecordedGifRunResult
  readonly recorded?: NcRingStillRecorded
}): {
  ports: NcRingStillPorts
  rec: Recorded
} {
  const rec: Recorded = { cuts: [], runs: [], staged: [], removed: [], recordedAsks: [] }
  const recorded = opts.recorded
  return {
    rec,
    ports: {
      renderRingMp4: async (deviceId, aroundMs, halfWindowSec) => {
        rec.cuts.push({ deviceId, aroundMs, halfWindowSec })
        if (opts.ringThrows !== undefined) throw new Error(opts.ringThrows)
        return opts.mp4 === undefined ? Uint8Array.from([1, 2, 3]) : opts.mp4
      },
      ...(recorded !== undefined
        ? {
            renderRecordedMp4: async (
              deviceId: number,
              aroundMs: number,
              halfWindowSec: number,
            ) => {
              rec.recordedAsks.push({ deviceId, aroundMs, halfWindowSec })
              return recorded
            },
          }
        : {}),
      resolveFfmpeg: async () => '/pinned/ffmpeg',
      run: async (cmd, args) => {
        rec.runs.push({ cmd, args })
        return opts.run ?? { ok: true, stdout: Buffer.from([0xff, 0xd8, 0xff]) }
      },
      writeTemp: async () => {
        const file = `/tmp/ring-still-${rec.staged.length}.mp4`
        rec.staged.push(file)
        return file
      },
      removeTemp: async (file) => {
        rec.removed.push(file)
      },
    },
  }
}

describe('cutRingStill', () => {
  it('cuts the ring around the moment and decodes the frame AT it, on the pinned ffmpeg', async () => {
    const { ports: p, rec } = ports({})
    const shot = await cutRingStill(p, DEVICE, AT)
    expect(rec.cuts).toEqual([
      { deviceId: DEVICE, aroundMs: AT, halfWindowSec: NC_RING_STILL_HALF_WINDOW_SEC },
    ])
    expect(rec.runs[0]?.cmd).toBe('/pinned/ffmpeg')
    expect(rec.runs[0]?.args).toEqual(ringStillArgs('/tmp/ring-still-0.mp4'))
    expect(shot).toEqual({
      base64: Buffer.from([0xff, 0xd8, 0xff]).toString('base64'),
      contentType: 'image/jpeg',
    })
    // The staged clip never outlives the derive.
    expect(rec.removed).toEqual(['/tmp/ring-still-0.mp4'])
  })

  it('takes the frame one half-window before the END — the moment, not the tail', () => {
    const args = ringStillArgs('/x.mp4')
    const sseof = args.indexOf('-sseof')
    expect(args[sseof + 1]).toBe(`-${String(NC_RING_STILL_HALF_WINDOW_SEC)}`)
    // `-sseof` is an INPUT option: it must precede the input it applies to.
    expect(sseof).toBeLessThan(args.indexOf('-i'))
    expect(args.slice(args.indexOf('-frames:v'), args.indexOf('-frames:v') + 2)).toEqual([
      '-frames:v',
      '1',
    ])
  })

  it('throws, by name, when the ring holds nothing at that instant', async () => {
    const { ports: p, rec } = ports({ mp4: null })
    await expect(cutRingStill(p, DEVICE, AT)).rejects.toThrow(/ring held no footage/)
    expect(rec.runs).toHaveLength(0)
  })

  it('throws, by name, when ffmpeg decodes nothing — and still removes the staged clip', async () => {
    const { ports: p, rec } = ports({ run: { ok: false, error: 'moov atom not found' } })
    await expect(cutRingStill(p, DEVICE, AT)).rejects.toThrow(/moov atom not found/)
    expect(rec.removed).toEqual(['/tmp/ring-still-0.mp4'])
  })

  // Fix round 1 (review M2): a long sustain, or a cheap profile past the
  // ring's byte cap, puts the moment outside the ring — the RECORDINGS still
  // hold it, so the frame is cut from there before giving up.
  it('falls back to the RECORDINGS when the ring no longer holds the moment', async () => {
    const { ports: p, rec } = ports({
      ringThrows: 'window not in the clip ring',
      recorded: { ok: true, mp4: Uint8Array.from([4, 5, 6]) },
    })
    const shot = await cutRingStill(p, DEVICE, AT)
    expect(rec.recordedAsks).toEqual([
      { deviceId: DEVICE, aroundMs: AT, halfWindowSec: NC_RING_STILL_HALF_WINDOW_SEC },
    ])
    expect(rec.runs[0]?.args).toEqual(ringStillArgs('/tmp/ring-still-0.mp4'))
    expect(shot.contentType).toBe('image/jpeg')
  })

  it('falls back to the recordings when the ring answered EMPTY, too', async () => {
    const { ports: p, rec } = ports({
      mp4: new Uint8Array(0),
      recorded: { ok: true, mp4: Uint8Array.from([4, 5, 6]) },
    })
    await cutRingStill(p, DEVICE, AT)
    expect(rec.recordedAsks).toHaveLength(1)
  })

  it('names BOTH misses when neither the ring nor the recordings hold the moment', async () => {
    const { ports: p } = ports({
      ringThrows: 'window not in the clip ring',
      recorded: { ok: false, reason: 'not-recorded' },
    })
    await expect(cutRingStill(p, DEVICE, AT)).rejects.toThrow(
      /ring: window not in the clip ring; recordings: not-recorded/,
    )
  })

  it('never asks the recordings when the ring served the moment', async () => {
    const { ports: p, rec } = ports({ recorded: { ok: true, mp4: Uint8Array.from([4]) } })
    await cutRingStill(p, DEVICE, AT)
    expect(rec.recordedAsks).toHaveLength(0)
  })
})
