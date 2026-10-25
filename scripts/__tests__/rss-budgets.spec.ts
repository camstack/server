/**
 * rss-budgets — the declared budgets, checked against the alarm they are for.
 *
 * ## What this guards, and why a manifest assertion alone would not
 *
 * `execution.rssBudgetMb` is a number in a `package.json`. Nothing about writing
 * one down proves the watchdog can ever act on it: on 2026-08-27
 * `hub/pipeline-analytics` was OOM-killed at 11.4GB with a `--max-old-space-size`
 * ceiling in force the whole time, because the only threshold that existed was
 * built on `stranded = rss − heapUsed − external`, which is algebraically
 * constant when the growth is all `external`. A number that no line reads is
 * exactly the failure that cost the host 11.4GB and ~154s of container stall.
 *
 * So each declared budget is driven THROUGH `startHeapWatch` here — the real
 * one, not a reimplementation of its rule — at one MB over and one MB under.
 * Over must produce `OVER RSS BUDGET` naming that budget; under must produce
 * silence. A budget that cannot make a line appear is not a budget.
 *
 * ## Why this file is repo-level rather than per-package
 *
 * A runner is not a package. `resolveRunnerId` is `execution.group ?? addonId`,
 * so `detection` is three addons in `addon-pipeline` and `ml` is three addons
 * spread over `addon-ai`, `addon-benchmark` and `addon-model-studio`. The
 * question "is this RUNNER watched" cannot be asked from inside any one package,
 * and asking it per-package is how a group ends up half-declared.
 *
 * The co-located MAX rule itself is NOT re-implemented here. It is proved in
 * `packages/system/src/kernel/__tests__/moleculer/addon-runner.spec.ts`, which
 * drives `$process.spawnRunner` and reads the env var the child actually gets —
 * with fixtures for the MAX (no shipped group has two members declaring
 * different numbers, so the real manifests cannot distinguish max from min) and
 * with the real `ml` packages for the part they can prove: a group whose other
 * members are silent is still watched. The reduction below serves only to ANSWER
 * "what is this runner's budget"; the rule it must agree with lives there.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import * as path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  startHeapWatch,
  ZERO_LOOP_DELAY,
  type LoopDelayMeter,
} from '../../packages/system/src/kernel/heap-watch.js'

const ROOT = path.resolve(import.meta.dirname, '..', '..')
const MB = 1048576

interface ManifestExecution {
  readonly group?: string
  readonly rssBudgetMb?: number
}

interface ManifestAddonEntry {
  readonly id?: string
  readonly execution?: ManifestExecution
}

interface PackageManifest {
  readonly camstack?: { readonly addons?: readonly ManifestAddonEntry[] }
}

/**
 * A runner as production sees it: an id, and the highest budget any addon
 * mapped onto it declares. The id rule is `resolveRunnerId` — `group ?? addonId`.
 */
interface DeclaredRunner {
  readonly runnerId: string
  readonly budgetMb: number
  readonly declaredBy: string
}

/**
 * The `[mem]` measurements each budget is answerable to.
 *
 * Taken on the live hub on 2026-08-27 with two cameras open in live view, so
 * these are an ACTIVE load rather than a resting one. `shape` records what the
 * shares said the process was doing when the sample landed, because that — not
 * taste — is what sets how much headroom the budget needs:
 *
 *  - `working`  — the sample carries real `external` or native residue, i.e. it
 *                 caught the process doing its job. Little headroom needed.
 *  - `idle`     — mostly V8 heap with single-digit `external`, i.e. it caught
 *                 the process between jobs. The budget must then be sized from
 *                 the ROLE, and the multiplier over the sample is meaningless.
 */
interface Measurement {
  readonly runnerId: string
  readonly rssMb: number
  readonly heapUsedMb: number
  readonly externalMb: number
  readonly shape: 'working' | 'idle'
}

const MEASURED: readonly Measurement[] = [
  {
    runnerId: 'pipeline-analytics',
    rssMb: 1218,
    heapUsedMb: 183,
    externalMb: 36,
    shape: 'working',
  },
  { runnerId: 'sqlite-settings', rssMb: 656, heapUsedMb: 115, externalMb: 13, shape: 'working' },
  { runnerId: 'detection', rssMb: 553, heapUsedMb: 121, externalMb: 14, shape: 'working' },
  { runnerId: 'provider-reolink', rssMb: 472, heapUsedMb: 155, externalMb: 34, shape: 'working' },
  { runnerId: 'snapshot', rssMb: 360, heapUsedMb: 112, externalMb: 19, shape: 'working' },
  { runnerId: 'ml', rssMb: 267, heapUsedMb: 193, externalMb: 6, shape: 'idle' },
  { runnerId: 'decoder-nodeav', rssMb: 244, heapUsedMb: 96, externalMb: 6, shape: 'idle' },
  { runnerId: 'audio-analyzer', rssMb: 176, heapUsedMb: 105, externalMb: 13, shape: 'working' },
]

/**
 * `pipeline-orchestrator` was measured in the same pass at 385MB and is NOT in
 * `MEASURED`: its package was owned by another change in flight when these seven
 * landed, so declaring it here would have raced. It is the one remaining
 * measured-but-unwatched runner and 1024MB is the number its sample supports.
 */
const MEASURED_BUT_NOT_YET_DECLARED = 'pipeline-orchestrator'

function readManifests(): readonly DeclaredRunner[] {
  const byRunner = new Map<string, DeclaredRunner>()
  const groups = ['packages', 'server'] as const
  for (const group of groups) {
    const dir = path.join(ROOT, group)
    if (!existsSync(dir)) continue
    for (const pkg of readdirSync(dir)) {
      const file = path.join(dir, pkg, 'package.json')
      if (!existsSync(file)) continue
      const manifest: PackageManifest = JSON.parse(readFileSync(file, 'utf8')) as PackageManifest
      for (const addon of manifest.camstack?.addons ?? []) {
        const budgetMb = addon.execution?.rssBudgetMb
        const id = addon.id
        if (budgetMb === undefined || id === undefined) continue
        const runnerId = addon.execution?.group ?? id
        const existing = byRunner.get(runnerId)
        if (existing === undefined || budgetMb > existing.budgetMb) {
          byRunner.set(runnerId, { runnerId, budgetMb, declaredBy: id })
        }
      }
    }
  }
  return [...byRunner.values()]
}

const DECLARED = readManifests()

function budgetFor(runnerId: string): number | undefined {
  return DECLARED.find((r) => r.runnerId === runnerId)?.budgetMb
}

/**
 * The budget, or a failure that names the runner. Every assertion below is
 * about what a DECLARED number does, so an undeclared one has to stop the test
 * with the runner's name rather than read as a passing comparison.
 */
function requireBudget(runnerId: string): number {
  const budget = budgetFor(runnerId)
  if (budget === undefined) {
    throw new Error(`${runnerId} declares no execution.rssBudgetMb`)
  }
  return budget
}

/** A `MemoryUsage` at a chosen RSS, with the shares of a real over-budget event. */
function memAtRss(rssMb: number): NodeJS.MemoryUsage {
  const heapUsed = Math.min(200, Math.floor(rssMb / 4)) * MB
  const external = Math.floor(rssMb / 2) * MB
  return {
    rss: rssMb * MB,
    heapTotal: heapUsed,
    heapUsed,
    external,
    arrayBuffers: Math.floor(external / 2),
  }
}

const METER: LoopDelayMeter = { read: () => ZERO_LOOP_DELAY, stop: () => undefined }

/** Every `OVER RSS BUDGET` line a watch emits at exactly this RSS. */
function budgetLinesAt(label: string, budgetMb: number, rssMb: number): readonly string[] {
  const warn = vi.fn()
  const stop = startHeapWatch(
    label,
    { info: vi.fn(), warn },
    60_000,
    {
      reclaim: () => undefined,
      readMemory: () => memAtRss(rssMb),
      heapLimitBytes: 4096 * MB,
    },
    METER,
    [],
    false,
    { budgetMb, source: 'manifest execution.rssBudgetMb' },
  )
  try {
    return warn.mock.calls.map((c) => String(c[0])).filter((l) => /OVER RSS BUDGET/.test(l))
  } finally {
    stop()
  }
}

describe('every measured runner is watched', () => {
  it.each(
    MEASURED.map((m) => [m.runnerId, m] as const),
  )('%s declares an RSS budget', (runnerId, m) => {
    const budget = budgetFor(runnerId)
    expect(
      budget,
      `${runnerId} was measured at ${m.rssMb}MB and declares no execution.rssBudgetMb — ` +
        `it will announce itself NOT WATCHED at boot`,
    ).toBeDefined()
  })

  it('the budget always sits ABOVE the measurement it answers to', () => {
    // A budget at or under the observed load is not a watchdog, it is a
    // permanent alarm — and a permanent alarm gets muted, which is how 83,198
    // Hikvision heartbeat lines buried two real ones on the same day.
    for (const m of MEASURED) {
      const budget = requireBudget(m.runnerId)
      expect(budget, `${m.runnerId} budget ${budget} <= measured ${m.rssMb}`).toBeGreaterThan(
        m.rssMb,
      )
    }
  })

  /**
   * A `working` sample caught the process doing its job, so its budget is
   * answerable to it. An `idle` sample did not, and a ratio computed against it
   * would be a number about nothing — `ml` at 267MB is 72% V8 heap with 6MB of
   * `external`, i.e. no model was loaded when it was taken.
   */
  it('a budget sized off a WORKING sample stays within 3x of it', () => {
    for (const m of MEASURED.filter((x) => x.shape === 'working')) {
      const budget = requireBudget(m.runnerId)
      expect(
        budget / m.rssMb,
        `${m.runnerId}: ${budget}MB is ${(budget / m.rssMb).toFixed(1)}x a working sample of ${m.rssMb}MB — ` +
          `too loose to ever fire before the host does`,
      ).toBeLessThanOrEqual(3)
    }
  })

  it('names the one measured runner still unwatched, so it cannot be forgotten quietly', () => {
    // This assertion is meant to FAIL the day someone declares it — that is the
    // reminder to delete it, not a reason to widen it.
    expect(budgetFor(MEASURED_BUT_NOT_YET_DECLARED)).toBeUndefined()
  })
})

describe('a declared budget makes the alarm fire', () => {
  it.each(
    MEASURED.map((m) => [m.runnerId] as const),
  )('%s: one MB over the declared budget produces the line', (runnerId) => {
    const budget = requireBudget(runnerId)
    const lines = budgetLinesAt(`hub/${runnerId}`, budget, budget + 1)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain(`budget=${budget}MB`)
    expect(lines[0]).toContain(`rss=${budget + 1}MB`)
    // The budget that is wrong has to be traceable to whoever wrote it.
    expect(lines[0]).toContain('manifest execution.rssBudgetMb')
  })

  it.each(
    MEASURED.map((m) => [m.runnerId] as const),
  )('%s: one MB under the declared budget stays silent', (runnerId) => {
    const budget = requireBudget(runnerId)
    expect(budgetLinesAt(`hub/${runnerId}`, budget, budget - 1)).toEqual([])
  })

  it('the alarm would have fired on the sample that killed the host', () => {
    // `hub/pipeline-analytics`, 2026-08-27, on its way to 11.4GB: rss 5735MB
    // against the 2048MB it declares. The whole mechanism exists for this line.
    const budget = requireBudget('pipeline-analytics')
    const lines = budgetLinesAt('hub/pipeline-analytics', budget, 5735)
    expect(lines).toHaveLength(1)
    expect(lines[0]).toContain('budget=2048MB')
  })
})
