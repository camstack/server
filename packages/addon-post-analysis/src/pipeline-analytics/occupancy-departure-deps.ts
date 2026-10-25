/**
 * The addon's wiring of D691's two notification-centre deps, as ONE named
 * builder so the production mapping is tested (review M4) instead of living
 * as untested lambdas inside the centre's constructor call.
 *
 *  - `requestOccupancyLook` — the early look at a pending flip's sustain end,
 *    served by `pipelineOrchestrator.requestOccupancyLook`. An addon-to-addon
 *    call: it reaches the orchestrator's provider directly, never the hub's
 *    tRPC router.
 *  - `getPastStill` — a departure's frame at a past instant: the clip ring
 *    first (`streamBroker.renderPreBufferClip`, real-time mp4, ±1 s), the
 *    RECORDINGS when the ring has lost it (review M2: one `recordingExport`
 *    cut under D686's 30 s bound), the frame decoded on the pinned ffmpeg.
 */
import type { OccupancyLookAnswer, OccupancyLookRequest } from '@camstack/types'
import { NC_RECORDED_FOOTAGE_WAIT_MS } from '../notification-center/dispatcher.js'
import type {
  NcRecordedClipRequest,
  NcRecordedClipResult,
} from '../notification-center/recorded-clip.js'
import {
  cutRingStill,
  NC_RING_STILL_MAX_WIDTH,
  type NcRingStill,
  type NcRingStillPorts,
} from '../notification-center/ring-still.js'

/** The ring cut's input — the `renderPreBufferClip` fields this sets. */
export interface OccupancyDepartureRingInput {
  readonly deviceId: number
  readonly aroundMs: number
  readonly format: 'mp4'
  readonly preRollSec: number
  readonly postRollSec: number
  readonly maxWidth: number
  readonly fps: number
  readonly speed: number
}

/** What the builder reaches outside itself. */
export interface OccupancyDepartureDepsInput {
  readonly requestOccupancyLook: (ask: OccupancyLookRequest) => Promise<OccupancyLookAnswer>
  readonly renderPreBufferClip: (
    input: OccupancyDepartureRingInput,
  ) => Promise<{ readonly base64: string }>
  readonly cutRecordedClip: (req: NcRecordedClipRequest) => Promise<NcRecordedClipResult>
  /** The frame decode: pinned ffmpeg, bounded child, staged temp file. */
  readonly derive: Omit<NcRingStillPorts, 'renderRingMp4' | 'renderRecordedMp4'>
  readonly now: () => number
}

/** The two deps, in the shape `NotificationCenterDeps` takes them. */
export interface OccupancyDepartureDeps {
  readonly requestOccupancyLook: (ask: OccupancyLookRequest) => Promise<OccupancyLookAnswer>
  readonly getPastStill: (deviceId: number, atMs: number) => Promise<NcRingStill>
}

/** The ring answer as bytes. An empty answer stays empty: `cutRingStill`
 *  treats it as a ring miss and falls back to the recordings. */
function ringBytes(base64: string): Uint8Array {
  const buf = Buffer.from(base64, 'base64')
  const bytes = new Uint8Array(buf.byteLength)
  bytes.set(buf)
  return bytes
}

export function buildOccupancyDepartureDeps(
  input: OccupancyDepartureDepsInput,
): OccupancyDepartureDeps {
  const ports: NcRingStillPorts = {
    ...input.derive,
    renderRingMp4: async (deviceId, aroundMs, halfWindowSec) => {
      const res = await input.renderPreBufferClip({
        deviceId,
        aroundMs,
        format: 'mp4',
        preRollSec: halfWindowSec,
        postRollSec: halfWindowSec,
        maxWidth: NC_RING_STILL_MAX_WIDTH,
        fps: 5,
        speed: 1,
      })
      return ringBytes(res.base64)
    },
    renderRecordedMp4: async (deviceId, aroundMs, halfWindowSec) => {
      const cut = await input.cutRecordedClip({
        deviceId,
        aroundMs,
        preRollSec: halfWindowSec,
        postRollSec: halfWindowSec,
        ruleId: 'occupancy-departure-still',
        recordId: `departure-still:${String(deviceId)}:${String(aroundMs)}`,
        deadlineMs: input.now() + NC_RECORDED_FOOTAGE_WAIT_MS,
      })
      return cut.ok ? { ok: true, mp4: cut.mp4 } : { ok: false, reason: cut.reason }
    },
  }
  return {
    requestOccupancyLook: (ask) => input.requestOccupancyLook(ask),
    getPastStill: (deviceId, atMs) => cutRingStill(ports, deviceId, atMs),
  }
}
