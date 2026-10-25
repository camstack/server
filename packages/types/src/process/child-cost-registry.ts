/**
 * The registry an addon claims its OWN child processes in — the spawn-site
 * half of `load-contribution.cap.ts`.
 *
 * ## Where a claim is made, and where it is released
 *
 * At the spawn site, and nowhere else. It is the only place that knows both
 * halves: the recorder's controller knows it is starting ffmpeg for camera 101
 * profile `high`; the decode coordinator knows the session it is forking a
 * worker for. Nothing has to deduce it afterwards, and no entity needs a
 * global list of which pid belongs to which camera.
 *
 * {@link ChildCostRegistry.claim} returns a HANDLE, and the handle is the only
 * way to release. That is not decoration: the alternative — `release(pid)` —
 * lets a late release from a dead generation delete the live claim of a
 * process that inherited the same pid, which is precisely how a per-camera
 * chart charges one camera for another camera's work. A handle can only ever
 * remove the entry it created.
 *
 * ## What the registry does NOT do
 *
 * It keeps no history, no counters and no timers. It holds live claims and
 * answers questions about them; when the process holding it dies, every claim
 * in it dies with it, which is correct — those children were its children.
 *
 * ## The numbers
 *
 * {@link ChildCostRegistry.contributions} reads each claimed child's
 * CUMULATIVE CPU seconds and resident bytes out of `/proc/<pid>` at the moment
 * it is asked. On demand, never on a timer: a new periodic per-node sampler is
 * the defect half of `docs/architecture/load-ledger.md` documents. A counter
 * can be differenced by whoever already keeps a history; a rate cannot be
 * un-averaged.
 *
 * Where `/proc` does not exist (macOS, Windows) or the read fails, the numbers
 * are ABSENT — never zero. Zero would say the camera cost nothing.
 */
import { readFile } from 'node:fs/promises'
import type {
  LoadContribution,
  LoadContributionAttribution,
  LoadContributionRole,
} from '../capabilities/load-contribution.cap.js'

/**
 * Kernel jiffies per second (`USER_HZ`). Same constant, same reasoning, as
 * `packages/system/src/builtins/native-metrics/thread-cpu-sampler.ts`:
 * `sysconf(_SC_CLK_TCK)` is not exposed to Node and this has been 100 on every
 * kernel configuration we ship to. A wrong value would scale every CPU number
 * by a constant — visible immediately, not a silent skew.
 */
const CLOCK_TICKS_PER_SEC = 100

/** Bytes per page, for `/proc/<pid>/statm`'s page counts. */
const PAGE_BYTES = 4096

/** What a spawn site knows about the child it just started. */
export interface ChildCostClaimInput {
  readonly role: LoadContributionRole
  /**
   * The NUMERIC device id, or `null` when this child genuinely serves no
   * single camera. A spawn site that cannot name its camera should not claim
   * at all: an unnamed per-camera claim is indistinguishable from a shared one
   * and would turn one camera's cost into everybody's.
   */
  readonly deviceId: number | null
  /** What this one child is, in the contributor's own words: `101/high`. */
  readonly unit: string
  /**
   * Defaults to `measured` — the ordinary case for a child that serves exactly
   * one camera. Set it explicitly for a shared resource that reports itself as
   * unattributable.
   */
  readonly attribution?: LoadContributionAttribution
  /**
   * The child's pid. `undefined` is accepted and the claim is then INERT: the
   * cost cannot be measured and the entry would be a role and a camera with no
   * numbers, which the unattributed bucket already covers more honestly.
   */
  readonly pid: number | undefined
}

/** The only way to remove a claim. See the module docblock. */
export interface ChildCostClaimHandle {
  /** Idempotent: releasing twice, or after the registry was cleared, is safe. */
  readonly release: () => void
}

/**
 * The handle a spawn site gets when nobody is collecting — a test harness, or
 * a runner built before its addon registered a registry. Reporting nothing is
 * the correct behaviour: the process still appears in the node's process
 * snapshot, unclaimed, which is exactly what "nobody reported this" should
 * look like.
 */
export const NO_COST_CLAIM: ChildCostClaimHandle = { release: () => undefined }

interface ClaimEntry {
  readonly role: LoadContributionRole
  readonly deviceId: number | null
  readonly unit: string
  readonly attribution: LoadContributionAttribution
  readonly pid: number
  readonly startedAtMs: number
}

/** Injectable procfs surface — the whole reason this module is testable. */
export interface ProcStatReader {
  /** `/proc/<pid>/stat` */
  readonly readStat: (pid: number) => Promise<string>
  /** `/proc/<pid>/statm` */
  readonly readStatm: (pid: number) => Promise<string>
}

export const nodeProcStatReader: ProcStatReader = {
  readStat: (pid) => readFile(`/proc/${pid}/stat`, 'utf8'),
  readStatm: (pid) => readFile(`/proc/${pid}/statm`, 'utf8'),
}

/**
 * Cumulative CPU seconds from a `/proc/<pid>/stat` line.
 *
 * The `comm` field is field 2, wrapped in parentheses, and can itself contain
 * spaces and parentheses — so the only correct parse cuts at the LAST `)` and
 * indexes from there. After the cut, field 3 (`state`) is index 0, so `utime`
 * (field 14) is index 11 and `stime` (field 15) is index 12.
 *
 * `null` for a line that does not parse: a process that exited between the
 * claim and the read leaves a truncated or empty file, and that is normal.
 */
export function parseProcCpuSeconds(line: string): number | null {
  const close = line.lastIndexOf(')')
  if (close < 0) return null
  const rest = line
    .slice(close + 1)
    .trim()
    .split(/\s+/)
  const utime = Number(rest[11])
  const stime = Number(rest[12])
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null
  return (utime + stime) / CLOCK_TICKS_PER_SEC
}

/**
 * Resident bytes from a `/proc/<pid>/statm` line — field 2 is the resident set
 * in pages. `null` when the line does not parse.
 */
export function parseProcRssBytes(line: string): number | null {
  const fields = line.trim().split(/\s+/)
  const residentPages = Number(fields[1])
  if (!Number.isFinite(residentPages)) return null
  return residentPages * PAGE_BYTES
}

/**
 * What the OS will say about one process right now: cumulative CPU seconds and
 * resident bytes, each ABSENT when it cannot be read.
 *
 * Exported because not every cost has a spawn site inside a registry. The
 * shared inference pool is the case that forced it: its process is created
 * deep inside the engine factory and belongs to no camera, so it is reported
 * as an `unattributable` contribution built from the live pool's pids rather
 * than from a claim — but its numbers must be read the same way, by the same
 * parsers, or two "CPU seconds" in one payload would mean two things.
 */
export async function readProcessCost(
  pid: number,
  reader: ProcStatReader = nodeProcStatReader,
): Promise<{ readonly cpuSeconds?: number; readonly rssBytes?: number }> {
  let cpuSeconds: number | null = null
  let rssBytes: number | null = null
  try {
    cpuSeconds = parseProcCpuSeconds(await reader.readStat(pid))
  } catch {
    cpuSeconds = null
  }
  try {
    rssBytes = parseProcRssBytes(await reader.readStatm(pid))
  } catch {
    rssBytes = null
  }
  return {
    ...(cpuSeconds === null ? {} : { cpuSeconds }),
    ...(rssBytes === null ? {} : { rssBytes }),
  }
}

export class ChildCostRegistry {
  private claims = new Map<symbol, ClaimEntry>()

  constructor(
    private readonly reader: ProcStatReader = nodeProcStatReader,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Record one child. The returned handle is the only way to remove it.
   *
   * A claim with no pid is dropped rather than stored: it could carry no
   * measurement, and an entry with a camera and no numbers reads on a chart as
   * a camera that cost nothing.
   */
  claim(input: ChildCostClaimInput): ChildCostClaimHandle {
    const pid = input.pid
    if (pid === undefined || !Number.isInteger(pid) || pid <= 0) return NO_COST_CLAIM
    const key = Symbol('child-cost-claim')
    this.claims.set(key, {
      role: input.role,
      deviceId: input.deviceId,
      unit: input.unit,
      attribution: input.attribution ?? 'measured',
      pid,
      startedAtMs: this.now(),
    })
    return {
      release: () => {
        this.claims.delete(key)
      },
    }
  }

  /** Live claims, in claim order. Diagnostics and tests; not a contribution. */
  list(): readonly ChildCostClaimInput[] {
    return [...this.claims.values()].map((c) => ({
      role: c.role,
      deviceId: c.deviceId,
      unit: c.unit,
      attribution: c.attribution,
      pid: c.pid,
    }))
  }

  /**
   * This addon's contribution: one entry per live claim, with whatever the OS
   * will tell us about that child right now.
   *
   * A child that has exited between the claim and this read contributes an
   * entry with no numbers rather than no entry — the unit exists, the addon
   * believes it is running, and hiding it would make a dying writer look like
   * a writer that was never started.
   */
  async contributions(): Promise<readonly LoadContribution[]> {
    const out: LoadContribution[] = []
    for (const claim of this.claims.values()) {
      out.push({
        role: claim.role,
        deviceId: claim.deviceId,
        attribution: claim.attribution,
        unit: claim.unit,
        pid: claim.pid,
        startedAtMs: claim.startedAtMs,
        ...(await readProcessCost(claim.pid, this.reader)),
      })
    }
    return out
  }
}
