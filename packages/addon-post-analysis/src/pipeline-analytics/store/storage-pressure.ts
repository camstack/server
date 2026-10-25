/**
 * storage-pressure — make a full disk something the system REACTS to, not just
 * something it logs once per lost file.
 *
 * ## What happened
 *
 * On 2026-08-02 media writes started failing with
 * `ENOSPC: no space left on device, mkdir '/recordings/102/events/track/…'`.
 * For roughly five hours every new track was recorded with positions, a class,
 * a `bestEventId` and **zero snapshots** — a track that looks complete in the
 * list and has no picture behind it. The operator found it by noticing the
 * missing media, not from any alert.
 *
 * Two separate defects made that possible:
 *
 *  1. **Retention prunes by AGE only.** It has no feedback from the filesystem,
 *     so "the disk is full" is not an input it can respond to. It kept its
 *     configured window while writes failed.
 *  2. **The failure was logged per KEY.** Every lost frame produced its own
 *     `media put failed` WARN — dozens a minute, each true, none of them saying
 *     "this camera has stopped storing media". A per-item line is a receipt,
 *     not an alarm.
 *
 * This module is the missing feedback: it recognises an out-of-space failure,
 * counts it per device, and hands the caller ONE escalation to act on.
 *
 * ## Deliberately not a deleter
 *
 * It decides that pressure exists and says so. Freeing space is retention's
 * job, and giving a write-error handler the power to delete recordings is how
 * a transient fault becomes data loss. The trigger is separated from the act on
 * purpose.
 */

/** Errors that mean "the filesystem refused for want of room". */
const OUT_OF_SPACE_CODES: readonly string[] = ['ENOSPC', 'EDQUOT']

/**
 * Is this the disk being full, rather than any other write failure?
 *
 * Matches the CODE, not a message substring: a permission error or a missing
 * parent directory must not trigger a retention response, and the message text
 * is not a contract.
 */
export function isOutOfSpace(err: unknown): boolean {
  const code =
    typeof err === 'object' && err !== null && 'code' in err
      ? String((err as { code: unknown }).code)
      : ''
  if (OUT_OF_SPACE_CODES.includes(code)) return true
  // Node wraps the code into the message for `fs` errors that cross a
  // structured-clone / RPC boundary, which is exactly how this arrives from the
  // storage provider — so fall back to a code-shaped match, anchored to avoid
  // catching a path that merely contains the word.
  const msg = err instanceof Error ? err.message : String(err)
  return OUT_OF_SPACE_CODES.some((c) => msg.includes(`${c}:`))
}

/** How long between escalations while pressure persists. */
const PRESSURE_ESCALATION_INTERVAL_MS = 60_000

export interface PressureEscalation {
  /** Failures seen since the previous escalation (this one included). */
  readonly failures: number
  /** Devices affected since the previous escalation. */
  readonly deviceIds: readonly number[]
  /** True the very first time — the moment worth shouting about. */
  readonly first: boolean
}

/**
 * Counts out-of-space failures and releases an escalation at most once per
 * interval — plus immediately on the FIRST one, because the first is the line
 * that should have existed five hours before anyone noticed.
 *
 * Clock injected so the interval is testable without waiting.
 */
export class StoragePressureTracker {
  private failures = 0
  private readonly devices = new Set<number>()
  private lastEscalatedAt: number | null = null
  private readonly now: () => number
  private readonly intervalMs: number

  constructor(
    intervalMs: number = PRESSURE_ESCALATION_INTERVAL_MS,
    now: () => number = () => Date.now(),
  ) {
    this.intervalMs = intervalMs
    this.now = now
  }

  /**
   * Record a failed write. Returns an escalation when the caller should act
   * (alert loudly, ask retention to reclaim), or null to stay quiet.
   *
   * A non-space failure returns null and is not counted: this tracker exists
   * for one condition, and diluting it with unrelated errors would make the
   * escalation mean nothing.
   */
  record(err: unknown, deviceId: number | undefined): PressureEscalation | null {
    if (!isOutOfSpace(err)) return null
    this.failures += 1
    if (typeof deviceId === 'number') this.devices.add(deviceId)
    const at = this.now()
    const first = this.lastEscalatedAt === null
    if (!first && at - this.lastEscalatedAt! < this.intervalMs) return null
    const out: PressureEscalation = {
      failures: this.failures,
      deviceIds: [...this.devices],
      first,
    }
    this.failures = 0
    this.devices.clear()
    this.lastEscalatedAt = at
    return out
  }

  /** Clear the state after a successful write — pressure that has passed must
   *  not make the next isolated failure look like a continuing emergency. */
  noteSuccess(): void {
    if (this.failures === 0 && this.devices.size === 0) return
    this.failures = 0
    this.devices.clear()
  }
}
