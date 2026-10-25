import type { IScopedLogger, SceneMonitor } from '@camstack/types'
import { SCENE_DIVERGED } from '@camstack/types'
import sharp from 'sharp'
import { describe, expect, it, vi } from 'vitest'
import type { SceneDeviceMonitor, SceneEngineDeps, SceneEngineResult } from '../scene-engine.js'
import { mergeSilentLogger } from '../../__tests__/test-helpers.js'
import { SceneEngine } from '../scene-engine.js'

const MODEL = 'clip-vit-b32'

function logger(): IScopedLogger {
  return mergeSilentLogger({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  })
}

async function jpegBase64(): Promise<string> {
  // A real 16x16 RGB JPEG so the sharp decode/extract path exercises for real.
  const buf = await sharp({
    create: { width: 16, height: 16, channels: 3, background: { r: 10, g: 20, b: 30 } },
  })
    .jpeg()
    .toBuffer()
  return buf.toString('base64')
}

function monitor(overrides: Partial<SceneMonitor> = {}): SceneMonitor {
  return {
    id: 'm1',
    label: 'gate',
    roi: { kind: 'rect', x: 0.1, y: 0.1, width: 0.5, height: 0.5 },
    enabled: true,
    triggerMode: 'periodic',
    check: { mode: 'similarity', threshold: 0.5, hysteresisCount: 1 },
    states: [
      {
        id: 'closed',
        label: 'closed',
        references: [{ embedding: [1, 0, 0], modelId: MODEL, condition: 'day', capturedAt: 1 }],
        referenceCount: 1,
        currentlyMatched: false,
      },
    ],
    currentStateId: null,
    lastCheckedAt: null,
    lastConfidence: null,
    currentCondition: null,
    availability: 'ok',
    unavailableReason: null,
    baselineStateId: 'closed',
    emit: 'latched',
    verdict: 'unknown',
    latched: false,
    armedAt: 0,
    divergedAt: null,
    restoredAt: null,
    // 0 in the fixture: the quiet gate and the spacing gate are exercised by
    // their own tests, and would otherwise silently discard every observation
    // in every OTHER test here.
    quietSeconds: 0,
    minObservationSpacingSec: 0,
    anchorThreshold: 0.85,
    autoRestore: false,
    // The shipping default: a light with no reference of its own is SAT OUT,
    // not reported as a fault. Spelled in the fixture rather than inherited so
    // the `judge-anyway` tests read as the deviation they are.
    onUncoveredCondition: 'skip',
    suspendedCondition: null,
    unavailable: null,
    coveredConditions: ['day'],
    ...overrides,
  }
}

function makeDeps(
  mon: SceneMonitor,
  base64: string,
  applyEngineResult: (d: number, m: string, r: SceneEngineResult) => Promise<void>,
): SceneEngineDeps {
  const scenes: SceneDeviceMonitor[] = [{ deviceId: 104, monitor: mon }]
  return {
    encoder: {
      // Live crop embeds identically to the 'day' reference → cosine 1.
      encode: vi.fn().mockResolvedValue({ embedding: [1, 0, 0], inferenceMs: 1 }),
      getInfo: vi.fn().mockResolvedValue({ modelId: MODEL, embeddingDim: 3, ready: true }),
    },
    getSnapshot: vi.fn().mockResolvedValue({ base64, contentType: 'image/jpeg' }),
    listAllScenes: vi.fn().mockResolvedValue(scenes),
    applyEngineResult: vi.fn(applyEngineResult),
    resolveConditionContext: vi.fn().mockResolvedValue({ forcedMode: 'day' }),
    logger: logger(),
  }
}

/**
 * Drive the resolver's answer between checks, so one engine instance can be
 * walked across a dusk and back — the sequence the whole optional-night
 * behaviour is about, and the one a per-test frozen condition cannot express.
 */
interface SwitchableLight {
  readonly deps: SceneEngineDeps
  setCondition(condition: 'day' | 'night'): void
}

function withSwitchableLight(deps: SceneEngineDeps): SwitchableLight {
  const current = { forcedMode: 'day' as 'day' | 'night' }
  ;(deps.resolveConditionContext as ReturnType<typeof vi.fn>).mockImplementation(async () => ({
    forcedMode: current.forcedMode,
  }))
  return {
    deps,
    setCondition: (condition) => {
      current.forcedMode = condition
    },
  }
}

describe('SceneEngine.checkOnce (similarity)', () => {
  it('flips to the matching state and pushes a transition result', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor()
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(deps.getSnapshot).toHaveBeenCalledWith(104, false)
    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      currentStateId: 'closed',
      previousStateId: null,
      availability: 'ok',
      currentCondition: 'day',
      transitioned: true,
    })
    expect(results[0]!.lastConfidence).toBeCloseTo(1, 5)
  })

  // THE defect this whole feature was blocked on. `checkOnce` used to `return`
  // bare when nothing scored above threshold, so "the region no longer looks
  // like anything I captured" — the operator's entire question — was
  // indistinguishable from "the snapshot failed". A scene could enter a state
  // and never leave it, silently.
  //
  // NEUTRALIZATION: restore the bare `if (bestStateId === null || bestScore <
  // threshold) return` at the top of the similarity branch and this test goes
  // red. It is the only test that catches it.
  it('below threshold produces the synthetic divergence candidate and a real transition', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    // Orthogonal live embedding → cosine 0 < 0.99 threshold. Compared, and it
    // did NOT match — which is the fact the operator asked to be told about.
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      currentStateId: SCENE_DIVERGED,
      previousStateId: 'closed',
      verdict: 'diverged',
      availability: 'ok',
      transitioned: true,
    })
  })

  it('leaving a state costs the same N agreeing observations as entering one', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 3 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon)
    expect(results).toHaveLength(0) // two agreeing divergence reads are not enough
    await engine.checkOnce(104, mon)
    expect(results).toHaveLength(1)
    expect(results[0]!.currentStateId).toBe(SCENE_DIVERGED)
  })

  // "Nothing to compare against" is not the same fact as "compared and it did
  // not match". An encoder model change must never read as a theft.
  it('reports unknown, NOT diverged, when no reference is comparable', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.5, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    // The encoder moved to a different model — every stored reference is gated out.
    ;(deps.encoder.getInfo as ReturnType<typeof vi.fn>).mockResolvedValue({
      modelId: 'siglip2-b16',
      embeddingDim: 3,
      ready: true,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      unavailable: 'encoder-model-changed',
      transitioned: false,
    })
    expect(results[0]!.currentStateId).toBe('closed') // the held state is NOT destroyed
  })

  // A scene that has NEVER been captured is not "night is optional", it is "you
  // did not finish setting this up". Silence there would hide the one thing the
  // operator still has to do, so the uncovered-light skip must NOT swallow it.
  it('reports unknown when the scene has no comparable reference in ANY light', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.5, hysteresisCount: 1 },
      states: [],
      currentStateId: null,
      baselineStateId: null,
      coveredConditions: [],
      verdict: 'unknown',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.resolveConditionContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      forcedMode: 'night',
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      unavailable: 'no-reference-for-condition',
      suspendedCondition: null,
      transitioned: false,
    })
  })
})

/**
 * The night half of a scene is OPTIONAL.
 *
 * Before this, a scene captured only in daylight reported `unknown` /
 * `no-reference-for-condition` every night, logged a WARN per transition, and
 * showed the operator a "can't tell" badge from dusk to dawn — for a
 * configuration that is not wrong. Almost nobody stands outside at 22:00 to
 * capture the IR reference, and a great many scenes are daytime questions that
 * never need one.
 *
 * `onUncoveredCondition: 'skip'` (the default) makes the uncovered light a
 * NON-EVENT: no verdict moves, no latch moves, no hysteresis credit is spent or
 * cleared, and the only trace is one advisory `suspendedCondition` the card
 * renders in the same calm voice as the coverage line.
 */
describe('SceneEngine — an uncovered light is optional, not a fault', () => {
  it('skips the check in an uncovered light, moving no verdict and no state', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.5, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    // Only a 'day' reference exists; the resolver says we are in the dark.
    ;(deps.resolveConditionContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      forcedMode: 'night',
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      suspendedCondition: 'night',
      currentCondition: 'night',
      // The live state is exactly what the last COVERED light left it at.
      verdict: 'matched',
      currentStateId: 'closed',
      unavailable: null,
      availability: 'ok',
      transitioned: false,
    })
    // Never a warning: this is a configuration choice, not a failure.
    expect(deps.logger.warn).not.toHaveBeenCalled()
    expect(deps.logger.info).toHaveBeenCalledWith(
      expect.stringContaining('paused'),
      expect.objectContaining({ tags: { deviceId: 104 } }),
    )
  })

  // NEUTRALIZATION: delete the `rt.suspendedCondition === input.condition`
  // early return in `reportSuspended` and this goes red — a line per tick at
  // 60 s is 480 lines a night, per scene, which is how a log stops being read.
  it('says so ONCE per transition, not once per tick', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({ currentStateId: 'closed', verdict: 'matched' })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.resolveConditionContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      forcedMode: 'night',
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
  })

  it('resumes by itself when a covered light returns, and says that once too', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({ currentStateId: 'closed', baselineStateId: 'closed', verdict: 'matched' })
    const ctx = withSwitchableLight(
      makeDeps(mon, base64, async (_d, _m, r) => {
        results.push(r)
      }),
    )
    const engine = new SceneEngine(ctx.deps)

    ctx.setCondition('night')
    await engine.checkOnce(104, mon)
    expect(results).toHaveLength(1)
    expect(results[0]!.suspendedCondition).toBe('night')

    ctx.setCondition('day')
    await engine.checkOnce(104, mon)
    expect(results).toHaveLength(2)
    expect(results[1]).toMatchObject({
      suspendedCondition: null,
      currentCondition: 'day',
      verdict: 'matched',
    })

    await engine.checkOnce(104, mon)
    expect(results).toHaveLength(2) // steady state is silent again
  })

  // The whole point of "the latch is not touched": a pending divergence run
  // that survives the dark is a run the operator's three agreeing observations
  // actually earned. Spending or clearing it on a check that was never made
  // would make a scene undetectable across any night.
  it('neither spends nor clears hysteresis credit while the light is uncovered', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 3 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
    })
    const ctx = withSwitchableLight(
      makeDeps(mon, base64, async (_d, _m, r) => {
        results.push(r)
      }),
    )
    ;(ctx.deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0], // cosine 0 → diverged
      inferenceMs: 1,
    })
    const engine = new SceneEngine(ctx.deps)

    ctx.setCondition('day')
    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon) // 2 of 3 agreeing divergence observations

    ctx.setCondition('night')
    await engine.checkOnce(104, mon) // skipped — must cost nothing
    ctx.setCondition('day')

    await engine.checkOnce(104, mon) // the THIRD real observation flips it
    const flip = results.find((r) => r.transitioned)
    expect(flip).toBeDefined()
    expect(flip).toMatchObject({ currentStateId: SCENE_DIVERGED, verdict: 'diverged' })
  })

  // The opt-in, for the installs where it is actually true.
  it('judge-anyway scores against the other light’s references instead of skipping', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.5, hysteresisCount: 1 },
      onUncoveredCondition: 'judge-anyway',
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.resolveConditionContext as ReturnType<typeof vi.fn>).mockResolvedValue({
      forcedMode: 'night',
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      suspendedCondition: null,
      currentCondition: 'night',
      verdict: 'matched',
      currentStateId: 'closed',
    })
  })
})

describe('SceneEngine.checkOnce (similarity, continued)', () => {
  // A car pulling up in front of the bin must not be able to spend hysteresis
  // credit. Motion during the observation window DISCARDS the check — it does
  // not merely delay it — and the discard is logged per-camera.
  it('discards an observation taken while the device was not quiet', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
      quietSeconds: 60,
    })
    const deps: SceneEngineDeps = {
      ...makeDeps(mon, base64, async (_d, _m, r) => {
        results.push(r)
      }),
      isMotionActive: () => true,
    }
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(0)
    // Not even the snapshot was taken — a discarded observation costs nothing.
    expect(deps.getSnapshot).not.toHaveBeenCalled()
  })

  // Three agreeing polls at 60 s span three minutes — long enough for a person
  // to walk past, short enough for a van to sit in the ROI for the whole run.
  it('an observation too close to the previously counted one does not advance the pending run', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 2 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
      minObservationSpacingSec: 3_600,
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    // Ten back-to-back divergence reads inside one occlusion window still
    // amount to ONE counted observation.
    for (let i = 0; i < 10; i++) await engine.checkOnce(104, mon)

    expect(results).toHaveLength(0)
  })

  // A bumped camera, a PTZ preset or a re-aim makes the same normalized rect
  // frame a different piece of world. The scene would diverge and stay diverged
  // forever, with a perfectly plausible cosine.
  it('refuses a flip when the whole-frame anchor says the view moved', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
      states: [
        {
          id: 'closed',
          label: 'closed',
          references: [
            {
              embedding: [1, 0, 0],
              modelId: MODEL,
              condition: 'day',
              capturedAt: 1,
              anchorEmbedding: [1, 0, 0],
            },
          ],
          referenceCount: 1,
          currentlyMatched: true,
        },
      ],
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    // Both the ROI crop AND the whole frame now embed orthogonally to what was
    // captured: the region diverged because the CAMERA moved.
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({
      verdict: 'unknown',
      unavailable: 'view-shifted',
      transitioned: false,
    })
    expect(results[0]!.currentStateId).toBe('closed') // NOT a theft
  })

  it('allows the flip when the view still matches the anchor', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({
      check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 1 },
      currentStateId: 'closed',
      baselineStateId: 'closed',
      verdict: 'matched',
      states: [
        {
          id: 'closed',
          label: 'closed',
          references: [
            {
              embedding: [1, 0, 0],
              modelId: MODEL,
              condition: 'day',
              capturedAt: 1,
              anchorEmbedding: [0, 1, 0], // == what the live encoder returns
            },
          ],
          referenceCount: 1,
          currentlyMatched: true,
        },
      ],
    })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
      embedding: [0, 1, 0],
      inferenceMs: 1,
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)

    expect(results[0]).toMatchObject({ verdict: 'diverged', transitioned: true })
  })

  // The whole economics of the feature: ~2 vision calls a WEEK against 1 440 a
  // day for an LLM poll. If the gate is ever consulted on a poll, this is the
  // test that says so.
  describe('vision adjudication', () => {
    function confirming(decision: 'confirmed' | 'held'): {
      judge: ReturnType<typeof vi.fn>
    } {
      return {
        judge: vi.fn(async () => ({
          decision,
          reason: 'because',
          latencyMs: 10,
          at: 1,
        })),
      }
    }

    function confirmed(monitorOverrides: Partial<SceneMonitor> = {}): SceneMonitor {
      return monitor({
        check: { mode: 'similarity', threshold: 0.99, hysteresisCount: 2 },
        currentStateId: 'closed',
        baselineStateId: 'closed',
        verdict: 'matched',
        confirm: {
          enabled: true,
          prompt: 'Is the wheelie bin still there?',
          timeoutMs: 8_000,
          maxImagePx: 448,
          onTimeout: 'hold',
        },
        ...monitorOverrides,
      })
    }

    it('is NOT consulted while hysteresis is merely pending', async () => {
      const base64 = await jpegBase64()
      const mon = confirmed()
      const gate = confirming('confirmed')
      const deps: SceneEngineDeps = {
        ...makeDeps(mon, base64, async () => undefined),
        confirmGate: gate as unknown as SceneEngineDeps['confirmGate'],
      }
      ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
        embedding: [0, 1, 0],
        inferenceMs: 1,
      })
      const engine = new SceneEngine(deps)

      await engine.checkOnce(104, mon) // pending 1 of 2 — no flip, no call
      expect(gate.judge).not.toHaveBeenCalled()

      await engine.checkOnce(104, mon) // the flip — exactly one call
      expect(gate.judge).toHaveBeenCalledTimes(1)
      expect(gate.judge.mock.calls[0]![0]).toMatchObject({ direction: 'diverged' })
    })

    it('a HELD verdict does not commit the flip, and drops the pending run', async () => {
      const results: SceneEngineResult[] = []
      const base64 = await jpegBase64()
      const mon = confirmed()
      const gate = confirming('held')
      const deps: SceneEngineDeps = {
        ...makeDeps(mon, base64, async (_d, _m, r) => {
          results.push(r)
        }),
        confirmGate: gate as unknown as SceneEngineDeps['confirmGate'],
      }
      ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
        embedding: [0, 1, 0],
        inferenceMs: 1,
      })
      const engine = new SceneEngine(deps)

      await engine.checkOnce(104, mon)
      await engine.checkOnce(104, mon)
      expect(results).toHaveLength(0)

      // The pending run was dropped, so the scene must earn its N observations
      // again — it does not flip on the very next check the moment the model
      // comes back.
      await engine.checkOnce(104, mon)
      expect(results).toHaveLength(0)
      expect(gate.judge).toHaveBeenCalledTimes(1)
    })

    it('CLIP alone decides when no gate is wired', async () => {
      const results: SceneEngineResult[] = []
      const base64 = await jpegBase64()
      const mon = confirmed()
      const deps = makeDeps(mon, base64, async (_d, _m, r) => {
        results.push(r)
      })
      ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockResolvedValue({
        embedding: [0, 1, 0],
        inferenceMs: 1,
      })
      const engine = new SceneEngine(deps)
      await engine.checkOnce(104, mon)
      await engine.checkOnce(104, mon)
      expect(results).toHaveLength(1)
    })
  })

  it('reports unavailable once for an llm-mode scene (seam)', async () => {
    const results: SceneEngineResult[] = []
    const base64 = await jpegBase64()
    const mon = monitor({ check: { mode: 'llm', prompt: 'gate closed?', hysteresisCount: 1 } })
    const deps = makeDeps(mon, base64, async (_d, _m, r) => {
      results.push(r)
    })
    const engine = new SceneEngine(deps)

    await engine.checkOnce(104, mon)
    await engine.checkOnce(104, mon) // second check: no duplicate emit

    expect(results).toHaveLength(1)
    expect(results[0]).toMatchObject({ availability: 'unavailable' })
    expect(deps.getSnapshot).not.toHaveBeenCalled()
  })
})

describe('SceneEngine — a dead encoder must never kill the runner', () => {
  it('checkOnce survives an encoder rejection: warn, skip, NO throw', async () => {
    const base64 = await jpegBase64()
    const mon = monitor()
    const deps = makeDeps(mon, base64, async () => undefined)
    ;(deps.encoder.encode as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('ModelDownloadService: model "mobileclip-s1" has no onnx format'),
    )
    const warns: string[] = []
    deps.logger.warn = ((m: string) => {
      warns.push(m)
    }) as typeof deps.logger.warn
    const engine = new SceneEngine(deps)

    await expect(engine.checkOnce(104, mon)).resolves.toBeUndefined()

    expect(warns.some((w) => w.includes('encode'))).toBe(true)
  })
})
