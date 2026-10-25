/**
 * A suppression names WHY, and carries the score it was taken on (D922).
 *
 * Prod 2026-10-23, camera 1439: a person birth was suppressed on a NATIVE crop
 * with `bestScore: null` — and so was every suppression on that camera for
 * three hours. The gate was not deciding without evidence: the crop was cut and
 * re-detected. But the re-detector applies the detector's OWN per-class floor
 * (person 0.65) before the gate sees a box, so a compatible subject scored
 * 0.55 arrived as "nothing", the gate's 0.4 bar never got to decide, and the
 * record could not tell "an empty wall" from "a person the detector half saw".
 *
 * These pin the vocabulary and the score. Since D925 the GATE'S bar decides a
 * floor-refused box too — the detector's per-class floor is the live tracker's
 * bar, not the gate's — and a birth with no measurement is never suppressed (it
 * defers, then is admitted).
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type BirthCandidate,
  type ConfirmationDecision,
  type ConfirmationDetection,
  type ConfirmationGateDeps,
  confirmBirths,
} from '../confirmation-gate.js'
import {
  CONFIRMATION_GATE_DEFAULTS,
  type ConfirmationGateSettings,
} from '../confirmation-gate-settings.js'

const CROP = Buffer.from([0xff, 0xd8, 0xff])

const candidate = (trackId: string, className: string): BirthCandidate => ({
  trackId,
  className,
  bbox: { x: 10, y: 10, w: 200, h: 200 },
})

const settings: ConfirmationGateSettings = {
  ...CONFIRMATION_GATE_DEFAULTS,
  enabled: true,
  minConfidence: 0.4,
}

async function decide(
  detections: readonly ConfirmationDetection[] | null,
  over: Partial<ConfirmationGateDeps> = {},
  exhausted: ReadonlySet<string> = new Set(),
): Promise<{ decision: ConfirmationDecision; confirmed: boolean; undecided: boolean }> {
  const decisions: ConfirmationDecision[] = []
  const outcome = await confirmBirths(
    [candidate('t1', 'person')],
    settings,
    {
      fetchCrop: vi.fn(async () => CROP),
      redetect: vi.fn(async () => detections),
      onDecision: (d) => decisions.push(d),
      ...over,
    },
    exhausted,
  )
  return {
    decision: decisions[0]!,
    confirmed: outcome.confirmed.has('t1'),
    undecided: outcome.undecided.has('t1'),
  }
}

describe('a suppression names its reason and carries its score', () => {
  it('a compatible box the detector floor refused, under the gate bar too, is `below-detector-floor` with its score', async () => {
    const { decision, confirmed } = await decide([
      { macroClass: 'person', score: 0.35, refusedByDetectorFloor: true },
    ])
    expect(confirmed).toBe(false)
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('below-detector-floor')
    expect(decision.bestScore).toBe(0.35)
    expect(decision.cropSource).toBe('native')
  })

  it('a kept compatible box under the (raised) bar is `scored-below-threshold`, with its score', async () => {
    const { decision } = await decide([{ macroClass: 'person', score: 0.7 }], {
      minConfidenceFor: () => 0.8,
    })
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('scored-below-threshold')
    expect(decision.bestScore).toBe(0.7)
    expect(decision.appliedMinConfidence).toBe(0.8)
  })

  it('a crop that confidently holds another class is `incompatible-class`', async () => {
    const { decision } = await decide([{ macroClass: 'vehicle', score: 0.9 }])
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('incompatible-class')
    expect(decision.bestIncompatibleClass).toBe('vehicle')
  })

  it('a crop the detector found nothing in is `no-detection` — measured, and empty', async () => {
    const { decision } = await decide([])
    expect(decision.verdict).toBe('suppressed')
    expect(decision.reason).toBe('no-detection')
    expect(decision.bestScore).toBeUndefined()
    expect(decision.cropSource).toBe('native')
  })

  it('a floor-refused box never promotes a secondary subject', async () => {
    const { decision } = await decide(
      [
        { macroClass: 'person', score: 0.3 },
        {
          macroClass: 'animal',
          score: 0.45,
          refusedByDetectorFloor: true,
          bbox: { x: 0, y: 0, w: 0.5, h: 0.5 },
        },
      ],
      { cropRectFor: () => ({ x: 0, y: 0, w: 100, h: 100 }) },
    )
    expect(decision.secondary).toBeUndefined()
  })
})

describe('no measurement is never a suppression', () => {
  it('a crop that never arrived defers the birth', async () => {
    const { decision, confirmed, undecided } = await decide([], {
      fetchCrop: vi.fn(async () => null),
    })
    expect(decision.verdict).toBe('undecided')
    expect(decision.reason).toBe('no-crop')
    expect(confirmed).toBe(false)
    expect(undecided).toBe(true)
  })

  it('an exhausted birth with no crop is admitted, not suppressed', async () => {
    const { confirmed, undecided } = await decide(
      [],
      { fetchCrop: vi.fn(async () => null) },
      new Set(['t1']),
    )
    expect(confirmed).toBe(true)
    expect(undecided).toBe(false)
  })

  it('a re-detector that failed defers the birth', async () => {
    const { decision, undecided } = await decide(null)
    expect(decision.verdict).toBe('undecided')
    expect(decision.reason).toBe('redetect-error')
    expect(undecided).toBe(true)
  })
})
