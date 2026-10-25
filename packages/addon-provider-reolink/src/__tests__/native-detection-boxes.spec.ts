import { describe, it, expect } from 'vitest'
import type { ReolinkDetectionEvent, ReolinkDetectionBox } from '@apocaliss92/nodelink-js'
import {
  mapDetectionBox,
  mapDetectionEvent,
  NATIVE_BOX_FALLBACK_CLASS,
} from '../native-detection-mapping'

/** Build a minimal ReolinkDetectionBox for tests. */
function box(partial: Partial<ReolinkDetectionBox>): ReolinkDetectionBox {
  return { x: 0, y: 0, width: 0.1, height: 0.1, ...partial }
}

/** Build a minimal ReolinkDetectionEvent for tests. */
function event(partial: Partial<ReolinkDetectionEvent>): ReolinkDetectionEvent {
  return {
    channel: 0,
    microseconds: 123456789, // stream PTS — must NOT become the event time
    profile: 'sub',
    boxes: [],
    decodeState: 'overlay-decoded',
    rawHeader: Buffer.alloc(0),
    ...partial,
  }
}

const NOW = 1_700_000_000_000

describe('mapDetectionBox', () => {
  it('maps bbox tuple [x, y, w, h] verbatim (already normalized [0,1])', () => {
    const d = mapDetectionBox(box({ x: 0.2, y: 0.3, width: 0.4, height: 0.5 }), NOW)
    expect(d.bbox).toEqual([0.2, 0.3, 0.4, 0.5])
  })

  it('stamps the supplied epoch ms, never the stream PTS', () => {
    const d = mapDetectionBox(box({ label: 'person' }), NOW)
    expect(d.timestamp).toBe(NOW)
  })

  it('passes confidence through when the camera exposes it', () => {
    const d = mapDetectionBox(box({ label: 'person', confidence: 0.87 }), NOW)
    expect(d.confidence).toBe(0.87)
  })

  it('leaves confidence undefined when the camera omits it', () => {
    const d = mapDetectionBox(box({ label: 'vehicle' }), NOW)
    expect(d.confidence).toBeUndefined()
  })

  it('uses a cap-shaped label verbatim (loose-string contract)', () => {
    expect(mapDetectionBox(box({ label: 'vehicle' }), NOW).class).toBe('vehicle')
  })

  it('normalizes a Baichuan simple-event label through AI_CLASS_MAP (people → person)', () => {
    expect(mapDetectionBox(box({ label: 'people' }), NOW).class).toBe('person')
  })

  it('falls back to NATIVE_BOX_FALLBACK_CLASS when the box has no label', () => {
    expect(mapDetectionBox(box({}), NOW).class).toBe(NATIVE_BOX_FALLBACK_CLASS)
  })

  it('falls back when label is an empty string', () => {
    expect(mapDetectionBox(box({ label: '' }), NOW).class).toBe(NATIVE_BOX_FALLBACK_CLASS)
  })
})

describe('mapDetectionEvent', () => {
  it('emits one payload per event with all boxes, source onboard, cameraId', () => {
    const payload = mapDetectionEvent(
      event({
        boxes: [
          box({ label: 'person', x: 0.1, y: 0.1, width: 0.2, height: 0.2, confidence: 0.9 }),
          box({ label: 'vehicle', x: 0.5, y: 0.5, width: 0.3, height: 0.3 }),
        ],
        frameWidth: 640,
        frameHeight: 360,
      }),
      42,
      NOW,
    )
    expect(payload.cameraId).toBe(42)
    expect(payload.source).toBe('onboard')
    expect(payload.detections).toHaveLength(2)
    expect(payload.detections[0]).toEqual({
      class: 'person',
      timestamp: NOW,
      confidence: 0.9,
      bbox: [0.1, 0.1, 0.2, 0.2],
    })
    expect(payload.detections[1]?.class).toBe('vehicle')
  })

  it('carries frameWidth/frameHeight on the payload when the lib decoded them', () => {
    const payload = mapDetectionEvent(
      event({ boxes: [box({ label: 'person' })], frameWidth: 1920, frameHeight: 1080 }),
      1,
      NOW,
    )
    expect(payload.frameWidth).toBe(1920)
    expect(payload.frameHeight).toBe(1080)
  })

  it('leaves frame dims undefined when the lib did not decode them', () => {
    const payload = mapDetectionEvent(event({ boxes: [box({ label: 'person' })] }), 1, NOW)
    expect(payload.frameWidth).toBeUndefined()
    expect(payload.frameHeight).toBeUndefined()
  })

  it('never uses the stream PTS (microseconds) as a detection timestamp', () => {
    const payload = mapDetectionEvent(
      event({ microseconds: 999, boxes: [box({ label: 'person' })] }),
      1,
      NOW,
    )
    expect(payload.detections[0]?.timestamp).toBe(NOW)
    expect(payload.detections[0]?.timestamp).not.toBe(999)
  })

  it('produces an empty detections array for a box-less event', () => {
    const payload = mapDetectionEvent(event({ boxes: [] }), 1, NOW)
    expect(payload.detections).toEqual([])
  })
})
