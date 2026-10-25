/**
 * Inference-timeout regression guard — "did this update make the GPU time
 * out more than the last one did?", asked by the node itself.
 *
 * ## Why
 *
 * `@camstack/server` 1.2.218 reintroduced the inference timeouts 1.2.216 had
 * fixed: ~3 760 `inference request timed out` an hour for 4 h 19 min (16 215
 * lines, ~19 000 `runInference failed`), on a cluster whose previous hour had
 * seen ~5. Nothing said so. 1.2.219 fixed it again as a side effect of the
 * next deploy, and the regression was found a day later by an audit that
 * counted log lines per version by hand (2026-09-05). A green typecheck, a
 * green suite and a 200 on `/health` all held throughout.
 *
 * ## What it does
 *
 * Every five minutes the guard records how many inference requests timed out
 * on this node under the current FINGERPRINT (the closure version). The last
 * hour of buckets is persisted in the addon store, so a restart hands the
 * previous fingerprint's rate to the next one. Once the new fingerprint has a
 * quarter hour of its own, the two hourly rates are compared:
 *
 *  - ≥ `TIMEOUT_GUARD_RATIO`× worse AND above `TIMEOUT_GUARD_FLOOR_PER_HOUR`
 *    → `system.liveness-failed` (AlertCenter raises a persistent alert keyed
 *    on the finding id) and an ERROR line naming both versions and rates;
 *  - ≥ `TIMEOUT_GUARD_RATIO`× better → an INFO line, no alert;
 *  - the same fingerprint (a plain restart) → nothing to compare.
 *
 * The rate is per hour, not per frame: it is the unit the audit measured and
 * the unit an operator reads. A traffic doubling doubles the rate, which is
 * why the ratio is five and not two.
 *
 * Pure core (`recordTimeoutBucket`, `evaluateTimeoutRegression`) tested in
 * `__tests__/inference-timeout-guard.spec.ts`; the runtime wrapper owns the
 * timer, the store and the emit.
 */
import { dirname, join } from 'node:path'
import type { IScopedLogger } from '@camstack/types'

export const TIMEOUT_GUARD_BUCKET_MS = 5 * 60_000
/** One hour of buckets is what the previous fingerprint hands over. */
export const TIMEOUT_GUARD_WINDOW_BUCKETS = 12
/** A quarter hour before the new fingerprint is judged. */
export const TIMEOUT_GUARD_MIN_BUCKETS = 3
export const TIMEOUT_GUARD_RATIO = 5
/** Below this many an hour a change is noise, whatever the ratio says. */
export const TIMEOUT_GUARD_FLOOR_PER_HOUR = 20
/** Addon-store key the ledger persists under (the addon's own settings blob). */
export const INFERENCE_TIMEOUT_LEDGER_KEY = '_inferenceTimeoutLedger'

const HOUR_MS = 60 * 60_000

export interface TimeoutBucket {
  readonly at: number
  readonly timeouts: number
}

export interface TimeoutLedger {
  /** The closure fingerprint these buckets were recorded under. */
  readonly version: string
  readonly buckets: readonly TimeoutBucket[]
}

export function recordTimeoutBucket(ledger: TimeoutLedger, bucket: TimeoutBucket): TimeoutLedger {
  const buckets = [...ledger.buckets, bucket]
  return {
    version: ledger.version,
    buckets:
      buckets.length > TIMEOUT_GUARD_WINDOW_BUCKETS
        ? buckets.slice(buckets.length - TIMEOUT_GUARD_WINDOW_BUCKETS)
        : buckets,
  }
}

/** Timeouts per hour over the ledger's buckets; `null` under the minimum. */
export function timeoutsPerHour(ledger: TimeoutLedger | null): number | null {
  if (ledger === null || ledger.buckets.length < TIMEOUT_GUARD_MIN_BUCKETS) return null
  const total = ledger.buckets.reduce((sum, b) => sum + b.timeouts, 0)
  const spanMs = ledger.buckets.length * TIMEOUT_GUARD_BUCKET_MS
  return (total / spanMs) * HOUR_MS
}

export type RegressionKind = 'regressed' | 'improved' | 'quiet' | 'not-comparable'

export interface RegressionVerdict {
  readonly kind: RegressionKind
  readonly previousVersion: string | null
  readonly currentVersion: string
  readonly previousPerHour: number | null
  readonly currentPerHour: number | null
}

export function evaluateTimeoutRegression(input: {
  readonly previous: TimeoutLedger | null
  readonly current: TimeoutLedger
}): RegressionVerdict {
  const { previous, current } = input
  const previousPerHour = timeoutsPerHour(previous)
  const currentPerHour = timeoutsPerHour(current)
  const base = {
    previousVersion: previous?.version ?? null,
    currentVersion: current.version,
    previousPerHour,
    currentPerHour,
  }
  if (
    previous === null ||
    previous.version === current.version ||
    previousPerHour === null ||
    currentPerHour === null
  ) {
    return { kind: 'not-comparable', ...base }
  }
  // The floor keeps a 0 → 3 an hour from ever being called a regression, and
  // gives a zero previous rate something finite to be multiplied against.
  const worseThan = Math.max(previousPerHour, TIMEOUT_GUARD_FLOOR_PER_HOUR / TIMEOUT_GUARD_RATIO)
  if (
    currentPerHour >= TIMEOUT_GUARD_FLOOR_PER_HOUR &&
    currentPerHour >= worseThan * TIMEOUT_GUARD_RATIO
  ) {
    return { kind: 'regressed', ...base }
  }
  if (
    previousPerHour >= TIMEOUT_GUARD_FLOOR_PER_HOUR &&
    currentPerHour * TIMEOUT_GUARD_RATIO <= previousPerHour
  ) {
    return { kind: 'improved', ...base }
  }
  return { kind: 'quiet', ...base }
}

// ── The fingerprint ──────────────────────────────────────────────────────

export interface ClosureFileReader {
  /** File contents, or `null` when it does not exist / cannot be read. */
  readonly readFile: (path: string) => string | null
}

/**
 * The closure version, read from the closure the runner was started from.
 *
 * The forked runner script is `<closure>/node_modules/@camstack/system/dist/
 * addon-runner.js` (hub: `/data/server-root/current/…`); the closure's own
 * `@camstack/server/package.json` sits two directories up. This is read from
 * disk rather than asked of `server-management` because that cap is
 * server-provided and the parent refuses to route it for a forked addon —
 * "no provider registered for cap server-management", measured on all
 * three nodes on 2026-09-05. A file the process was started from cannot
 * be refused.
 */
export function closureVersionFromRunnerPath(
  runnerScript: string | undefined,
  fs: ClosureFileReader,
): string | null {
  if (runnerScript === undefined || runnerScript.length === 0) return null
  let dir = dirname(runnerScript)
  for (let depth = 0; depth < 12; depth += 1) {
    const candidate = join(dir, 'node_modules', '@camstack', 'server', 'package.json')
    const raw = fs.readFile(candidate)
    if (raw !== null) {
      try {
        const parsed: unknown = JSON.parse(raw)
        const version =
          typeof parsed === 'object' && parsed !== null
            ? (parsed as { version?: unknown }).version
            : undefined
        if (typeof version === 'string' && version.length > 0) return `server@${version}`
      } catch {
        return null
      }
      return null
    }
    const parent = dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return null
}

// ── Runtime wrapper ─────────────────────────────────────────────────────

interface StoredLedgers {
  readonly current?: TimeoutLedger
  readonly previous?: TimeoutLedger
}

function readStoredLedgers(blob: Record<string, unknown>): StoredLedgers {
  const raw = blob[INFERENCE_TIMEOUT_LEDGER_KEY]
  if (typeof raw !== 'object' || raw === null) return {}
  const r = raw as { current?: unknown; previous?: unknown }
  return {
    ...(isLedger(r.current) ? { current: r.current } : {}),
    ...(isLedger(r.previous) ? { previous: r.previous } : {}),
  }
}

function isLedger(value: unknown): value is TimeoutLedger {
  if (typeof value !== 'object' || value === null) return false
  const v = value as { version?: unknown; buckets?: unknown }
  return (
    typeof v.version === 'string' &&
    Array.isArray(v.buckets) &&
    v.buckets.every(
      (b) =>
        typeof b === 'object' &&
        b !== null &&
        typeof (b as TimeoutBucket).at === 'number' &&
        typeof (b as TimeoutBucket).timeouts === 'number',
    )
  )
}

export interface TimeoutGuardFinding {
  readonly findingId: string
  readonly severity: 'error'
  readonly title: string
  readonly message: string
}

export interface InferenceTimeoutGuardDeps {
  /** Monotonic count of timed-out inference requests on this node, all pools. */
  readonly readTotalTimeouts: () => number
  readonly readStore: () => Promise<Record<string, unknown>>
  readonly writeStore: (patch: Record<string, unknown>) => Promise<void>
  /** The closure fingerprint; `null` until it can be resolved (retried each tick). */
  readonly resolveFingerprint: () => Promise<string | null>
  readonly emitFailed: (finding: TimeoutGuardFinding) => void
  readonly emitRecovered: (findingId: string) => void
  readonly nodeId: string
  readonly log: IScopedLogger
  readonly now?: () => number
}

export interface InferenceTimeoutGuard {
  start(): void
  /** One bucket. Exposed for tests; the timer calls it. */
  tick(): Promise<void>
  stop(): void
}

export function createInferenceTimeoutGuard(
  deps: InferenceTimeoutGuardDeps,
): InferenceTimeoutGuard {
  const now = deps.now ?? (() => Date.now())
  const findingId = `inference-timeout-regression:${deps.nodeId}`
  let timer: ReturnType<typeof setInterval> | null = null
  let current: TimeoutLedger | null = null
  let previous: TimeoutLedger | null = null
  let lastTotal = 0
  let raised = false
  let improvementLogged = false

  const ensureLedger = async (): Promise<boolean> => {
    if (current !== null) return true
    const fingerprint = await deps.resolveFingerprint()
    if (fingerprint === null) return false
    const stored = readStoredLedgers(await deps.readStore())
    if (stored.current !== undefined && stored.current.version === fingerprint) {
      // A plain restart: keep counting under the same fingerprint.
      current = stored.current
      previous = stored.previous ?? null
    } else {
      // An update: what was current becomes the baseline to beat.
      current = { version: fingerprint, buckets: [] }
      previous = stored.current ?? stored.previous ?? null
    }
    lastTotal = deps.readTotalTimeouts()
    deps.log.info('inference timeout guard armed', {
      meta: {
        fingerprint,
        previousVersion: previous?.version ?? null,
        previousPerHour: timeoutsPerHour(previous),
        bucketMs: TIMEOUT_GUARD_BUCKET_MS,
      },
    })
    return true
  }

  const tick = async (): Promise<void> => {
    try {
      if (!(await ensureLedger()) || current === null) return
      const total = deps.readTotalTimeouts()
      // A pool restart resets its counter; a drop below the last total means
      // the new count IS the delta.
      const delta = total >= lastTotal ? total - lastTotal : total
      lastTotal = total
      current = recordTimeoutBucket(current, { at: now(), timeouts: delta })
      await deps.writeStore({
        [INFERENCE_TIMEOUT_LEDGER_KEY]: {
          current,
          ...(previous !== null ? { previous } : {}),
        },
      })
      const verdict = evaluateTimeoutRegression({ previous, current })
      const meta = {
        previousVersion: verdict.previousVersion,
        currentVersion: verdict.currentVersion,
        previousPerHour: verdict.previousPerHour,
        currentPerHour: verdict.currentPerHour,
      }
      if (verdict.kind === 'regressed') {
        if (!raised) {
          raised = true
          const message =
            `inference requests time out ${Math.round(verdict.currentPerHour ?? 0)}/h under ` +
            `${verdict.currentVersion}, against ${Math.round(verdict.previousPerHour ?? 0)}/h under ` +
            `${verdict.previousVersion ?? 'unknown'} — the update regressed inference on ${deps.nodeId}`
          deps.log.error('inference timeout REGRESSION after update', { meta })
          deps.emitFailed({
            findingId,
            severity: 'error',
            title: 'Inference timeouts regressed after update',
            message,
          })
        }
        return
      }
      if (raised && verdict.kind !== 'not-comparable') {
        raised = false
        deps.log.info('inference timeout regression cleared', { meta })
        deps.emitRecovered(findingId)
      }
      if (verdict.kind === 'improved' && !improvementLogged) {
        improvementLogged = true
        deps.log.info('inference timeouts improved after update', { meta })
      }
    } catch (err) {
      deps.log.warn('inference timeout guard tick failed', {
        meta: { error: err instanceof Error ? err.message : String(err) },
      })
    }
  }

  return {
    start: (): void => {
      if (timer !== null) return
      timer = setInterval(() => {
        void tick()
      }, TIMEOUT_GUARD_BUCKET_MS)
      timer.unref?.()
      void ensureLedger()
    },
    tick,
    stop: (): void => {
      if (timer !== null) clearInterval(timer)
      timer = null
    },
  }
}
