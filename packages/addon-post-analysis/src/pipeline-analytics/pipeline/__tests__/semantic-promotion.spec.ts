/**
 * semantic-promotion — a frame from which a recognition SUCCEEDED (face
 * auto-match, attributed plate read, accepted fine classification) is offered
 * to the best-frame ranking with the SEMANTIC tier bit, and, when it becomes
 * the new best AND the frame's pixels are still reachable, the best-shot
 * captures (thumbnail + native keyFrame) re-fire from that frame.
 *
 * The geometry terms are composed from the SAME pure helpers the per-frame
 * path uses (`buildSnapshotTargets`) — no second derivation of any crop rect.
 */
import { describe, it, expect, vi } from 'vitest'
import type { FrameHandle } from '@camstack/types'
import { makeTestFrameHandle } from '../../__tests__/support/frame-handle.js'
import {
  promoteSemanticBestFrame,
  semanticFrameForDetailAttribution,
  type SemanticPromotionDeps,
  type SemanticRecognitionFrame,
} from '../semantic-promotion.js'

const HANDLE = { ringId: 'r', slot: 1 } as unknown as FrameHandle

function makeDeps(observeReturns: boolean): {
  deps: SemanticPromotionDeps
  observe: ReturnType<typeof vi.fn>
  record: ReturnType<typeof vi.fn>
  capture: ReturnType<typeof vi.fn>
  logs: { debugs: string[]; infos: string[] }
} {
  const observe = vi.fn(() => observeReturns)
  const record = vi.fn()
  const capture = vi.fn()
  const logs = { debugs: [] as string[], infos: [] as string[] }
  const logger = {
    debug: (m: string) => logs.debugs.push(m),
    info: (m: string) => logs.infos.push(m),
    warn: () => {},
    error: () => {},
    child: () => logger,
    withTags: () => logger,
  }
  const deps: SemanticPromotionDeps = {
    observeBestFrame: observe,
    recordBestSeenBbox: record,
    captureBestShot: capture,
    logger: logger as unknown as SemanticPromotionDeps['logger'],
  }
  return { deps, observe, record, capture, logs }
}

/** A well-framed subject: centred, edge-clear, square-contained. */
function frame(overrides: Partial<SemanticRecognitionFrame> = {}): SemanticRecognitionFrame {
  return {
    deviceId: 104,
    trackId: 't1',
    timestamp: 1_000,
    bbox: { x: 440, y: 130, w: 120, h: 240 },
    frameWidth: 1000,
    frameHeight: 500,
    kind: 'face',
    score: 0.51,
    confidence: 0.9,
    frameHandle: HANDLE,
    ...overrides,
  }
}

describe('promoteSemanticBestFrame', () => {
  it('offers the frame to the ranking WITH the semantic bit and the standard geometry terms', () => {
    const { deps, observe } = makeDeps(true)
    promoteSemanticBestFrame(deps, frame())
    expect(observe).toHaveBeenCalledTimes(1)
    const call = observe.mock.calls[0]![0] as Record<string, unknown>
    expect(call).toMatchObject({
      deviceId: 104,
      trackId: 't1',
      confidence: 0.9,
      timestamp: 1_000,
      semantic: true,
      edgeClear: true,
    })
    expect(typeof call['centerScore']).toBe('number')
    expect(typeof call['containment']).toBe('number')
    expect(typeof call['sizeScore']).toBe('number')
    expect(typeof call['squareFraction']).toBe('number')
  })

  it('new best + plausible box + live handle ⇒ best-seen recorded and captures re-fired', () => {
    const { deps, record, capture } = makeDeps(true)
    const out = promoteSemanticBestFrame(deps, frame())
    expect(out.promoted).toBe(true)
    expect(out.captured).toBe(true)
    expect(record).toHaveBeenCalledTimes(1)
    expect(capture).toHaveBeenCalledTimes(1)
    const captureInput = capture.mock.calls[0]![0] as Record<string, unknown>
    expect(captureInput).toMatchObject({
      deviceId: 104,
      trackId: 't1',
      timestamp: 1_000,
    })
  })

  it('NOT the new best (held peak already semantic-and-better, or square-evicted) ⇒ no capture, no best-seen', () => {
    const { deps, record, capture } = makeDeps(false)
    const out = promoteSemanticBestFrame(deps, frame())
    expect(out.promoted).toBe(false)
    expect(out.captured).toBe(false)
    expect(record).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })

  it('no frame handle (async attribution, pixels gone) ⇒ ranking promoted, capture honestly skipped AND logged', () => {
    const { deps, capture, logs } = makeDeps(true)
    const noHandle = frame()
    const { frameHandle: _dropped, ...rest } = noHandle
    const out = promoteSemanticBestFrame(deps, rest)
    expect(out.promoted).toBe(true)
    expect(out.captured).toBe(false)
    expect(capture).not.toHaveBeenCalled()
    // A branch that DROPS work (the capture) says so.
    expect(logs.debugs.concat(logs.infos).join('\n')).toMatch(/without capture/i)
  })

  it('an implausible (envelope-exploded) box never poisons best-seen nor captures', () => {
    const { deps, record, capture } = makeDeps(true)
    // Low-confidence near-full-frame box — the void-tile signature.
    const out = promoteSemanticBestFrame(
      deps,
      frame({ bbox: { x: 1, y: 1, w: 997, h: 497 }, confidence: 0.05 }),
    )
    expect(out.captured).toBe(false)
    expect(record).not.toHaveBeenCalled()
    expect(capture).not.toHaveBeenCalled()
  })
})

describe('semanticFrameForDetailAttribution — the subject-box contract (D276)', () => {
  const subject = { x: 100, y: 80, w: 200, h: 120 }
  const plateBox = { x: 180, y: 140, w: 40, h: 16 }
  const frame = {
    bbox: subject,
    timestamp: 5_000,
    frameWidth: 640,
    frameHeight: 360,
    confidence: 0.82,
  }

  it('a plate read promotes the SUBJECT box, never the plate detail box', () => {
    // The regression this pins: tracks c5c628f4 / 98fc38ce / bac368e2
    // (2026-08-28) stored a plate-only best `thumbnail` because the plate
    // DETAIL box was fed into the ranking, the best-seen record and the
    // re-fired crop. The composed frame must carry frame.bbox verbatim.
    const out = semanticFrameForDetailAttribution(
      102,
      'c5c628f4',
      { className: 'plate', score: 0.61, bbox: plateBox },
      frame,
    )
    expect(out.bbox).toEqual(subject)
    expect(out.kind).toBe('plate')
    expect(out.score).toBe(0.61)
    expect(out.confidence).toBe(0.82)
    expect(out.deviceId).toBe(102)
    expect(out.trackId).toBe('c5c628f4')
  })

  it('a fine classification promotes the subject box and maps to the classification kind', () => {
    const out = semanticFrameForDetailAttribution(
      102,
      't-cls',
      { className: 'car-model', score: 0.87, bbox: plateBox },
      frame,
    )
    expect(out.bbox).toEqual(subject)
    expect(out.kind).toBe('classification')
  })

  it('a detail result WITHOUT a detail box still promotes the subject box', () => {
    const out = semanticFrameForDetailAttribution(
      102,
      't-nobox',
      { className: 'plate', score: 0.5 },
      frame,
    )
    expect(out.bbox).toEqual(subject)
  })

  it('the frame handle rides along only when present', () => {
    const handle = makeTestFrameHandle({ shmId: 'ram:x:102', slot: 1, seq: 2, nodeId: 'n1' })
    const withHandle = semanticFrameForDetailAttribution(
      102,
      't-h',
      { className: 'plate', score: 0.5 },
      { ...frame, frameHandle: handle },
    )
    expect(withHandle.frameHandle).toEqual(handle)
    const without = semanticFrameForDetailAttribution(
      102,
      't-h2',
      { className: 'plate', score: 0.5 },
      frame,
    )
    expect('frameHandle' in without).toBe(false)
  })
})
