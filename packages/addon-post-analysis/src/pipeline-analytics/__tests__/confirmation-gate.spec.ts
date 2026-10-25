/**
 * Detection confirmation gate — pure orchestration tests.
 *
 * The gate re-runs object detection on a birth candidate's hi-res crop and
 * suppresses births whose crop does not confirm a class-compatible object. It
 * must be byte-identical to no gate when disabled, and FAIL OPEN (allow the
 * birth) on any missing crop / re-detection error / timeout — so a real track
 * is never dropped because confirmation was unavailable.
 */
import { describe, expect, it, vi } from 'vitest'
import {
  type BirthCandidate,
  type ConfirmationDecision,
  type ConfirmationDetection,
  type ConfirmationGateDeps,
  coarseGroupForClass,
  confirmBirths,
  isConfirmationCompatible,
} from '../confirmation-gate.js'
import {
  CONFIRMATION_GATE_DEFAULTS,
  type ConfirmationGateSettings,
  resolveConfirmationGateSettings,
} from '../confirmation-gate-settings.js'

const candidate = (trackId: string, className: string, size = 100): BirthCandidate => ({
  trackId,
  className,
  bbox: { x: 10, y: 10, w: size, h: size },
})

const enabled = (over: Partial<ConfirmationGateSettings> = {}): ConfirmationGateSettings => ({
  ...CONFIRMATION_GATE_DEFAULTS,
  enabled: true,
  ...over,
})

const CROP = Buffer.from([0xff, 0xd8, 0xff]) // token JPEG bytes

// A deps factory: fetchCrop always returns a crop, redetect returns the given
// detections (or null to simulate an error).
const deps = (
  detections: readonly ConfirmationDetection[] | null,
  over: Partial<ConfirmationGateDeps> = {},
): ConfirmationGateDeps => ({
  fetchCrop: vi.fn(async () => CROP),
  redetect: vi.fn(async () => detections),
  ...over,
})

describe('the secondary subject — what the crop confidently contains besides the candidate', () => {
  // The candidate's crop, in FRAME pixels: the gate is told where the crop
  // was cut from so a crop-normalised box can be put back in the frame.
  const cropRect = { x: 100, y: 200, w: 400, h: 400 }
  const withRect = (over: Partial<ConfirmationGateDeps> = {}): ConfirmationGateDeps =>
    deps(
      [
        { macroClass: 'person', score: 0.9, bbox: { x: 0.1, y: 0.1, w: 0.4, h: 0.8 } },
        { macroClass: 'animal', score: 0.8, bbox: { x: 0.5, y: 0.5, w: 0.25, h: 0.25 } },
      ],
      { cropRectFor: () => cropRect, ...over },
    )

  it('promotes an incompatible class above the bar into a secondary birth candidate, in frame space', async () => {
    const decisions: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.6 }),
      withRect({
        onDecision: (d) => decisions.push(d),
      }),
    )
    const decision = decisions[0]!
    expect(decision.verdict).toBe('confirmed')
    expect(decision.secondary).toEqual({
      className: 'animal',
      score: 0.8,
      bbox: { x: 300, y: 400, w: 100, h: 100 },
    })
  })

  it('does not promote an incompatible class below the bar', async () => {
    const decisions: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.85 }),
      withRect({ onDecision: (d) => decisions.push(d) }),
    )
    expect(decisions[0]?.bestIncompatibleClass).toBe('animal')
    expect(decisions[0]?.secondary).toBeUndefined()
  })

  it('does not promote without a box to put back in the frame, nor without the crop rectangle', async () => {
    const noBox: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.6 }),
      deps(
        [
          { macroClass: 'person', score: 0.9 },
          { macroClass: 'animal', score: 0.8 },
        ],
        { cropRectFor: () => cropRect, onDecision: (d) => noBox.push(d) },
      ),
    )
    expect(noBox[0]?.secondary).toBeUndefined()

    const noRect: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.6 }),
      withRect({ cropRectFor: () => null, onDecision: (d) => noRect.push(d) }),
    )
    expect(noRect[0]?.secondary).toBeUndefined()
  })

  it('a suppressed candidate can still yield a secondary — the crop had the wrong subject, not no subject', async () => {
    const decisions: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'vehicle')],
      enabled({ minConfidence: 0.6 }),
      deps([{ macroClass: 'animal', score: 0.9, bbox: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 } }], {
        cropRectFor: () => cropRect,
        onDecision: (d) => decisions.push(d),
      }),
    )
    expect(decisions[0]?.verdict).toBe('suppressed')
    expect(decisions[0]?.secondary).toEqual({
      className: 'animal',
      score: 0.9,
      bbox: { x: 200, y: 300, w: 200, h: 200 },
    })
  })
})

describe('coarseGroupForClass', () => {
  it('maps fine classes to coarse groups and unknowns to other', () => {
    expect(coarseGroupForClass('person')).toBe('person')
    expect(coarseGroupForClass('Pedestrian')).toBe('person')
    expect(coarseGroupForClass('car')).toBe('vehicle')
    expect(coarseGroupForClass('truck')).toBe('vehicle')
    expect(coarseGroupForClass('dog')).toBe('animal')
    expect(coarseGroupForClass('umbrella')).toBe('other')
  })
})

describe('isConfirmationCompatible', () => {
  it('matches within the same coarse group', () => {
    expect(isConfirmationCompatible('person', 'person')).toBe(true)
    expect(isConfirmationCompatible('car', 'vehicle')).toBe(true)
    expect(isConfirmationCompatible('truck', 'car')).toBe(true)
  })
  it('rejects across groups', () => {
    expect(isConfirmationCompatible('person', 'vehicle')).toBe(false)
    expect(isConfirmationCompatible('animal', 'person')).toBe(false)
  })
  it('fails open when either side is unknown', () => {
    expect(isConfirmationCompatible('person', 'fire')).toBe(true)
    expect(isConfirmationCompatible('sofa', 'person')).toBe(true)
  })
})

describe('confirmBirths — disabled (explicit opt-out)', () => {
  it('(a) confirms every candidate and NEVER touches the deps when disabled', async () => {
    const d = deps([{ macroClass: 'person', score: 0.99 }])
    const cands = [candidate('t1', 'person'), candidate('t2', 'vehicle')]
    const confirmed = await confirmBirths(
      cands,
      { ...CONFIRMATION_GATE_DEFAULTS, enabled: false },
      d,
    )
    expect(confirmed.confirmed).toEqual(new Set(['t1', 't2']))
    expect(d.fetchCrop).not.toHaveBeenCalled()
    expect(d.redetect).not.toHaveBeenCalled()
  })

  it('confirms all with an empty candidate list', async () => {
    const confirmed = await confirmBirths([], enabled(), deps(null))
    expect(confirmed.confirmed.size).toBe(0)
    expect(confirmed.undecided.size).toBe(0)
  })
})

describe('confirmBirths — enabled + crop CONFIRMS', () => {
  it('(b) lets the birth proceed when a compatible detection clears minConfidence', async () => {
    const d = deps([{ macroClass: 'person', score: 0.8 }])
    const confirmed = await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.4 }),
      d,
    )
    expect(confirmed.confirmed.has('t1')).toBe(true)
    expect(d.fetchCrop).toHaveBeenCalledTimes(1)
    expect(d.redetect).toHaveBeenCalledTimes(1)
  })

  it('confirms via coarse-group compatibility (truck box, car detection)', async () => {
    const confirmed = await confirmBirths(
      [candidate('t1', 'truck')],
      enabled({ minConfidence: 0.4 }),
      deps([{ macroClass: 'car', score: 0.7 }]),
    )
    expect(confirmed.confirmed.has('t1')).toBe(true)
  })
})

describe('confirmBirths — enabled + crop does NOT confirm', () => {
  it('(c) suppresses the birth when no detection is compatible + above threshold', async () => {
    // A person phantom whose crop only yields a low-score vehicle → suppressed.
    const confirmed = await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.4 }),
      deps([{ macroClass: 'vehicle', score: 0.9 }]),
    )
    expect(confirmed.confirmed.has('t1')).toBe(false)
    expect(confirmed.undecided.has('t1')).toBe(false) // suppressed = in neither
    expect(confirmed.confirmed.size).toBe(0)
  })

  it('suppresses when the compatible detection is below minConfidence', async () => {
    const confirmed = await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.5 }),
      deps([{ macroClass: 'person', score: 0.3 }]),
    )
    expect(confirmed.confirmed.has('t1')).toBe(false)
  })

  it('suppresses on an empty detection set (nothing in the crop)', async () => {
    const confirmed = await confirmBirths([candidate('t1', 'person')], enabled(), deps([]))
    expect(confirmed.confirmed.has('t1')).toBe(false)
  })

  it('suppresses only the unconfirmed candidate, keeping the confirmed one', async () => {
    let call = 0
    const d: ConfirmationGateDeps = {
      fetchCrop: vi.fn(async () => CROP),
      redetect: vi.fn(async () => {
        call += 1
        return call === 1 ? [{ macroClass: 'person', score: 0.9 }] : []
      }),
    }
    const confirmed = await confirmBirths(
      [candidate('t-real', 'person'), candidate('t-ghost', 'person')],
      enabled(),
      d,
    )
    expect(confirmed.confirmed.has('t-real')).toBe(true)
    expect(confirmed.confirmed.has('t-ghost')).toBe(false)
  })
})

/**
 * These were the "fail-open paths" until 2026-08-01, and they asserted that a
 * gate which could not look CONFIRMED the birth. That is the defect: on camera
 * 636 a brick wall entered the track feed as a `vehicle` with
 * `reason: "no-crop"`, and 45% of births over twelve hours were never measured
 * at all. Nothing here is a rename — each case now asserts the opposite
 * outcome, on purpose.
 */
describe('confirmBirths — paths where no measurement was possible', () => {
  it('(d) DEFERS the birth when the crop fetch misses (no handle / native miss)', async () => {
    const d = deps([{ macroClass: 'vehicle', score: 0.99 }], {
      fetchCrop: vi.fn(async () => null),
    })
    const confirmed = await confirmBirths([candidate('t1', 'person')], enabled(), d)
    expect(confirmed.confirmed.has('t1')).toBe(false)
    expect(confirmed.undecided.has('t1')).toBe(true)
    // redetect is never reached without a crop.
    expect(d.redetect).not.toHaveBeenCalled()
  })

  it('DEFERS the birth when re-detection is unavailable / errors (null)', async () => {
    const confirmed = await confirmBirths([candidate('t1', 'person')], enabled(), deps(null))
    expect(confirmed.undecided.has('t1')).toBe(true)
  })

  it('DEFERS the birth when re-detection THROWS', async () => {
    const d = deps(null, {
      redetect: vi.fn(async () => {
        throw new Error('inference exploded')
      }),
    })
    const confirmed = await confirmBirths([candidate('t1', 'person')], enabled(), d)
    expect(confirmed.undecided.has('t1')).toBe(true)
  })

  it('DEFERS the birth when confirmation TIMES OUT (never blocks the loop)', async () => {
    const d = deps(null, {
      redetect: vi.fn(
        () => new Promise<readonly ConfirmationDetection[]>(() => {}), // never resolves
      ),
    })
    const confirmed = await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ timeoutMs: 20 }),
      d,
    )
    expect(confirmed.undecided.has('t1')).toBe(true)
  })

  it('skips re-detection and DEFERS boxes below minCropPx — the box may grow', async () => {
    const d = deps([{ macroClass: 'vehicle', score: 0.99 }])
    const confirmed = await confirmBirths(
      [candidate('t1', 'person', 20)], // 20px < default 48
      enabled({ minCropPx: 48 }),
      d,
    )
    expect(confirmed.confirmed.has('t1')).toBe(false)
    expect(confirmed.undecided.has('t1')).toBe(true)
    expect(d.fetchCrop).not.toHaveBeenCalled()
    expect(d.redetect).not.toHaveBeenCalled()
  })

  it('reports each decision through onDecision', async () => {
    const decisions: string[] = []
    const d = deps([{ macroClass: 'vehicle', score: 0.9 }], {
      onDecision: (decision) => decisions.push(`${decision.trackId}:${decision.reason}`),
    })
    await confirmBirths([candidate('t1', 'person')], enabled(), d)
    expect(decisions).toEqual(['t1:incompatible-class'])
  })
})

describe('resolveConfirmationGateSettings', () => {
  it('defaults to ENABLED with a well-formed default blob (2026-07-20 rollout)', () => {
    expect(resolveConfirmationGateSettings({})).toEqual(CONFIRMATION_GATE_DEFAULTS)
    expect(CONFIRMATION_GATE_DEFAULTS.enabled).toBe(true)
  })

  it('reads flat confirmationGate* store keys', () => {
    const s = resolveConfirmationGateSettings({
      confirmationGateEnabled: true,
      confirmationGateMinConfidence: 0.55,
      confirmationGateMinCropPx: 64,
      confirmationGateTimeoutMs: 250,
      confirmationGateMaxDeferralMs: 1500,
      confirmationGateMaxAttempts: 6,
    })
    expect(s).toEqual({
      enabled: true,
      minConfidence: 0.55,
      minCropPx: 64,
      timeoutMs: 250,
      maxDeferralMs: 1500,
      maxAttempts: 6,
    })
  })

  it('an old store blob gets the deferral defaults, not zeros', () => {
    // A camera configured before 2026-08-01 has none of the three new keys. A
    // `maxAttempts` of 0 would make every birth exhaust immediately and go
    // straight to the fallback — the fix would be inert on exactly the
    // installed base it was written for.
    const s = resolveConfirmationGateSettings({
      confirmationGateMinCropPx: 64,
    })
    expect(s.maxDeferralMs).toBe(CONFIRMATION_GATE_DEFAULTS.maxDeferralMs)
    expect(s.maxAttempts).toBe(CONFIRMATION_GATE_DEFAULTS.maxAttempts)
    expect(s.maxAttempts).toBeGreaterThan(1)
  })

  it('falls back per-field on a bad value (never throws)', () => {
    const s = resolveConfirmationGateSettings({
      confirmationGateEnabled: true,
      confirmationGateMinConfidence: 'nope',
      confirmationGateMinCropPx: -5,
    })
    expect(s.enabled).toBe(true)
    expect(s.minConfidence).toBe(CONFIRMATION_GATE_DEFAULTS.minConfidence)
    expect(s.minCropPx).toBe(CONFIRMATION_GATE_DEFAULTS.minCropPx)
  })

  it('ignores a legacy nested confirmationGate blob (flat keys only)', () => {
    expect(
      resolveConfirmationGateSettings({
        confirmationGate: { enabled: false, minConfidence: 0.9 },
      }),
    ).toEqual(CONFIRMATION_GATE_DEFAULTS)
  })
})

/**
 * The gate's decision has to carry the EVIDENCE it decided on.
 *
 * Until 2026-07-30 it carried only `{trackId, reason}`, so a day of production
 * logs could not answer the one question needed to choose `minConfidence`:
 * what do crop re-detection scores actually look like, per class? The bar was
 * therefore unchoosable from data — the exact trap the detection-quality plan
 * exists to avoid. These pin the evidence onto the decision.
 */
describe('confirmation decision evidence', () => {
  it('carries the class and the best COMPATIBLE score when it confirms', async () => {
    const seen: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t1', 'person')],
      enabled({ minConfidence: 0.4 }),
      deps(
        [
          { macroClass: 'person', score: 0.82 },
          { macroClass: 'person', score: 0.55 },
        ],
        { onDecision: (d) => seen.push(d) },
      ),
    )
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({
      className: 'person',
      verdict: 'confirmed',
      bestScore: 0.82,
    })
  })

  it('carries the best compatible score even when it SUPPRESSES — the number the bar is chosen from', async () => {
    const seen: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t2', 'person')],
      enabled({ minConfidence: 0.4 }),
      deps([{ macroClass: 'person', score: 0.12 }], {
        onDecision: (d) => seen.push(d),
      }),
    )
    expect(seen[0]).toMatchObject({
      className: 'person',
      verdict: 'suppressed',
      bestScore: 0.12,
    })
  })

  it('distinguishes "nothing detected" from "detected as another class"', async () => {
    const seen: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t3', 'person'), candidate('t4', 'person')],
      enabled({ minConfidence: 0.4 }),
      // t3: an empty crop. t4: a confident VEHICLE where a person was claimed.
      {
        fetchCrop: async () => CROP,
        redetect: async (_crop: Buffer) => [],
        onDecision: (d) => seen.push(d),
      },
    )
    // Empty crop ⇒ no score at all, not a zero (a zero would pollute the
    // distribution the bar is read from).
    expect(seen[0]?.bestScore).toBeUndefined()

    const vehicleSeen: ConfirmationDecision[] = []
    await confirmBirths(
      [candidate('t5', 'person')],
      enabled({ minConfidence: 0.4 }),
      deps([{ macroClass: 'vehicle', score: 0.91 }], {
        onDecision: (d) => vehicleSeen.push(d),
      }),
    )
    // Incompatible: no COMPATIBLE score, but the crop was not empty — the
    // rejected class and its score are reported separately so a mass
    // misclassification is visible instead of looking like an empty crop.
    expect(vehicleSeen[0]).toMatchObject({
      verdict: 'suppressed',
      bestIncompatibleClass: 'vehicle',
      bestIncompatibleScore: 0.91,
    })
    expect(vehicleSeen[0]?.bestScore).toBeUndefined()
  })

  it('reports no score when undecided — there was no measurement to report', async () => {
    const seen: ConfirmationDecision[] = []
    await confirmBirths([candidate('t6', 'person')], enabled(), {
      fetchCrop: async () => null,
      redetect: async () => null,
      onDecision: (d) => seen.push(d),
    })
    expect(seen[0]).toMatchObject({
      verdict: 'undecided',
      reason: 'no-crop',
      className: 'person',
    })
    expect(seen[0]?.bestScore).toBeUndefined()
  })
})

/**
 * The property the three-valued verdict exists to guarantee: a birth the gate
 * could not measure lands in NEITHER decided set. A caller reading only
 * `confirmed` therefore cannot silently inherit the old fail-open — it has to
 * decide what to do with `undecided`.
 */
describe('undecided is not a synonym for either decision', () => {
  const unmeasurable: readonly ConfirmationGateDeps[] = [
    { fetchCrop: async () => null, redetect: async () => [] },
    { fetchCrop: async () => CROP, redetect: async () => null },
    {
      fetchCrop: async () => CROP,
      redetect: async () => {
        throw new Error('inference exploded')
      },
    },
  ]

  for (const [i, d] of unmeasurable.entries()) {
    it(`case ${i + 1}: in undecided, in neither confirmed nor suppressed`, async () => {
      const out = await confirmBirths([candidate('t1', 'person')], enabled(), d)
      expect(out.undecided.has('t1')).toBe(true)
      expect(out.confirmed.has('t1')).toBe(false)
    })
  }

  it('a DISABLED gate still confirms everything — opting out must cost nothing', async () => {
    const out = await confirmBirths(
      [candidate('t1', 'person'), candidate('t2', 'vehicle')],
      { ...CONFIRMATION_GATE_DEFAULTS, enabled: false },
      { fetchCrop: async () => null, redetect: async () => null },
    )
    expect(out.confirmed).toEqual(new Set(['t1', 't2']))
    expect(out.undecided.size).toBe(0)
  })
})

/**
 * The sub-native fallback is reachable ONLY on an exhausted deferral (D38).
 *
 * The standing rule is that model-input crops take the native-strict path; the
 * gate's exception is scoped to the moment there is nothing left to wait for.
 * If it leaked into the ordinary path, every birth would be decided on a ≤640
 * crop and the deferral would never get the native one it is waiting for.
 */
describe('the sub-native fallback is scoped to exhaustion', () => {
  const fallbackDeps = (): ConfirmationGateDeps & {
    fetchFallbackCrop: ReturnType<typeof vi.fn>
  } => ({
    fetchCrop: vi.fn(async () => null),
    redetect: vi.fn(async () => [{ macroClass: 'person', score: 0.9 }]),
    fetchFallbackCrop: vi.fn(async () => CROP),
  })

  it('is NOT called for a candidate that is merely undecided', async () => {
    const d = fallbackDeps()
    const out = await confirmBirths([candidate('t1', 'person')], enabled(), d)
    expect(d.fetchFallbackCrop).not.toHaveBeenCalled()
    expect(out.undecided.has('t1')).toBe(true)
  })

  it('IS called once the caller marks the candidate exhausted, and can confirm on it', async () => {
    const d = fallbackDeps()
    const out = await confirmBirths([candidate('t1', 'person')], enabled(), d, new Set(['t1']))
    expect(d.fetchFallbackCrop).toHaveBeenCalledTimes(1)
    expect(out.confirmed.has('t1')).toBe(true)
    expect(out.undecided.has('t1')).toBe(false)
  })

  it('may NOT suppress on the fallback crop — it is a different instant (D379)', async () => {
    // This assertion was the opposite until 2026-09-07 ("it is a measurement,
    // not an amnesty"). It is a measurement — of a LATER frame. A subject that
    // moved is not in it, and its absence there is not evidence it was never
    // here. The full argument, and the counter-proof that a native crop of the
    // SAME instant still suppresses, live in
    // `confirmation-gate-carried-evidence.spec.ts`.
    const out = await confirmBirths(
      [candidate('t1', 'person')],
      enabled(),
      { ...fallbackDeps(), redetect: vi.fn(async () => []) },
      new Set(['t1']),
    )
    expect(out.confirmed.has('t1')).toBe(true)
    expect(out.undecided.has('t1')).toBe(false)
  })

  it('an exhausted candidate with NO fallback at all falls open — the last resort', async () => {
    const out = await confirmBirths(
      [candidate('t1', 'person')],
      enabled(),
      { fetchCrop: async () => null, redetect: async () => [] },
      new Set(['t1']),
    )
    // It cannot stay undecided: nothing would ever resolve it and the caller
    // would hold it forever.
    expect(out.confirmed.has('t1')).toBe(true)
    expect(out.undecided.size).toBe(0)
  })

  it('exhausting one candidate does not exhaust its neighbours', async () => {
    const d = fallbackDeps()
    const out = await confirmBirths(
      [candidate('t1', 'person'), candidate('t2', 'person')],
      enabled(),
      d,
      new Set(['t1']),
    )
    expect(out.confirmed.has('t1')).toBe(true)
    expect(out.undecided.has('t2')).toBe(true)
    expect(d.fetchFallbackCrop).toHaveBeenCalledTimes(1)
  })
})

/**
 * The seam the phantom-cell memory rides on. The gate owns the comparison; the
 * caller supplies WHERE the candidate is and gets a bar back.
 */
describe('confirmBirths — per-candidate spawn bar', () => {
  const config = enabled({ minConfidence: 0.4 })

  /** Run the gate and return its decisions, captured through `onDecision`. */
  async function decide(
    candidates: readonly BirthCandidate[],
    detections: readonly ConfirmationDetection[] | null,
    over: Partial<ConfirmationGateDeps> = {},
  ): Promise<readonly ConfirmationDecision[]> {
    const decisions: ConfirmationDecision[] = []
    await confirmBirths(candidates, config, {
      ...deps(detections, over),
      onDecision: (d) => decisions.push(d),
    })
    return decisions
  }

  it('a score that clears the ordinary bar is SUPPRESSED under a raised one', async () => {
    const found: ConfirmationDetection[] = [{ macroClass: 'person', score: 0.55 }]
    // CONTROL: without the hook, 0.55 >= 0.4 confirms.
    const ordinary = await decide([candidate('t1', 'person')], found)
    expect(ordinary[0]?.verdict).toBe('confirmed')
    expect(ordinary[0]?.appliedMinConfidence).toBeCloseTo(0.4, 9)

    const raised = await decide([candidate('t1', 'person')], found, {
      minConfidenceFor: () => 0.8,
    })
    expect(raised[0]?.verdict).toBe('suppressed')
    expect(raised[0]?.appliedMinConfidence).toBeCloseTo(0.8, 9)
  })

  it('a genuinely strong re-detection still gets through a raised bar', async () => {
    const strong: ConfirmationDetection[] = [{ macroClass: 'person', score: 0.93 }]
    const out = await decide([candidate('t1', 'person')], strong, {
      minConfidenceFor: () => 0.9,
    })
    expect(out[0]?.verdict).toBe('confirmed')
  })

  it('the hook can never LOWER the configured bar', async () => {
    const weak: ConfirmationDetection[] = [{ macroClass: 'person', score: 0.2 }]
    const out = await decide([candidate('t1', 'person')], weak, {
      minConfidenceFor: () => 0.05,
    })
    expect(out[0]?.verdict).toBe('suppressed')
    expect(out[0]?.appliedMinConfidence).toBeCloseTo(0.4, 9)
  })

  it('is asked PER CANDIDATE, with the candidate — one cell armed, its neighbour not', async () => {
    const found: ConfirmationDetection[] = [{ macroClass: 'person', score: 0.55 }]
    const seen = new Set<string>()
    const out = await decide(
      [candidate('inCell', 'person'), candidate('elsewhere', 'person')],
      found,
      {
        minConfidenceFor: (c) => {
          seen.add(c.trackId)
          return c.trackId === 'inCell' ? 0.8 : 0.4
        },
      },
    )
    expect([...seen].sort()).toEqual(['elsewhere', 'inCell'])
    expect(out.find((d) => d.trackId === 'inCell')?.verdict).toBe('suppressed')
    expect(out.find((d) => d.trackId === 'elsewhere')?.verdict).toBe('confirmed')
  })
})

describe('a birth the native second pass already measured (D377)', () => {
  const recovered = (score: number): BirthCandidate => ({
    trackId: 'dog',
    className: 'animal',
    bbox: { x: 10, y: 10, w: 100, h: 100 },
    nativeRecovery: { score, cropSidePx: 720, viewPx: 640 },
  })

  it('confirms on the measurement that saw it, without cutting a third crop', async () => {
    // The crop path is wired and would suppress: this is the 06:59:38 case on
    // camera 101, where re-cropping the recovered dog found nothing at all.
    const d = deps([])
    const out = await confirmBirths([recovered(0.87)], enabled({ minConfidence: 0.4 }), d)
    expect(out.confirmed.has('dog')).toBe(true)
    expect(out.undecided.size).toBe(0)
    expect(d.fetchCrop).not.toHaveBeenCalled()
    expect(d.redetect).not.toHaveBeenCalled()
  })

  it('reports the verdict as native-pass, carrying the score it was taken on', async () => {
    const seen: ConfirmationDecision[] = []
    const d = deps([], { onDecision: (dec) => seen.push(dec) })
    await confirmBirths([recovered(0.87)], enabled({ minConfidence: 0.4 }), d)
    expect(seen[0]?.reason).toBe('native-pass')
    expect(seen[0]?.verdict).toBe('confirmed')
    expect(seen[0]?.bestScore).toBe(0.87)
    expect(seen[0]?.appliedMinConfidence).toBe(0.4)
  })

  it('does NOT exempt a native measurement that is BELOW the bar - it re-measures', async () => {
    // An exemption is not a bypass: a native pass that scored 0.2 has not
    // confirmed anything, and the ordinary crop path decides.
    const d = deps([{ macroClass: 'animal', score: 0.9 }])
    const out = await confirmBirths([recovered(0.2)], enabled({ minConfidence: 0.4 }), d)
    expect(out.confirmed.has('dog')).toBe(true)
    expect(d.redetect).toHaveBeenCalled()
  })

  it('respects a RAISED per-candidate bar - a phantom cell still gets the crop', async () => {
    const d = deps([])
    const out = await confirmBirths([recovered(0.5)], enabled({ minConfidence: 0.4 }), {
      ...d,
      minConfidenceFor: () => 0.8,
    })
    expect(out.confirmed.has('dog')).toBe(false)
    expect(d.redetect).toHaveBeenCalled()
  })
})
