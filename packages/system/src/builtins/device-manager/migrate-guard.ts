/**
 * A migration must survive its own retry.
 *
 * On 2026-09-01 `migrateDevice` ran for ~3.5 minutes under the transport's 60 s
 * default timeout. The caller died with `UND_ERR_HEADERS_TIMEOUT`, something
 * retried the call, and a SECOND full cycle ran. Two swaps cancel out — the
 * operator saw "nothing happened" with no error — and had the timing differed
 * by a lock's width, two live cameras would have kept each other's identity
 * with no way to tell. The cap now declares a timeout that covers the real
 * runtime (`device-manager.cap.ts`), but a bound alone only makes the retry
 * rarer; this guard makes it harmless. Two rules:
 *
 * 1. **While a migration involving a device is in flight, a second call
 *    touching that device is REFUSED — never queued.** The meta write lock is
 *    FIFO, so without this the retry parks politely behind the first run and
 *    then re-swaps the moment it finishes. The refusal is loud and names the
 *    device; the running migration's report stands.
 * 2. **A repeat of a COMPLETED swap is a no-op returning the original
 *    report.** "Did this already run" is answerable from the rows: the swap
 *    moves `addonId`/`stableId` between the two numbers, so a completed
 *    migration leaves a fingerprint this guard records and compares. Only an
 *    exact match replays — same pair, same post-swap identities, within
 *    {@link MIGRATION_REPLAY_WINDOW_MS} — anything else is a new operation and
 *    runs. The window is what separates a client's automated retry (arrives
 *    within the transport timeout envelope) from an operator deliberately
 *    swapping the same pair back later: the first must be absorbed, the second
 *    must run.
 *
 * In-memory on purpose. The retry that matters arrives at the same hub process
 * that ran the first cycle; a hub restart empties the guard AND ends every
 * client call that could still be retrying against it.
 */
import type { MigrateDeviceResult } from './migrate-device.js'

/** The addon-facing identity a device row carries — what `swapIds` moves. */
export interface DeviceIdentity {
  readonly addonId: string
  readonly stableId: string
}

/** What a finished migration left behind, for replay matching. */
export interface CompletedMigration {
  readonly sourceId: number
  readonly targetId: number
  /** Identity the completed swap left at `sourceId` (the pre-swap target's). */
  readonly identityAtSource: DeviceIdentity
  /** Identity the completed swap left at `targetId` (the pre-swap source's). */
  readonly identityAtTarget: DeviceIdentity
  readonly result: MigrateDeviceResult
}

interface CompletedMigrationRecord extends CompletedMigration {
  readonly completedAt: number
}

/**
 * How long a completed migration absorbs an identical repeat call. Sized to
 * comfortably cover the cap's own `timeoutMs` (10 min): a retry fired by a
 * client that gave up arrives inside that envelope; a call arriving later is
 * an operator's deliberate new operation and runs.
 */
export const MIGRATION_REPLAY_WINDOW_MS: number = 15 * 60_000

export interface MigrationGuard {
  /** Claim both ids for a run. Throws when either is already in flight. */
  begin(sourceId: number, targetId: number): void
  /** Release both ids. Always paired with {@link begin} via try/finally. */
  end(sourceId: number, targetId: number): void
  /**
   * Is a migration involving this device running right now? A per-field claim,
   * patch or release asks before touching the device's row (D663): the row is
   * about to be swapped with another device's, and a claim written into that
   * window would travel with the wrong hardware.
   */
  isInFlight(deviceId: number): boolean
  /** Record a completed swap's fingerprint for replay matching. */
  recordCompleted(record: CompletedMigration): void
  /**
   * The original report, when the call is a repeat of a completed swap: same
   * ordered pair, current row identities equal to the recorded post-swap
   * identities, within the window. `null` means "this is a new operation".
   */
  matchReplay(
    sourceId: number,
    targetId: number,
    atSource: DeviceIdentity,
    atTarget: DeviceIdentity,
  ): MigrateDeviceResult | null
}

function sameIdentity(a: DeviceIdentity, b: DeviceIdentity): boolean {
  return a.addonId === b.addonId && a.stableId === b.stableId
}

/** One guard per device-manager instance. `now` is injectable for the specs. */
export function createMigrationGuard(now: () => number = Date.now): MigrationGuard {
  const inFlight = new Set<number>()
  const completed = new Map<string, CompletedMigrationRecord>()
  const pairKey = (sourceId: number, targetId: number): string => `${sourceId}->${targetId}`

  return {
    begin(sourceId: number, targetId: number): void {
      for (const id of [sourceId, targetId]) {
        if (inFlight.has(id)) {
          throw new Error(
            `[device-manager] migrateDevice: a migration involving device ${id} is already in ` +
              `flight — this call was refused, not queued. The running migration's report stands; ` +
              `re-read the device rows before retrying.`,
          )
        }
      }
      inFlight.add(sourceId)
      inFlight.add(targetId)
    },

    end(sourceId: number, targetId: number): void {
      inFlight.delete(sourceId)
      inFlight.delete(targetId)
    },

    isInFlight(deviceId: number): boolean {
      return inFlight.has(deviceId)
    },

    recordCompleted(record: CompletedMigration): void {
      completed.set(pairKey(record.sourceId, record.targetId), {
        ...record,
        completedAt: now(),
      })
    },

    matchReplay(
      sourceId: number,
      targetId: number,
      atSource: DeviceIdentity,
      atTarget: DeviceIdentity,
    ): MigrateDeviceResult | null {
      const key = pairKey(sourceId, targetId)
      const record = completed.get(key)
      if (record === undefined) return null
      if (now() - record.completedAt > MIGRATION_REPLAY_WINDOW_MS) {
        completed.delete(key)
        return null
      }
      // The rows are the authority: a repeat call only replays while they still
      // carry exactly what the recorded swap left there. Any drift — a
      // re-registration, a removal, an intervening migration — makes this a new
      // operation.
      if (
        !sameIdentity(record.identityAtSource, atSource) ||
        !sameIdentity(record.identityAtTarget, atTarget)
      ) {
        return null
      }
      return record.result
    },
  }
}
