/**
 * The confirmation crop is a context window sixteen times the subject's area
 * (`confirmationCropWindow`). What the detector finds in it is about THIS
 * birth only where it is: a compatible box must overlap the candidate's own
 * rectangle (`CONFIRMATION_SUBJECT_MIN_IOU`), and a second subject must touch
 * the old tight crop (box + 15%) to be promoted.
 *
 * Geometry (frame pixels, a 640×480 analysis frame), as birth-gate derives it:
 *   subject       x 400, y 150, 30×90
 *   window (4×)   x 235, y 15, 360×360   — the crop the detector judged
 *   tight crop    x 395.5, y 136.5, 39×117
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type BirthCandidate,
  type ConfirmationDecision,
  type ConfirmationDetection,
  type ConfirmationGateDeps,
  confirmBirths,
  type GateRect,
} from '../confirmation-gate.js'
import {
  CONFIRMATION_GATE_DEFAULTS,
  type ConfirmationGateSettings,
} from '../confirmation-gate-settings.js'

const SUBJECT: GateRect = { x: 400, y: 150, w: 30, h: 90 }
const WINDOW: GateRect = { x: 235, y: 15, w: 360, h: 360 }
const TIGHT: GateRect = { x: 395.5, y: 136.5, w: 39, h: 117 }
const CROP = Buffer.from([0xff, 0xd8, 0xff])

const candidate: BirthCandidate = { trackId: 't1', className: 'person', bbox: SUBJECT }
const settings: ConfirmationGateSettings = {
  ...CONFIRMATION_GATE_DEFAULTS,
  enabled: true,
  minConfidence: 0.4,
}

/** A frame-pixel box, expressed in the window's crop-normalised space. */
function inWindow(r: GateRect): GateRect {
  return {
    x: (r.x - WINDOW.x) / WINDOW.w,
    y: (r.y - WINDOW.y) / WINDOW.h,
    w: r.w / WINDOW.w,
    h: r.h / WINDOW.h,
  }
}

/** The subject, as the native detector draws it: a few pixels off the tracker's box. */
const ON_SUBJECT = inWindow({ x: 402, y: 148, w: 28, h: 94 })
/** A second walker 100 px to the left — inside the window, nowhere near the subject. */
const NEIGHBOUR = inWindow({ x: 300, y: 150, w: 30, h: 90 })

function deps(
  detections: readonly ConfirmationDetection[],
  over: Partial<ConfirmationGateDeps> = {},
): ConfirmationGateDeps {
  return {
    fetchCrop: vi.fn(async () => CROP),
    redetect: vi.fn(async () => detections),
    cropRectFor: () => WINDOW,
    promotionScopeFor: () => TIGHT,
    ...over,
  }
}

async function decide(d: ConfirmationGateDeps): Promise<ConfirmationDecision> {
  const decisions: ConfirmationDecision[] = []
  await confirmBirths([candidate], settings, { ...d, onDecision: (x) => decisions.push(x) })
  const decision = decisions[0]
  if (decision === undefined) throw new Error('the gate decided nothing')
  return decision
}

describe('a compatible box confirms only when it IS the subject', () => {
  it('a confident neighbour outside the subject rectangle does not confirm the birth', async () => {
    const decision = await decide(deps([{ macroClass: 'person', score: 0.9, bbox: NEIGHBOUR }]))
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('no-detection')
    expect(decision.bestScore).toBeUndefined()
  })

  it('the subject confirms, and the neighbour does not lend it its score', async () => {
    const decision = await decide(
      deps([
        { macroClass: 'person', score: 0.95, bbox: NEIGHBOUR },
        { macroClass: 'person', score: 0.6, bbox: ON_SUBJECT },
      ]),
    )
    expect(decision.verdict).toBe('confirmed')
    expect(decision.bestScore).toBe(0.6)
  })

  it('a neighbour the detector floor REFUSED does not confirm from off the subject', async () => {
    // 1441: the second walker scored 0.56 — under the 0.65 person floor, over
    // the gate's 0.4 bar. Refused boxes are judged on the gate's bar (D925),
    // so where it is must decide, exactly as for a kept box.
    const decision = await decide(
      deps([{ macroClass: 'person', score: 0.56, bbox: NEIGHBOUR, refusedByDetectorFloor: true }]),
    )
    expect(decision.verdict).toBe('suppressed')
    expect(decision.bestScore).toBeUndefined()
  })

  it('on the context window a box with no place never confirms', async () => {
    const decision = await decide(deps([{ macroClass: 'person', score: 0.9 }]))
    expect(decision.verdict).toBe('suppressed')
  })

  it('the phantom-cell raised bar faces the subject, not the neighbour', async () => {
    const decision = await decide(
      deps(
        [
          { macroClass: 'person', score: 0.95, bbox: NEIGHBOUR },
          { macroClass: 'person', score: 0.7, bbox: ON_SUBJECT },
        ],
        { minConfidenceFor: () => 0.8 },
      ),
    )
    expect(decision.appliedMinConfidence).toBe(0.8)
    expect(decision.verdict).toBe('suppressed')
    expect(decision.bestScore).toBe(0.7)
  })
})

describe('a second subject is promoted only from the old tight crop', () => {
  it('a confident car far inside the window but outside the tight crop is not promoted', async () => {
    const decision = await decide(
      deps([
        { macroClass: 'person', score: 0.8, bbox: ON_SUBJECT },
        { macroClass: 'vehicle', score: 0.9, bbox: inWindow({ x: 250, y: 300, w: 80, h: 50 }) },
      ]),
    )
    expect(decision.verdict).toBe('confirmed')
    expect(decision.secondary).toBeUndefined()
    expect(decision.bestIncompatibleClass).toBeUndefined()
  })

  it('a car touching the tight crop is promoted, in frame pixels', async () => {
    const car: GateRect = { x: 425, y: 230, w: 80, h: 50 }
    const decision = await decide(
      deps([
        { macroClass: 'person', score: 0.8, bbox: ON_SUBJECT },
        { macroClass: 'vehicle', score: 0.9, bbox: inWindow(car) },
      ]),
    )
    expect(decision.secondary?.className).toBe('vehicle')
    expect(decision.secondary?.bbox.x).toBeCloseTo(car.x, 6)
    expect(decision.secondary?.bbox.y).toBeCloseTo(car.y, 6)
    expect(decision.secondary?.bbox.w).toBeCloseTo(car.w, 6)
    expect(decision.secondary?.bbox.h).toBeCloseTo(car.h, 6)
  })
})
