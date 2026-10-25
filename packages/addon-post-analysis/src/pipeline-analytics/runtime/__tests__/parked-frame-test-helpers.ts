/**
 * Shared fixtures for `ParkedFrameClient` specs — extracted from
 * `parked-frame-client.spec.ts` (D683 Task 17) so the adopt spec can build the
 * same fake api + orders without duplicating them.
 */
import type { FrameHandle, ParkedFrameKind, ParkTrackFrameResult } from '@camstack/types'
import { vi } from 'vitest'
import { makeLogRecorder } from '../../__tests__/test-helpers.js'
import { buildParkOrders } from '../../pipeline/track-park.js'
import {
  createParkedFrameClient,
  type ParkedFrameApi,
  type ParkedFrameClient,
} from '../parked-frame-client.js'

export const NODE_ID = 'agent-a'
export const DEVICE_ID = 102

export const HANDLE: FrameHandle = {
  shmId: 'ram:agent-a:102',
  slot: 1,
  seq: 44,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: 0,
  byteLength: 640 * 360 * 3,
  nodeId: NODE_ID,
  slotCount: 1024,
}

const PARKED: ParkTrackFrameResult = {
  parked: true,
  nodeId: NODE_ID,
  width: 3840,
  height: 2160,
  bytes: 1_800_000,
  replaced: false,
}

export interface FakeApi extends ParkedFrameApi {
  readonly park: ReturnType<typeof vi.fn>
  readonly get: ReturnType<typeof vi.fn>
  readonly rel: ReturnType<typeof vi.fn>
}

export function makeApi(
  overrides: Partial<{
    park: ReturnType<typeof vi.fn>
    get: ReturnType<typeof vi.fn>
    rel: ReturnType<typeof vi.fn>
  }> = {},
): FakeApi {
  const park = overrides.park ?? vi.fn(async () => PARKED)
  const get =
    overrides.get ??
    vi.fn(async () => ({
      jpeg: Buffer.from('parcel').toString('base64'),
      width: 3840,
      height: 2160,
      timestamp: 5_000,
      parkedAt: 9_000,
    }))
  const rel = overrides.rel ?? vi.fn(async () => ({ released: 2 }))
  return {
    park,
    get,
    rel,
    parkTrackFrame: { mutate: park },
    getParkedTrackFrame: { query: get },
    releaseParkedTrackFrames: { mutate: rel },
  }
}

/** One park order for `(trackId, kind)` — built from the real `buildParkOrders`
 *  geometry so the handle/bbox/layout shape matches production exactly. */
export function parkOrder(input: { readonly trackId: string; readonly kind: ParkedFrameKind }) {
  const [keyFrameOrder, thumbnailOrder] = buildParkOrders({
    deviceId: DEVICE_ID,
    trackId: input.trackId,
    timestamp: 5_000,
    frameHandle: HANDLE,
    bbox: { x: 100, y: 80, w: 60, h: 140 },
    frameWidth: 640,
    frameHeight: 360,
  })
  const order = input.kind === 'keyFrame' ? keyFrameOrder : thumbnailOrder
  if (order === undefined) throw new Error('unreachable')
  return order
}

/** A `ParkedFrameClient` built over the shared fake api, plus the ids it was
 *  asked to release (D683: the adopt spec's `released()`). */
export interface ParkedClientTestHarness {
  readonly client: ParkedFrameClient
  readonly api: FakeApi
  readonly released: () => readonly string[]
}

export function buildParkedClientForTest(): ParkedClientTestHarness {
  const api = makeApi()
  const client = createParkedFrameClient({ api, logger: makeLogRecorder().logger })
  const released = (): readonly string[] => api.rel.mock.calls.map(([input]) => input.trackId)
  return { client, api, released }
}
