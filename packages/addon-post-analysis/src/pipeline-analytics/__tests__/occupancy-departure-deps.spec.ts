/**
 * The PRODUCTION wiring of D691's two notification-centre deps (review M4) —
 * `requestOccupancyLook` and `getPastStill` — built by the same function the
 * addon calls, against a fake `api`. Every other D691 test injects these as
 * fakes, and twice this repo has had a test pass because the fake supplied
 * what production forgot.
 */
import type { OccupancyLookRequest } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { NC_RECORDED_FOOTAGE_WAIT_MS } from '../../notification-center/dispatcher.js'
import type {
  NcRecordedClipRequest,
  NcRecordedClipResult,
} from '../../notification-center/recorded-clip.js'
import {
  NC_RING_STILL_HALF_WINDOW_SEC,
  NC_RING_STILL_MAX_WIDTH,
  ringStillArgs,
} from '../../notification-center/ring-still.js'
import {
  buildOccupancyDepartureDeps,
  type OccupancyDepartureRingInput,
} from '../occupancy-departure-deps.js'

const DEVICE = 102
const AT = 1_790_833_816_310
const NOW = 1_790_833_850_000
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xd9])

interface Seen {
  readonly looks: OccupancyLookRequest[]
  readonly ringCuts: OccupancyDepartureRingInput[]
  readonly recorded: NcRecordedClipRequest[]
  readonly runs: Array<readonly string[]>
  readonly removed: string[]
}

function build(opts: { readonly ringBase64?: string; readonly recorded?: NcRecordedClipResult }) {
  const seen: Seen = { looks: [], ringCuts: [], recorded: [], runs: [], removed: [] }
  const deps = buildOccupancyDepartureDeps({
    requestOccupancyLook: async (ask) => {
      seen.looks.push(ask)
      return { scheduled: true, dueInMs: 31_000 }
    },
    renderPreBufferClip: async (input) => {
      seen.ringCuts.push(input)
      return { base64: opts.ringBase64 ?? Buffer.from([1, 2, 3]).toString('base64') }
    },
    cutRecordedClip: async (req) => {
      seen.recorded.push(req)
      return opts.recorded ?? { ok: false, reason: 'not-recorded' }
    },
    derive: {
      resolveFfmpeg: async () => '/pinned/ffmpeg',
      run: async (_cmd, args) => {
        seen.runs.push(args)
        return { ok: true, stdout: JPEG }
      },
      writeTemp: async () => '/tmp/staged.mp4',
      removeTemp: async (file) => {
        seen.removed.push(file)
      },
    },
    now: () => NOW,
  })
  return { deps, seen }
}

describe('buildOccupancyDepartureDeps — the addon wiring of D691', () => {
  it('forwards the early-look ask verbatim and returns the answer', async () => {
    const { deps, seen } = build({})
    const ask = { deviceId: DEVICE, afterMs: 29_000, reason: 'occupancy-pending' }
    expect(await deps.requestOccupancyLook(ask)).toEqual({ scheduled: true, dueInMs: 31_000 })
    expect(seen.looks).toEqual([ask])
  })

  it('cuts the RING as a real-time mp4 around the instant and decodes the frame at it', async () => {
    const { deps, seen } = build({})
    const shot = await deps.getPastStill(DEVICE, AT)
    expect(seen.ringCuts).toEqual([
      {
        deviceId: DEVICE,
        aroundMs: AT,
        format: 'mp4',
        preRollSec: NC_RING_STILL_HALF_WINDOW_SEC,
        postRollSec: NC_RING_STILL_HALF_WINDOW_SEC,
        maxWidth: NC_RING_STILL_MAX_WIDTH,
        fps: 5,
        speed: 1,
      },
    ])
    expect(seen.runs).toEqual([ringStillArgs('/tmp/staged.mp4')])
    expect(seen.removed).toEqual(['/tmp/staged.mp4'])
    expect(seen.recorded).toHaveLength(0)
    expect(shot).toEqual({ base64: JPEG.toString('base64'), contentType: 'image/jpeg' })
  })

  it('an EMPTY ring answer falls back to ONE recorded cut, bounded by the D686 wait', async () => {
    const mp4 = new Uint8Array(new ArrayBuffer(3))
    mp4.set([7, 7, 7])
    const { deps, seen } = build({ ringBase64: '', recorded: { ok: true, mp4, profile: 'low' } })
    await deps.getPastStill(DEVICE, AT)
    expect(seen.recorded).toHaveLength(1)
    const req = seen.recorded[0]
    expect(req?.deviceId).toBe(DEVICE)
    expect(req?.aroundMs).toBe(AT)
    expect(req?.preRollSec).toBe(NC_RING_STILL_HALF_WINDOW_SEC)
    expect(req?.postRollSec).toBe(NC_RING_STILL_HALF_WINDOW_SEC)
    expect(req?.deadlineMs).toBe(NOW + NC_RECORDED_FOOTAGE_WAIT_MS)
  })

  it('names the recorded refusal when neither source holds the moment', async () => {
    const { deps } = build({ ringBase64: '' })
    await expect(deps.getPastStill(DEVICE, AT)).rejects.toThrow(/recordings: not-recorded/)
  })
})
