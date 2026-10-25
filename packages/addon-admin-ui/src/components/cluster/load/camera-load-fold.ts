/**
 * Per-camera load, folded from what the addons REPORT — plus the part nobody
 * reported, kept separate.
 *
 * ## Two sources, on purpose
 *
 * `system.getLoadContributions` is what the addons say about themselves: the
 * recorder knows its ffmpeg serves camera 101, the decode coordinator knows
 * which camera it forked a worker for. Nothing here joins a pid to a camera —
 * the join never happens, because the claim was made by the only component
 * that already knew both.
 *
 * `metrics.node-processes-snapshot` is what the OS says is actually running,
 * whether or not anybody claims it. It is still needed, for one job: **the
 * difference**. A camstack-shaped process no contribution mentions is either a
 * leak or a cost family nobody has taught to report, and both are findings —
 * so it gets its own bucket and is never folded into a camera that happens to
 * be nearby. That bucket is the panel's unclaimed badge, and it is the only
 * thing the observed list is read for: the claimed-vs-observed PAIR that used
 * to be rendered beside it went with the prose on 2026-08-28.
 *
 * ## The `null` rule, unchanged from `load-series.ts`
 *
 * A bucket's cost is `null` unless EVERY entry in it reported one. Summing
 * only the entries that answered produces a smaller number that is
 * indistinguishable, on a chart, from a complete one.
 */
import type { LoadContributionAttribution, LoadContributionRole } from '@camstack/types'

/**
 * One reported entry, as it arrives from `system.getLoadContributions`.
 *
 * `addonId` is the registry KEY, not a bare addon id: the hub reports the key
 * it enumerated, so a remote agent's provider arrives as `recorder@agent-1`.
 * `contribution-origin.ts` is the only place that takes it apart.
 */
export interface CameraLoadEntry {
  readonly addonId: string
  readonly role: LoadContributionRole
  readonly deviceId: number | null
  readonly attribution: LoadContributionAttribution
  readonly unit: string
  readonly pid?: number
  /**
   * The pid's INCARNATION marker. A consumer differencing `cpuSeconds` must
   * drop the window when this changes: the counter restarted from zero in a
   * new process, and a delta across that boundary is a negative number or —
   * worse, on a recycled pid — a plausible positive one.
   */
  readonly startedAtMs?: number
  readonly cpuSeconds?: number
  readonly rssBytes?: number
}

/** The minimum a process row needs for the unclaimed arithmetic. */
export interface ObservedProcess {
  readonly pid: number
  readonly memoryRssBytes: number
}

/**
 * Which bucket an entry lands in.
 *
 * - `camera` — a per-camera cost, reported by the addon that owns it.
 * - `shared` — reported, and DECLARED as belonging to no camera (the inference
 *   pool). Visible as shared; never apportioned.
 * - `unclaimed` — the observer sees a process no contribution mentions.
 */
export type CameraLoadBucketKind = 'camera' | 'shared' | 'unclaimed'

/** Stable key for the bucket holding processes nobody reported. */
export const UNCLAIMED_BUCKET_KEY = '__unclaimed__'

export interface CameraLoadBucket {
  readonly key: string
  readonly kind: CameraLoadBucketKind
  /** The camera, when this bucket is one camera's. `null` otherwise. */
  readonly deviceId: number | null
  /** Cumulative CPU seconds, or `null` when any member did not report one. */
  readonly cpuSeconds: number | null
  /** Resident bytes, same rule. */
  readonly rssBytes: number | null
  /** How many units are in the bucket. */
  readonly unitCount: number
  /** The roles present, deduplicated and sorted — what this camera is doing. */
  readonly roles: readonly LoadContributionRole[]
}

interface Accumulator {
  kind: CameraLoadBucketKind
  deviceId: number | null
  cpu: number
  cpuKnown: boolean
  rss: number
  rssKnown: boolean
  count: number
  roles: Set<LoadContributionRole>
}

function emptyAccumulator(kind: CameraLoadBucketKind, deviceId: number | null): Accumulator {
  return {
    kind,
    deviceId,
    cpu: 0,
    cpuKnown: true,
    rss: 0,
    rssKnown: true,
    count: 0,
    roles: new Set<LoadContributionRole>(),
  }
}

function finish(key: string, a: Accumulator): CameraLoadBucket {
  return {
    key,
    kind: a.kind,
    deviceId: a.deviceId,
    cpuSeconds: a.cpuKnown ? Math.round(a.cpu * 100) / 100 : null,
    rssBytes: a.rssKnown ? a.rss : null,
    unitCount: a.count,
    roles: [...a.roles].sort(),
  }
}

/**
 * Fold contributions into one bucket per camera, plus one shared bucket, plus
 * the unclaimed bucket derived from the observed process list.
 *
 * `observed` is optional: a caller with no process snapshot in hand gets the
 * reported buckets and no unclaimed bucket at all — which is honest, because
 * "nothing is unclaimed" and "we did not look" must not render the same. An
 * absent snapshot produces no bucket; a snapshot with nothing left over
 * produces none either, and the difference between those two is visible in
 * whether the caller passed one.
 */
export function foldContributionsByCamera(
  contributions: readonly CameraLoadEntry[],
  observed?: readonly ObservedProcess[],
): readonly CameraLoadBucket[] {
  const acc = new Map<string, Accumulator>()
  const claimedPids = new Set<number>()

  for (const entry of contributions) {
    if (entry.pid !== undefined) claimedPids.add(entry.pid)
    // A per-camera cost needs a camera. An entry that declares itself
    // unattributable, or simply has no deviceId, is SHARED — never spread
    // across the cameras that happen to be present.
    const isCamera = entry.deviceId !== null && entry.attribution !== 'unattributable'
    const key = isCamera ? `device:${entry.deviceId}` : `shared:${entry.role}`
    const cur =
      acc.get(key) ??
      emptyAccumulator(isCamera ? 'camera' : 'shared', isCamera ? entry.deviceId : null)
    cur.count += 1
    cur.roles.add(entry.role)
    if (entry.cpuSeconds === undefined) cur.cpuKnown = false
    else cur.cpu += entry.cpuSeconds
    if (entry.rssBytes === undefined) cur.rssKnown = false
    else cur.rss += entry.rssBytes
    acc.set(key, cur)
  }

  const out = [...acc.entries()].map(([key, a]) => finish(key, a))

  if (observed === undefined) return out

  const unclaimed = observed.filter((p) => !claimedPids.has(p.pid))
  if (unclaimed.length === 0) return out

  const bucket = emptyAccumulator('unclaimed', null)
  for (const p of unclaimed) {
    bucket.count += 1
    bucket.rss += p.memoryRssBytes
  }
  // The observer measures RSS but reports no cumulative CPU seconds, so the
  // unclaimed bucket's CPU is genuinely unknown. It stays `null` rather than
  // borrowing the lifetime-average column, which is not the same quantity.
  bucket.cpuKnown = false
  return [...out, finish(UNCLAIMED_BUCKET_KEY, bucket)]
}
