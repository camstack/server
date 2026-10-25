import { describe, it, expect } from 'vitest'
import type { ObjectDetection } from '@camstack/types'
import {
  buildOverlayDetections,
  OVERLAY_DETAIL_FRESHNESS_MS,
  type OverlayTrackedBinding,
} from '../overlay-frame-builder.js'
import { makeTrackedDetectionOut } from './support/tracked-detection-out.js'
import type { TrackedDetectionOut } from '../pipeline/frame-processor.js'
import type { OverlayDetailState } from '../overlay-state.js'

const NOW = 10_000

function root(id: string, x: number, y: number, w: number, h: number): ObjectDetection {
  return {
    id,
    kind: 'first-level',
    macroClass: 'person',
    score: 0.9,
    labels: [],
    bbox: { x, y, width: w, height: h },
  }
}

function trackedFor(root: ObjectDetection, trackId: string): TrackedDetectionOut {
  return makeTrackedDetectionOut({
    trackId,
    sourceDetectionId: root.id,
    className: root.macroClass,
    confidence: root.score,
    bbox: { x: root.bbox.x, y: root.bbox.y, w: root.bbox.width, h: root.bbox.height },
    zones: ['zone-a'],
  })
}

// Fresh face detail stored in FRAME SPACE (absolute pixels), captured just now.
const FACE_STATE: OverlayDetailState = {
  face: { bbox: { x: 150, y: 220, w: 50, h: 60 }, score: 0.8, capturedAt: NOW - 500 },
}

describe('buildOverlayDetections', () => {
  it('passes roots through, attaches track info and identity label', () => {
    const r = root('d1', 100, 200, 200, 400)
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [trackedFor(r, 't1')],
      overlayFor: () => undefined,
      labelFor: () => 'Alice',
      nowMs: NOW,
    })
    expect(out).toHaveLength(1)
    const enriched = out[0]!
    expect(enriched.bbox).toEqual(r.bbox)
    expect(enriched.track?.trackId).toBe('t1')
    expect(enriched.track?.zones).toEqual(['zone-a'])
    expect(enriched.labels).toContainEqual({ label: 'Alice', score: 1 })
    // input not mutated
    expect(r.labels).toHaveLength(0)
    expect(r.track).toBeUndefined()
  })

  it('synthesizes a FRESH face detail with the TRUE frame-space bbox (no re-projection)', () => {
    const r = root('d1', 100, 200, 200, 400)
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [trackedFor(r, 't1')],
      overlayFor: (trackId) => (trackId === 't1' ? FACE_STATE : undefined),
      labelFor: () => 'Alice',
      nowMs: NOW,
    })
    expect(out).toHaveLength(2)
    const face = out.find((d) => d.kind === 'detail')!
    expect(face.id).toBe('detail-t1-face')
    expect(face.macroClass).toBe('face')
    expect(face.parentId).toBe('d1')
    expect(face.score).toBe(0.8)
    // The stored frame-space bbox is emitted as-is (x,y,w,h → x,y,width,height).
    expect(face.bbox).toEqual({ x: 150, y: 220, width: 50, height: 60 })
    expect(face.labels).toEqual([{ label: 'Alice', score: 0.8 }])
  })

  it('does NOT synthesize a STALE face detail (older than the freshness window)', () => {
    const r = root('d1', 100, 200, 200, 400)
    const stale: OverlayDetailState = {
      face: {
        bbox: { x: 150, y: 220, w: 50, h: 60 },
        score: 0.8,
        capturedAt: NOW - OVERLAY_DETAIL_FRESHNESS_MS - 1,
      },
    }
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [trackedFor(r, 't1')],
      overlayFor: () => stale,
      labelFor: () => 'Alice',
      nowMs: NOW,
    })
    // Root only — no synthesized detail for a stale box.
    expect(out).toHaveLength(1)
    expect(out.some((d) => d.kind === 'detail')).toBe(false)
  })

  it('synthesizes a fresh plate detail with the OCR text as label', () => {
    const r = { ...root('d2', 0, 0, 400, 200), macroClass: 'vehicle' }
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [{ ...trackedFor(r, 't2'), className: 'vehicle' }],
      overlayFor: () => ({
        plate: {
          bbox: { x: 200, y: 100, w: 100, h: 40 },
          score: 0.9,
          capturedAt: NOW - 100,
          text: 'AB123CD',
        },
      }),
      labelFor: () => undefined,
      nowMs: NOW,
    })
    const plate = out.find((d) => d.kind === 'detail')!
    expect(plate.id).toBe('detail-t2-plate')
    expect(plate.macroClass).toBe('plate')
    expect(plate.bbox).toEqual({ x: 200, y: 100, width: 100, height: 40 })
    expect(plate.labels).toEqual([{ label: 'AB123CD', score: 0.9 }])
  })

  it('does not synthesize a STALE plate detail', () => {
    const r = { ...root('d2', 0, 0, 400, 200), macroClass: 'vehicle' }
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [{ ...trackedFor(r, 't2'), className: 'vehicle' }],
      overlayFor: () => ({
        plate: {
          bbox: { x: 200, y: 100, w: 100, h: 40 },
          score: 0.9,
          capturedAt: NOW - OVERLAY_DETAIL_FRESHNESS_MS - 1,
          text: 'AB123CD',
        },
      }),
      labelFor: () => undefined,
      nowMs: NOW,
    })
    expect(out.some((d) => d.kind === 'detail')).toBe(false)
  })

  it('does not synthesize when the frame ALREADY carries a real detail of that kind for the parent', () => {
    const r = root('d1', 0, 0, 100, 100)
    const realFace: ObjectDetection = {
      id: 'real-face',
      kind: 'detail',
      macroClass: 'face',
      parentId: 'd1',
      score: 0.7,
      labels: [],
      bbox: { x: 10, y: 10, width: 20, height: 20 },
    }
    const out = buildOverlayDetections({
      frameDetections: [r, realFace],
      tracked: [trackedFor(r, 't1')],
      overlayFor: () => FACE_STATE,
      labelFor: () => undefined,
      nowMs: NOW,
    })
    expect(out.filter((d) => d.macroClass === 'face')).toHaveLength(1)
    expect(out.find((d) => d.macroClass === 'face')?.id).toBe('real-face')
  })

  it('roots with no matched track pass through unchanged (zone-filtered parity)', () => {
    const r = root('d9', 0, 0, 50, 50)
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [],
      overlayFor: () => undefined,
      labelFor: () => undefined,
      nowMs: NOW,
    })
    expect(out).toEqual([r])
  })

  it('does not duplicate an identity label already present on the root', () => {
    const r = { ...root('d1', 0, 0, 100, 100), labels: [{ label: 'Alice', score: 0.6 }] }
    const out = buildOverlayDetections({
      frameDetections: [r],
      tracked: [trackedFor(r, 't1')],
      overlayFor: () => undefined,
      labelFor: () => 'Alice',
      nowMs: NOW,
    })
    expect(out[0]!.labels.filter((l) => l.label === 'Alice')).toHaveLength(1)
  })

  // ── the movement state travels ───────────────────────────────────────────
  //
  // The tracker computes `'entering'|'moving'|'stationary'|'leaving'|'loitering'`
  // for every track, every frame (`StateAnalyzer`, 10 s stationary threshold),
  // and it reached this builder intact — which then wrote `track: { trackId,
  // zones }` and dropped it. The consequence the operator reported: in the live
  // overlay a parked car and a person standing still are drawn exactly like one
  // that is walking.
  //
  // `TrackInfo` even carried an unused `moving?: boolean` for this, declared and
  // never assigned anywhere in the repo. It is gone; the full state travels,
  // because "not moving" and "loitering" are different things to draw.
  describe('buildOverlayDetections — movement state', () => {
    it('carries the track state onto the detection', () => {
      const r = root('d1', 10, 10, 40, 80)
      const out = buildOverlayDetections({
        frameDetections: [r],
        tracked: [trackedFor(r, 't1')],
        overlayFor: () => undefined,
        labelFor: () => undefined,
        nowMs: 1_000,
      })
      expect(out[0]?.track?.movementState).toBe('moving')
    })

    it("carries IDLE — the tracker's word for still, which is the whole point", () => {
      const r = root('d1', 10, 10, 40, 80)
      const out = buildOverlayDetections({
        frameDetections: [r],
        tracked: [{ ...trackedFor(r, 't1'), state: 'idle' as const }],
        overlayFor: () => undefined,
        labelFor: () => undefined,
        nowMs: 1_000,
      })
      expect(out[0]?.track?.movementState).toBe('idle')
    })

    // A track the analyzer has not classified yet is UNKNOWN, not moving. The
    // viewer must be able to tell "still" from "nobody has said yet", or a fresh
    // track would flash as stationary for its first frames.
    it('leaves the field absent when the tracker has no verdict', () => {
      const r = root('d1', 10, 10, 40, 80)
      const { state: _state, ...withoutState } = trackedFor(r, 't1')
      const out = buildOverlayDetections({
        frameDetections: [r],
        tracked: [{ ...withoutState, state: undefined } satisfies OverlayTrackedBinding],
        overlayFor: () => undefined,
        labelFor: () => undefined,
        nowMs: 1_000,
      })
      expect(out[0]?.track?.movementState).toBeUndefined()
    })
  })
})
