/**
 * The container's pid ceiling — the limit that stops work without an error
 * anyone reads.
 *
 * ## Why this file exists
 *
 * A container cgroup counts **THREADS**, not processes. This hub runs with
 * `pids.max` 2048 and was measured refusing 22 `clone()` calls in 45 minutes.
 * A refused clone is not an exception that travels: an ffmpeg child that
 * cannot start its decode threads runs degraded or dies, a worker pool comes
 * up short, a spawn fails — and what the operator SEES is media that stopped.
 * Nothing in the product read the counter, so the only trace of the ceiling
 * was the damage it did.
 *
 * Live hub, 2026-09-18, verbatim:
 *
 * ```
 * /sys/fs/cgroup/pids.current → 973
 * /sys/fs/cgroup/pids.max     → 2048
 * /sys/fs/cgroup/pids.events  → max 0
 * ```
 *
 * ## `pids.events` is the proof, `pids.current` is only the weather
 *
 * `pids.current` says how close we are. `pids.events`' `max` counter says how
 * many times the kernel ALREADY said no — it is monotonic for the life of the
 * cgroup, so a rise between two samples is a refusal that happened in that
 * window, and nothing else can produce it. That is the difference between "it
 * looks tight" and "we lost work", and only the second one is worth waking
 * someone for.
 *
 * ## What it is NOT
 *
 * Measurement only. Nothing here raises a limit, kills a process or trims a
 * pool. The ceiling is the operator's (`--pids-limit` on the container) and
 * the thread counts are the subsystems' own; this file exists so that both are
 * decided on a number instead of a hunch.
 *
 * ## Absent is ABSENT
 *
 * A node with no cgroup — a developer Mac, a bare-metal host — produces
 * `null`, never zero, exactly as {@link ContainerMemoryProbe} does. `max` of
 * `max` (no ceiling) is `null` too: a fraction of no ceiling is not 0 %.
 *
 * The parsing is pure and the I/O is the same injected {@link CgroupFileReader}
 * the memory probe uses, so every shape here is testable against real files.
 */

import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import { CGROUP_MOUNT_ROOT, nodeCgroupFileReader, parseCgroupSelf } from './cgroup-memory.js'
import type { CgroupFileReader } from './cgroup-memory.js'

/** Which hierarchy answered — reported so a reading is never ambiguous. */
export type CgroupPidsSource = 'cgroup-v2' | 'cgroup-v1'

/** One reading of the ceiling and our distance from it. */
export interface ContainerPidsSnapshot {
  readonly source: CgroupPidsSource
  /** Threads (not processes) charged to this cgroup right now. */
  readonly current: number
  /** The ceiling, or `null` when there is none. */
  readonly max: number | null
  /** `current / max`, or `null` without a ceiling. */
  readonly usedFraction: number | null
  /** Lifetime count of REFUSED forks, or `null` when the kernel does not say. */
  readonly refusals: number | null
}

/** Where the files for one hierarchy live, once resolved. */
export interface CgroupPidsLayout {
  readonly source: CgroupPidsSource
  readonly directory: string
  readonly currentPath: string
  readonly maxPath: string
  readonly eventsPath: string
}

/**
 * `pids.max` is either a number or the word `max`.
 *
 * `max` means NO ceiling, and that is `null` — not `Infinity`, not a huge
 * number. A ceiling nothing can reach is not a ceiling, and reporting one
 * would make every utilisation fraction on an unlimited node read as 0 %.
 */
export function parsePidsMax(text: string): number | null {
  const trimmed = text.trim()
  if (trimmed.length === 0 || trimmed === 'max') return null
  const value = Number(trimmed)
  if (!Number.isFinite(value) || value < 0) return null
  return value
}

/**
 * `pids.events` is `key value` per line; we read exactly one key:
 *
 * ```
 * max 22
 * ```
 *
 * `max` is the number of times a fork was refused because the limit was hit.
 * A kernel that publishes only `pids.events.local`, or a file we cannot make
 * sense of, answers `null` — unknown, never zero, because zero here means "no
 * refusals have ever happened" and that is a claim.
 */
export function parsePidsEvents(text: string): number | null {
  for (const rawLine of text.split('\n')) {
    const line = rawLine.trim()
    if (line.length === 0) continue
    const space = line.indexOf(' ')
    if (space <= 0) continue
    if (line.slice(0, space) !== 'max') continue
    const value = Number(line.slice(space + 1).trim())
    if (!Number.isFinite(value) || value < 0) return null
    return value
  }
  return null
}

/** Turn one layout's files into a snapshot. Pure over the text. */
export function buildContainerPidsSnapshot(input: {
  readonly source: CgroupPidsSource
  readonly currentText: string
  readonly maxText: string | null
  readonly eventsText: string | null
}): ContainerPidsSnapshot | null {
  const current = Number(input.currentText.trim())
  if (!Number.isFinite(current) || current < 0) return null
  const max = input.maxText === null ? null : parsePidsMax(input.maxText)
  return {
    source: input.source,
    current,
    max,
    usedFraction: max === null || max === 0 ? null : current / max,
    refusals: input.eventsText === null ? null : parsePidsEvents(input.eventsText),
  }
}

/**
 * Find the pids cgroup from INSIDE this process, never a hard-coded path —
 * same reasoning as the memory layout: from inside the container the cgroup is
 * at the mount ROOT (`0::/`), from the host it is `<mount>/docker/<id>`, and
 * hard-coding either one breaks the other.
 */
export function resolveCgroupPidsLayout(fs: CgroupFileReader): CgroupPidsLayout | null {
  const selfText = fs.read('/proc/self/cgroup')
  if (selfText === null) return null
  const entry = parseCgroupSelf(selfText)
  if (entry === null) return null

  const suffix = entry.path === '/' ? '' : entry.path
  const candidates =
    entry.version === 'v2'
      ? [`${CGROUP_MOUNT_ROOT}${suffix}`, CGROUP_MOUNT_ROOT]
      : [`${CGROUP_MOUNT_ROOT}/pids${suffix}`, `${CGROUP_MOUNT_ROOT}/pids`]

  for (const directory of candidates) {
    if (fs.read(`${directory}/pids.current`) === null) continue
    return {
      source: entry.version === 'v2' ? 'cgroup-v2' : 'cgroup-v1',
      directory,
      currentPath: `${directory}/pids.current`,
      maxPath: `${directory}/pids.max`,
      eventsPath: `${directory}/pids.events`,
    }
  }
  return null
}

export interface ContainerPidsProbeDeps {
  readonly logger: IScopedLogger
  readonly fs?: CgroupFileReader
  readonly now?: () => number
  /** How often the heartbeat line is written. Default 60 s. */
  readonly heartbeatMs?: number
  /** Utilisation at which the heartbeat becomes a WARN. Default 0.8. */
  readonly pressureFraction?: number
}

const DEFAULT_HEARTBEAT_MS = 60_000
const DEFAULT_PRESSURE_FRACTION = 0.8

/**
 * The sampler.
 *
 * Its logging is deliberately different from the memory probe's, because the
 * operator asked for a DAY of regular readings before deciding whether to
 * raise the ceiling: there is a heartbeat, on its own cadence, whatever the
 * sampling tick is. Three lines exist and no more:
 *
 * 1. **Resolution**, once — the hierarchy that answered, or "no cgroup here",
 *    which is a fact about the node and not an error.
 * 2. **Heartbeat**, every `heartbeatMs` — current, ceiling, utilisation and
 *    the lifetime refusal count. INFO while there is room, WARN while we are
 *    above `pressureFraction`, and one INFO when it comes back down, so the
 *    log carries BOTH edges of a pressure episode rather than only its start.
 * 3. **A refusal**, immediately — the `pids.events` counter rose, so the
 *    kernel said no that many times since the last sample and some subsystem
 *    silently did without a thread. This one never waits for the heartbeat.
 */
export class ContainerPidsProbe {
  private readonly logger: IScopedLogger
  private readonly fs: CgroupFileReader
  private readonly now: () => number
  private readonly heartbeatMs: number
  private readonly pressureFraction: number
  private resolved = false
  private layout: CgroupPidsLayout | null = null
  private lastHeartbeatAt: number | null = null
  private lastRefusals: number | null = null
  private underPressure = false

  constructor(deps: ContainerPidsProbeDeps) {
    this.logger = deps.logger
    this.fs = deps.fs ?? nodeCgroupFileReader
    this.now = deps.now ?? Date.now
    this.heartbeatMs = deps.heartbeatMs ?? DEFAULT_HEARTBEAT_MS
    this.pressureFraction = deps.pressureFraction ?? DEFAULT_PRESSURE_FRACTION
  }

  /** Did this node resolve a pids cgroup at all? Absent is a reportable fact. */
  get available(): boolean {
    return this.layout !== null
  }

  /** One reading, or `null` where there is no cgroup or it stopped answering. */
  sample(): ContainerPidsSnapshot | null {
    const layout = this.resolveOnce()
    if (layout === null) return null
    const currentText = this.fs.read(layout.currentPath)
    if (currentText === null) return null
    const snapshot = buildContainerPidsSnapshot({
      source: layout.source,
      currentText,
      maxText: this.fs.read(layout.maxPath),
      eventsText: this.fs.read(layout.eventsPath),
    })
    if (snapshot === null) return null
    this.report(snapshot)
    return snapshot
  }

  private resolveOnce(): CgroupPidsLayout | null {
    if (this.resolved) return this.layout
    this.resolved = true
    try {
      this.layout = resolveCgroupPidsLayout(this.fs)
    } catch (err) {
      this.layout = null
      this.logger.warn('cgroup pids resolution failed — the pid ceiling will be ABSENT', {
        meta: { error: errMsg(err) },
      })
      return null
    }
    if (this.layout === null) {
      this.logger.info(
        'no pids cgroup on this node — the pid ceiling is ABSENT, not unlimited, for every sample',
        { meta: { platform: process.platform, probed: '/proc/self/cgroup' } },
      )
      return null
    }
    this.logger.info('pid ceiling resolved from the cgroup', {
      meta: { source: this.layout.source, directory: this.layout.directory },
    })
    return this.layout
  }

  private report(snapshot: ContainerPidsSnapshot): void {
    this.reportRefusals(snapshot)

    const at = this.now()
    const pressure =
      snapshot.usedFraction !== null && snapshot.usedFraction >= this.pressureFraction
    if (this.underPressure && !pressure) {
      this.underPressure = false
      this.logger.info('pid pressure recovered — back under the guard fraction', {
        meta: this.meta(snapshot),
      })
      this.lastHeartbeatAt = at
      return
    }

    const due = this.lastHeartbeatAt === null || at - this.lastHeartbeatAt >= this.heartbeatMs
    if (!due) return
    this.lastHeartbeatAt = at
    this.underPressure = pressure
    if (pressure) {
      this.logger.warn(
        'pid ceiling is being approached — a refused clone() is silent work loss, and this container counts THREADS',
        { meta: this.meta(snapshot) },
      )
      return
    }
    this.logger.info('pid ceiling', { meta: this.meta(snapshot) })
  }

  /**
   * The counter only ever rises, so a rise is a refusal that happened in this
   * window. Reported the moment it is seen — never held for the heartbeat,
   * because this is the line that says work was lost.
   */
  private reportRefusals(snapshot: ContainerPidsSnapshot): void {
    const refusals = snapshot.refusals
    if (refusals === null) return
    const previous = this.lastRefusals
    this.lastRefusals = refusals
    if (previous === null || refusals <= previous) return
    this.logger.warn(
      'the kernel REFUSED a fork at the pid ceiling — something asked for a thread and did not get one',
      {
        meta: { ...this.meta(snapshot), refusedSinceLastSample: refusals - previous },
      },
    )
  }

  private meta(snapshot: ContainerPidsSnapshot): Record<string, unknown> {
    return {
      current: snapshot.current,
      max: snapshot.max,
      usedPct:
        snapshot.usedFraction === null ? null : Math.round(snapshot.usedFraction * 1000) / 10,
      refusalsLifetime: snapshot.refusals,
      source: snapshot.source,
    }
  }
}
