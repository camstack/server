/**
 * §8 before/after verdict for the lazy-sharp fix. The rule is mechanical:
 * VALIDATED iff synchronous-block stalls are zero at every post-fix step up
 * to the pre-fix N_max with pool-side inference p95 FLAT; a moved inference
 * p95 voids the comparison outright ("the fix is Node-side, the pool must
 * not notice it"); an unchanged N_max is explicitly a valid outcome.
 */
import { describe, expect, it } from 'vitest'
import type { CapacityRampStepResult, RunCapacityRampResult } from '../capacity-schemas.js'
import { compareCapacityRuns } from '../compare-runs.js'

function step(over: Partial<CapacityRampStepResult> & { cameras: number }): CapacityRampStepResult {
  return {
    offered: 1000,
    dispatched: 1000,
    completed: 1000,
    droppedByDriver: 0,
    shed: 0,
    errors: 0,
    unresolvedAtDrain: 0,
    dropRatio: 0,
    e2eMs: { p50: 50, p95: 90, p99: 120, max: 200 },
    inferMs: { avg: 30, p95: 40 },
    predictMs: { avg: 15, p95: 20 },
    detectionsAvg: 2,
    stallCount: 0,
    stallMaxMs: 0,
    stallGcMs: 0,
    stallSyncCount: 0,
    rssStartMb: 500,
    rssEndMb: 510,
    wallMs: 150_000,
    pass: true,
    failReasons: [],
    ...over,
  }
}

function run(
  over: Partial<RunCapacityRampResult> & { perStep: readonly CapacityRampStepResult[] },
): RunCapacityRampResult {
  return {
    nMax: over.perStep.filter((s) => s.pass).at(-1)?.cameras ?? null,
    failedStep: over.perStep.find((s) => !s.pass)?.cameras ?? null,
    engineLabel: 'python+openvino',
    shedSignal: 'first-class',
    frame: { width: 640, height: 640, payloadBytes: 640 * 640 * 3, format: 'rgb' },
    slo: { dropRatioMax: 0.01, e2eP95MsMax: 250, stallsMax: 0 },
    fpsPerCamera: 10,
    settleSec: 30,
    measureSec: 120,
    nodeId: 'hub',
    deviceKey: 'openvino:npu',
    contaminatedByActiveCameras: false,
    startedAt: '2026-08-02T20:00:00Z',
    wallMs: 1_000_000,
    aborted: false,
    ...over,
  }
}

describe('compareCapacityRuns', () => {
  it('VALIDATED: sync stalls → 0 up to the pre-fix N_max, inference p95 flat', () => {
    // A realistic pre run: passes at 4, fails at 8 on stalls.
    const pre = run({
      perStep: [
        step({ cameras: 4 }),
        step({ cameras: 8, stallSyncCount: 2, stallCount: 2, stallMaxMs: 30_000, pass: false }),
      ],
    })
    const post = run({
      perStep: [step({ cameras: 4 }), step({ cameras: 8 })],
    })
    const cmp = compareCapacityRuns(pre, post)
    expect(cmp.verdict).toBe('validated')
    expect(cmp.preNMax).toBe(4)
    expect(cmp.postNMax).toBe(8)
  })

  it('unchanged N_max is a VALID outcome and says so in the reasons', () => {
    const pre = run({ perStep: [step({ cameras: 4 })] })
    const post = run({ perStep: [step({ cameras: 4 })] })
    const cmp = compareCapacityRuns(pre, post)
    expect(cmp.verdict).toBe('validated')
    expect(cmp.reasons.some((r) => r.includes('unchanged'))).toBe(true)
  })

  it('INVALID: inference p95 moved beyond tolerance — the comparison proves nothing', () => {
    const pre = run({ perStep: [step({ cameras: 4, inferMs: { avg: 30, p95: 40 } })] })
    const post = run({ perStep: [step({ cameras: 4, inferMs: { avg: 55, p95: 70 } })] })
    const cmp = compareCapacityRuns(pre, post)
    expect(cmp.verdict).toBe('invalid-comparison')
    expect(cmp.reasons.some((r) => r.includes('inference p95 moved'))).toBe(true)
  })

  it('sub-noise-floor inference p95 deltas do NOT void the comparison', () => {
    // 2ms → 3ms is +50% but under the 5ms floor — timer noise, not a change.
    const pre = run({ perStep: [step({ cameras: 4, inferMs: { avg: 2, p95: 2 } })] })
    const post = run({ perStep: [step({ cameras: 4, inferMs: { avg: 3, p95: 3 } })] })
    expect(compareCapacityRuns(pre, post).verdict).toBe('validated')
  })

  it('INVALID: different tuple (engine/deviceKey/fps/frame) is a different question', () => {
    const pre = run({ perStep: [step({ cameras: 4 })] })
    const postEngine = run({ perStep: [step({ cameras: 4 })], engineLabel: 'python+coreml' })
    expect(compareCapacityRuns(pre, postEngine).verdict).toBe('invalid-comparison')
    const postDevice = run({ perStep: [step({ cameras: 4 })], deviceKey: 'openvino:gpu' })
    expect(compareCapacityRuns(pre, postDevice).verdict).toBe('invalid-comparison')
    const postFps = run({ perStep: [step({ cameras: 4 })], fpsPerCamera: 5 })
    expect(compareCapacityRuns(pre, postFps).verdict).toBe('invalid-comparison')
  })

  it('INVALID: a contaminated run voids the comparison', () => {
    const pre = run({ perStep: [step({ cameras: 4 })] })
    const post = run({ perStep: [step({ cameras: 4 })], contaminatedByActiveCameras: true })
    expect(compareCapacityRuns(pre, post).verdict).toBe('invalid-comparison')
  })

  it('NOT VALIDATED: synchronous-block stalls persist post-fix', () => {
    const pre = run({ perStep: [step({ cameras: 4 })] })
    const post = run({
      perStep: [step({ cameras: 4, stallSyncCount: 1, stallCount: 1, stallMaxMs: 15_000 })],
    })
    const cmp = compareCapacityRuns(pre, post)
    expect(cmp.verdict).toBe('not-validated')
    expect(cmp.reasons.some((r) => r.includes('persist'))).toBe(true)
  })

  it('NOT VALIDATED: N_max regressed', () => {
    const pre = run({ perStep: [step({ cameras: 4 }), step({ cameras: 8 })] })
    const post = run({
      perStep: [step({ cameras: 4 }), step({ cameras: 8, dropRatio: 0.05, pass: false })],
    })
    const cmp = compareCapacityRuns(pre, post)
    expect(cmp.verdict).toBe('not-validated')
    expect(cmp.reasons.some((r) => r.includes('regressed'))).toBe(true)
  })

  it('gc-only stalls post-fix do not block validation (the fix targets sync blocks)', () => {
    const pre = run({ perStep: [step({ cameras: 4 })] })
    const post = run({
      perStep: [step({ cameras: 4, stallCount: 1, stallGcMs: 2500, stallMaxMs: 2600 })],
    })
    // stallSyncCount is 0 — §8's verdict metric; the per-step SLO gate
    // already failed the step if stalls mattered for capacity.
    expect(compareCapacityRuns(pre, post).verdict).toBe('validated')
  })
})
