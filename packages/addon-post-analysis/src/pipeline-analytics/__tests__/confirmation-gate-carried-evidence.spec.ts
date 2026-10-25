/**
 * D379 — the gate looks at the pixels the birth ARRIVED WITH, and a ripple
 * from another instant may confirm but never suppress.
 *
 * Both halves are measured, not argued:
 *  - the after-the-fact fetch missed 7 452 times in three hours on the live hub
 *    (99.9% `worker-lease-gone`, misses at `handleAgeMs=254`), and 1 191 of
 *    1 883 gate verdicts (63%) never saw a pixel — 1 048 `timeout`, 143
 *    `no-crop`;
 *  - `fetchFallbackCrop` looks at a LATER frame. A subject that moved is not
 *    there, and its absence is not evidence it was never here.
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

const CARRIED = Buffer.from([0xff, 0xd8, 0x01])
const NATIVE = Buffer.from([0xff, 0xd8, 0x02])
const FALLBACK = Buffer.from([0xff, 0xd8, 0x03])

const enabled = (over: Partial<ConfirmationGateSettings> = {}): ConfirmationGateSettings => ({
  ...CONFIRMATION_GATE_DEFAULTS,
  enabled: true,
  ...over,
})

const candidate = (over: Partial<BirthCandidate> = {}): BirthCandidate => ({
  trackId: 't1',
  className: 'person',
  bbox: { x: 10, y: 10, w: 100, h: 200 },
  ...over,
})

const decisions = (): {
  readonly seen: ConfirmationDecision[]
  readonly onDecision: (d: ConfirmationDecision) => void
} => {
  const seen: ConfirmationDecision[] = []
  return { seen, onDecision: (d) => seen.push(d) }
}

describe('the crop the birth arrived with', () => {
  it('confirms on the carried crop WITHOUT fetching anything', async () => {
    const fetchCrop = vi.fn(async () => NATIVE)
    const redetect = vi.fn(
      async (): Promise<readonly ConfirmationDetection[]> => [{ macroClass: 'person', score: 0.9 }],
    )
    const sink = decisions()
    const deps: ConfirmationGateDeps = { fetchCrop, redetect, onDecision: sink.onDecision }
    const out = await confirmBirths([candidate({ evidenceCrop: CARRIED })], enabled(), deps)
    expect(out.confirmed.has('t1')).toBe(true)
    expect(fetchCrop).not.toHaveBeenCalled()
    expect(redetect).toHaveBeenCalledWith(CARRIED)
    expect(sink.seen[0]?.cropSource).toBe('carried')
  })

  it('NEVER suppresses on the carried crop — a negative escalates to the native path', async () => {
    // Measured on the live hub in the 20 minutes after the first version of
    // this shipped: the carried crop suppressed 133 of 192 births (69%) while
    // the NATIVE crop of the same gate suppressed 5 of 56 (9%). It is cut from
    // the ≤640 analysis raster, and a small subject there is D377's "third,
    // different, worse image". So a negative decides nothing, and the native
    // crop — which DOES suppress — gets its turn.
    const fetchCrop = vi.fn(async () => NATIVE)
    const redetect = vi.fn(async (c: Buffer) =>
      c === CARRIED ? [] : [{ macroClass: 'person', score: 0.9 }],
    )
    const sink = decisions()
    const out = await confirmBirths([candidate({ evidenceCrop: CARRIED })], enabled(), {
      fetchCrop,
      redetect,
      onDecision: sink.onDecision,
    })
    expect(fetchCrop).toHaveBeenCalledTimes(1)
    expect(out.confirmed.has('t1')).toBe(true)
    expect(sink.seen[0]?.verdict).toBe('confirmed')
    expect(sink.seen[0]?.cropSource).toBe('native')
  })

  it('is INCONCLUSIVE, not suppressed, when the carried crop is empty and no native one comes', async () => {
    const sink = decisions()
    const out = await confirmBirths([candidate({ evidenceCrop: CARRIED })], enabled(), {
      fetchCrop: vi.fn(async () => null),
      redetect: vi.fn(async () => []),
      onDecision: sink.onDecision,
    })
    expect(sink.seen[0]?.verdict).toBe('undecided')
    expect(out.undecided.has('t1')).toBe(true)
  })

  it('the NATIVE crop still suppresses — the change is monotone, nothing stops being caught', async () => {
    // Counter-proof for the confirm-only rule: it must not disarm the gate.
    const sink = decisions()
    const out = await confirmBirths([candidate({ evidenceCrop: CARRIED })], enabled(), {
      fetchCrop: vi.fn(async () => NATIVE),
      redetect: vi.fn(async () => []),
      onDecision: sink.onDecision,
    })
    expect(sink.seen[0]?.verdict).toBe('suppressed')
    expect(sink.seen[0]?.cropSource).toBe('native')
    expect(out.confirmed.has('t1')).toBe(false)
  })

  it('does not spend a second inference when the re-detector itself is unavailable', async () => {
    const redetect = vi.fn(async () => null)
    await confirmBirths([candidate({ evidenceCrop: CARRIED })], enabled(), {
      fetchCrop: vi.fn(async () => NATIVE),
      redetect,
    })
    expect(redetect).toHaveBeenCalledTimes(1)
  })

  it('still falls through to the native fetch when no crop was carried', async () => {
    const fetchCrop = vi.fn(async () => NATIVE)
    const sink = decisions()
    await confirmBirths([candidate()], enabled(), {
      fetchCrop,
      redetect: vi.fn(async () => [{ macroClass: 'person', score: 0.9 }]),
      onDecision: sink.onDecision,
    })
    expect(fetchCrop).toHaveBeenCalledTimes(1)
    expect(sink.seen[0]?.cropSource).toBe('native')
  })

  it('is answered AFTER the native-pass exemption — a measured birth still costs nothing', async () => {
    const redetect = vi.fn(async () => [{ macroClass: 'animal', score: 0.9 }])
    const out = await confirmBirths(
      [
        candidate({
          className: 'animal',
          evidenceCrop: CARRIED,
          nativeRecovery: { score: 0.83, cropSidePx: 640, viewPx: 320 },
        }),
      ],
      enabled(),
      { fetchCrop: vi.fn(async () => NATIVE), redetect },
    )
    expect(out.confirmed.has('t1')).toBe(true)
    expect(redetect).not.toHaveBeenCalled()
  })

  it('honours `minCropPx`: a box too small to re-detect is skipped even carrying pixels', async () => {
    const redetect = vi.fn(async () => [])
    const out = await confirmBirths(
      [candidate({ bbox: { x: 0, y: 0, w: 10, h: 10 }, evidenceCrop: CARRIED })],
      enabled({ minCropPx: 48 }),
      { fetchCrop: vi.fn(async () => NATIVE), redetect },
    )
    expect(redetect).not.toHaveBeenCalled()
    expect(out.undecided.has('t1')).toBe(true)
  })
})

describe('a ripple from another instant may confirm, never suppress', () => {
  const exhausted = new Set(['t1'])

  it('CONFIRMS on the fallback crop when the subject is still there', async () => {
    const sink = decisions()
    const out = await confirmBirths(
      [candidate()],
      enabled(),
      {
        fetchCrop: vi.fn(async () => null),
        fetchFallbackCrop: vi.fn(async () => FALLBACK),
        redetect: vi.fn(async () => [{ macroClass: 'person', score: 0.9 }]),
        onDecision: sink.onDecision,
      },
      exhausted,
    )
    expect(out.confirmed.has('t1')).toBe(true)
    expect(sink.seen[0]?.verdict).toBe('confirmed')
    expect(sink.seen[0]?.cropSource).toBe('fallback')
  })

  it('does NOT suppress when the fallback crop is empty — the subject moved', async () => {
    // This is the whole point. The fallback looks at a LATER frame; "not there
    // now" is not "was never there". Before D379 this returned `suppressed`
    // and killed the track — and with it the object event, the notification
    // and the events-reel entry, which must coincide.
    const sink = decisions()
    const out = await confirmBirths(
      [candidate()],
      enabled(),
      {
        fetchCrop: vi.fn(async () => null),
        fetchFallbackCrop: vi.fn(async () => FALLBACK),
        redetect: vi.fn(async () => []),
        onDecision: sink.onDecision,
      },
      exhausted,
    )
    expect(sink.seen[0]?.verdict).toBe('undecided')
    expect(sink.seen[0]?.reason).toBe('fallback-inconclusive')
    // Exhausted, so the caller's own rule lets the birth through rather than
    // holding an id nothing will ever resolve.
    expect(out.confirmed.has('t1')).toBe(true)
  })

  it('does not suppress on a fallback that found only an INCOMPATIBLE subject either', async () => {
    const sink = decisions()
    await confirmBirths(
      [candidate({ className: 'animal' })],
      enabled(),
      {
        fetchCrop: vi.fn(async () => null),
        fetchFallbackCrop: vi.fn(async () => FALLBACK),
        redetect: vi.fn(async () => [{ macroClass: 'person', score: 0.95 }]),
        onDecision: sink.onDecision,
      },
      exhausted,
    )
    expect(sink.seen[0]?.verdict).toBe('undecided')
    expect(sink.seen[0]?.reason).toBe('fallback-inconclusive')
  })

  it('COUNTER-PROOF: a NATIVE crop of the same instant still suppresses', async () => {
    // Remove the asymmetry and this must go back to `suppressed` — otherwise
    // the change would have disarmed the gate rather than corrected it.
    const sink = decisions()
    const out = await confirmBirths(
      [candidate()],
      enabled(),
      {
        fetchCrop: vi.fn(async () => NATIVE),
        fetchFallbackCrop: vi.fn(async () => FALLBACK),
        redetect: vi.fn(async () => []),
        onDecision: sink.onDecision,
      },
      exhausted,
    )
    expect(sink.seen[0]?.verdict).toBe('suppressed')
    expect(out.confirmed.has('t1')).toBe(false)
  })
})
