/**
 * Before/after comparison for the lazy-sharp fix (capacity spec §8).
 *
 * The capacity run doubles as the fix's validation because the open-loop
 * driver exercises the exact per-frame path the fix touches (raw-RGB
 * `runPipeline` → `getSharp()` JPEG encode per call). The verdict rule is
 * mechanical on purpose — someone else must be able to run the two ramps
 * and get the same answer:
 *
 *   - VALIDATED     — synchronous-block stalls are ZERO at every post-fix
 *                     step up to the pre-fix `N_max`, with pool-side
 *                     inference p95 FLAT.
 *   - INVALID       — inference p95 moved (or the tuples differ): something
 *                     other than the Node-side fix changed, so the
 *                     comparison proves nothing. Keep both files and
 *                     investigate before claiming anything.
 *   - NOT VALIDATED — comparable runs, but sync stalls persist (or `N_max`
 *                     regressed).
 *
 * An unchanged `N_max` is a VALID outcome (the knee may be pool-bound, not
 * stall-bound) — the reasons list says so instead of failing the verdict.
 */
import type { RunCapacityRampResult } from './capacity-schemas.js'

/**
 * "Flat" tolerance for pool-side inference p95, in percent. The fix is
 * Node-side; the pool must not notice it. 15% absorbs thermal/GC noise on a
 * warm pool while still catching a real engine change; steps whose pre-fix
 * p95 is under {@link INFER_P95_NOISE_FLOOR_MS} are skipped (relative deltas
 * on single-digit ms are dominated by timer resolution).
 */
export const INFER_P95_FLAT_TOLERANCE_PCT = 15
export const INFER_P95_NOISE_FLOOR_MS = 5

export type CapacityComparisonVerdict = 'validated' | 'not-validated' | 'invalid-comparison'

export interface InferP95Delta {
  readonly cameras: number
  readonly preP95: number
  readonly postP95: number
  readonly deltaPct: number
}

export interface CapacityComparison {
  readonly verdict: CapacityComparisonVerdict
  readonly reasons: readonly string[]
  readonly preNMax: number | null
  readonly postNMax: number | null
  readonly inferP95Deltas: readonly InferP95Delta[]
}

/**
 * Compare a pre-fix and a post-fix ramp of the SAME tuple. Pure — feed it
 * the two persisted result JSONs.
 */
export function compareCapacityRuns(
  pre: RunCapacityRampResult,
  post: RunCapacityRampResult,
): CapacityComparison {
  const reasons: string[] = []

  // Tuple identity: a comparison across engines/devices/rates answers a
  // different question, whatever the numbers say.
  if (pre.engineLabel !== post.engineLabel) {
    reasons.push(`engine differs: pre '${pre.engineLabel}' vs post '${post.engineLabel}'`)
  }
  if ((pre.deviceKey ?? null) !== (post.deviceKey ?? null)) {
    reasons.push(`deviceKey differs: pre '${pre.deviceKey}' vs post '${post.deviceKey}'`)
  }
  if (pre.fpsPerCamera !== post.fpsPerCamera) {
    reasons.push(`fpsPerCamera differs: pre ${pre.fpsPerCamera} vs post ${post.fpsPerCamera}`)
  }
  if (pre.frame.width !== post.frame.width || pre.frame.height !== post.frame.height) {
    reasons.push(
      `frame differs: pre ${pre.frame.width}×${pre.frame.height} vs post ${post.frame.width}×${post.frame.height}`,
    )
  }
  if (pre.contaminatedByActiveCameras || post.contaminatedByActiveCameras) {
    reasons.push('a run was contaminated by active cameras')
  }
  if (reasons.length > 0) {
    return {
      verdict: 'invalid-comparison',
      reasons,
      preNMax: pre.nMax,
      postNMax: post.nMax,
      inferP95Deltas: [],
    }
  }

  const preByCameras = new Map(pre.perStep.map((s) => [s.cameras, s]))
  const comparable = post.perStep.filter(
    (s) => preByCameras.has(s.cameras) && (pre.nMax === null || s.cameras <= pre.nMax),
  )
  if (comparable.length === 0) {
    return {
      verdict: 'invalid-comparison',
      reasons: ['no comparable steps (no shared camera counts up to the pre-fix N_max)'],
      preNMax: pre.nMax,
      postNMax: post.nMax,
      inferP95Deltas: [],
    }
  }

  // Validity gate: pool-side inference p95 must be FLAT. The fix is
  // Node-side — if the pool moved, something else changed and the
  // comparison is void (spec §8, row 5).
  const inferP95Deltas: InferP95Delta[] = comparable.map((postStep) => {
    const preStep = preByCameras.get(postStep.cameras)
    const preP95 = preStep?.inferMs.p95 ?? 0
    const postP95 = postStep.inferMs.p95
    const deltaPct = preP95 > 0 ? ((postP95 - preP95) / preP95) * 100 : 0
    return { cameras: postStep.cameras, preP95, postP95, deltaPct }
  })
  const moved = inferP95Deltas.filter(
    (d) =>
      d.preP95 >= INFER_P95_NOISE_FLOOR_MS && Math.abs(d.deltaPct) > INFER_P95_FLAT_TOLERANCE_PCT,
  )
  if (moved.length > 0) {
    return {
      verdict: 'invalid-comparison',
      reasons: moved.map(
        (d) =>
          `inference p95 moved at ${d.cameras} cameras: ${d.preP95.toFixed(1)}ms → ${d.postP95.toFixed(1)}ms (${d.deltaPct.toFixed(1)}%) — the fix is Node-side, the pool must not notice it`,
      ),
      preNMax: pre.nMax,
      postNMax: post.nMax,
      inferP95Deltas,
    }
  }

  // The metric the fix exists to move: synchronous-block stalls → 0 at
  // every step up to the pre-fix N_max.
  const stallSteps = comparable.filter((s) => s.stallSyncCount > 0)
  for (const s of stallSteps) {
    reasons.push(
      `synchronous-block stalls persist at ${s.cameras} cameras (${s.stallSyncCount}, max ${s.stallMaxMs}ms)`,
    )
  }

  // N_max must be non-decreasing. Unchanged is a valid outcome — say so.
  if (pre.nMax !== null && post.nMax !== null && post.nMax < pre.nMax) {
    reasons.push(`N_max regressed: ${pre.nMax} → ${post.nMax}`)
  }

  if (reasons.length > 0) {
    return {
      verdict: 'not-validated',
      reasons,
      preNMax: pre.nMax,
      postNMax: post.nMax,
      inferP95Deltas,
    }
  }

  const okReasons: string[] = ['synchronous-block stalls are zero up to the pre-fix N_max']
  if (pre.nMax !== null && post.nMax === pre.nMax) {
    okReasons.push('N_max unchanged — valid outcome (the knee may be pool-bound, not stall-bound)')
  } else if (pre.nMax !== null && post.nMax !== null && post.nMax > pre.nMax) {
    okReasons.push(`N_max improved: ${pre.nMax} → ${post.nMax}`)
  }
  return {
    verdict: 'validated',
    reasons: okReasons,
    preNMax: pre.nMax,
    postNMax: post.nMax,
    inferP95Deltas,
  }
}
