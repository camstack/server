/**
 * `buildParkOrders` — what the hub ORDERS the owning node to keep the instant
 * `BestDetectionTracker` accepts a frame as a track's best (D422).
 *
 * Pinned:
 *  - exactly two parcels per decision, `keyFrame` and `thumbnail`, keyed by
 *    the track — one encode each on the node, no stream;
 *  - the key frame is the WHOLE frame at the native cap, so the runner can
 *    cut any later detail rectangle from it (D52: the runner cuts);
 *  - the thumbnail carries the SAME 16:9 central-square window the best shot
 *    has always been cut with — one framing rule, never a second copy — and
 *    the layout rides along so the hub can compose the parcel later;
 *  - every order names the handle's node, the frame instant and the subject's
 *    box in detection space, which is what a detail dispatch on the parcel
 *    scales from.
 */
import type { FrameHandle } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { deliveredWideCentralSquareLayout } from '../../../shared/frame/wide-central-square-crop.js'
import { KEYFRAME_NATIVE_MAX_WIDTH } from '../key-frame-capture.js'
import { buildParkOrders, scaleSubjectIntoParcel } from '../track-park.js'

const handle: FrameHandle = {
  shmId: 'ram:agent-a:102',
  slot: 1,
  seq: 44,
  width: 640,
  height: 360,
  format: 'rgb',
  pts: 0,
  byteLength: 640 * 360 * 3,
  nodeId: 'agent-a',
  slotCount: 1024,
}

const decision = {
  deviceId: 102,
  trackId: 't-1',
  timestamp: 1_757_412_000_000,
  frameHandle: handle,
  bbox: { x: 100, y: 80, w: 60, h: 140 },
  frameWidth: 640,
  frameHeight: 360,
}

describe('buildParkOrders', () => {
  it('orders a native full-frame keyFrame and a subject thumbnail for the track', () => {
    const orders = buildParkOrders(decision)
    expect(orders.map((o) => o.kind)).toEqual(['keyFrame', 'thumbnail'])
    for (const order of orders) {
      expect(order.deviceId).toBe(102)
      expect(order.trackId).toBe('t-1')
      expect(order.handle).toBe(handle)
      expect(order.timestamp).toBe(decision.timestamp)
      expect(order.subject).toEqual({
        bbox: { x: 100, y: 80, w: 60, h: 140 },
        frameWidth: 640,
        frameHeight: 360,
      })
    }
  })

  it('the keyFrame is the WHOLE frame at the native cap — the runner cuts everything later', () => {
    const [keyFrame] = buildParkOrders(decision)
    expect(keyFrame?.bbox).toEqual({ x: 0, y: 0, w: 1, h: 1 })
    expect(keyFrame?.maxWidth).toBe(KEYFRAME_NATIVE_MAX_WIDTH)
    expect(keyFrame?.layout).toBeUndefined()
  })

  it('the thumbnail window is the SAME central-square layout the best shot has always used, uncapped', () => {
    const [, thumbnail] = buildParkOrders(decision)
    const expected = deliveredWideCentralSquareLayout(decision.bbox, { W: 640, H: 360 })
    expect(thumbnail?.bbox).toEqual(expected.fetch)
    expect(thumbnail?.layout).toEqual(expected)
    // Uncapped: a subject crop is TRUE native (decision #3 of the 2026-07-21 rework).
    expect(thumbnail?.maxWidth).toBeUndefined()
  })
})

describe('scaleSubjectIntoParcel', () => {
  it('places the detection-space box onto the native parcel with a per-axis scale', () => {
    expect(
      scaleSubjectIntoParcel(
        { bbox: { x: 100, y: 80, w: 60, h: 140 }, frameWidth: 640, frameHeight: 360 },
        3840,
        2160,
      ),
    ).toEqual({ x: 600, y: 480, w: 360, h: 840 })
  })

  it('is the identity when the parcel is at detection scale', () => {
    const subject = { bbox: { x: 1, y: 2, w: 3, h: 4 }, frameWidth: 640, frameHeight: 360 }
    expect(scaleSubjectIntoParcel(subject, 640, 360)).toEqual(subject.bbox)
  })
})
