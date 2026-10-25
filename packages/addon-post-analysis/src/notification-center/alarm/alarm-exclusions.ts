/**
 * The sensors a bypassed arm is deliberately ignoring — and the ONE rule that
 * decides when it stops ignoring them.
 *
 * An arm that was bypassed with the porch window open must not be set off by
 * that window. The naive version of this — "ignore it until it closes" — is
 * wrong in a way that only shows up on a real installation: the rule that arms
 * the alarm fires on a contact's STATE CHANGE, and closing the window is a
 * state change. Lifting the exclusion on the close would make shutting the
 * window the thing that sets the alarm off.
 *
 * So the exclusion has two phases and lifts on the SECOND edge:
 *
 *   excluded(open) ──close──▶ excluded(closed) ──open──▶ armed again
 *
 * Which is also the sentence the operator would use: the window is ignored
 * until you have shut it, and after that opening it counts.
 *
 * Persisted with the panel's machine, in the panel's own device config, because
 * the alternative is an alarm that silently re-arms every sensor it excluded on
 * the next deploy — and the operator finds out through the siren.
 */

import type { NcAlarmOpeningReading } from './alarm-openings.js'

/**
 * One opening's reading, in D630's vocabulary (`alarm-openings.ts`): a contact
 * that closed, a cover that reached `closed` and a lock that reached `locked`
 * are all `secure`; anything short of that is `open`. `undefined` is a reading
 * nobody could make — it changes nothing.
 */
export type NcExclusionReading = NcAlarmOpeningReading | undefined

/**
 * Where an excluded sensor is in its two-phase lift.
 *
 * `open` is the state it was excluded IN; `closed` means the operator has since
 * shut it and the next open re-arms it.
 */
type NcExclusionPhase = 'open' | 'closed'

/**
 * What one reading did to the set.
 *
 * `closed` and `rearmed` are BOTH state changes worth persisting; only
 * `rearmed` is worth a log line, because only it changes what is protected.
 */
export type NcExclusionChange = 'unchanged' | 'closed' | 'rearmed'

interface NcExclusionEntry {
  readonly deviceId: number
  readonly phase: NcExclusionPhase
  /** When the exclusion was created — carried for the log line, not the logic. */
  readonly at: number
  /**
   * The operator has been TOLD, once in this arm, that a trigger from this
   * sensor was ignored. Persisted with the entry, so a deploy does not turn
   * the next ignored trigger into a second notification.
   */
  readonly announced: boolean
  /**
   * The last reading REALLY MOVED the sensor (D735): an `open` whose own change
   * time is after the arm (and after the last move seen) while the exclusion is
   * still in phase `open` — it closed and opened again and the close was never
   * seen. Consumed by the press that reading caused ({@link takeMoved}). RAM only:
   * it lives for one evaluation, and a respawn between the reading and its press
   * loses one notification, never invents one.
   */
  readonly moved: boolean
  /** The change time of the last move seen — a re-delivery of the same reading is not a second move. */
  readonly lastMoveAt: number
}

/** The persisted shape. Read defensively — see {@link NcAlarmExclusions.restore}. */
interface NcExclusionRecord {
  readonly deviceId: number
  readonly phase: NcExclusionPhase
  readonly at: number
  readonly announced: boolean
}

function isPhase(value: unknown): value is NcExclusionPhase {
  return value === 'open' || value === 'closed'
}

/**
 * A change time that cannot be a move: `0` is a placeholder and `1` is the
 * "known value, unknown change time" convention providers stamp on a replay or
 * a recovery (`HM_SEEDED_CHANGED_AT`, `HA_SEEDED_CHANGED_AT`).
 */
const NO_CHANGE_TIME = 1

export class NcAlarmExclusions {
  private entries: readonly NcExclusionEntry[] = []

  /** Replace the whole set — one arm, one set of exclusions. */
  exclude(deviceIds: readonly number[], at: number): void {
    this.entries = [...new Set(deviceIds)].map((deviceId) => ({
      deviceId,
      phase: 'open',
      at,
      announced: false,
      moved: false,
      lastMoveAt: 0,
    }))
  }

  /** Every excluded sensor, in the order it was excluded. */
  list(): readonly number[] {
    return this.entries.map((e) => e.deviceId)
  }

  /** True while this sensor's events must not reach the panel. */
  blocks(deviceId: number): boolean {
    return this.entries.some((e) => e.deviceId === deviceId)
  }

  /**
   * Feed one opening's reading, and say what it CHANGED.
   *
   * Three answers, not two, because the caller has to persist on both of the
   * changes: the first `alarm-arm-refusal.spec.ts` run of this feature saved
   * only the re-arm, so a hub redeployed between the close and the re-open came
   * back with the sensor still in phase `open` — and the exclusion then needed
   * a SECOND close to lift. A phase that lives only in RAM is half a durable
   * exclusion.
   *
   * An unreadable state changes nothing (D49): a failed read must never lift an
   * exclusion the operator asked for, and must never swallow the close that
   * would have.
   *
   * `changedAt` is the reading's OWN change time, when the caller has one (a
   * sensor event's slice; the reconcile tick has none). It decides only whether
   * an open in phase `open` really MOVED ({@link takeMoved}) — never a lift.
   */
  observe(
    deviceId: number,
    reading: NcExclusionReading,
    _at: number,
    changedAt?: number,
  ): NcExclusionChange {
    if (reading === undefined) return 'unchanged'
    const current = this.entries.find((e) => e.deviceId === deviceId)
    if (current === undefined) return 'unchanged'
    if (reading === 'secure') {
      if (current.phase === 'closed') return this.replace({ ...current, moved: false }, 'unchanged')
      return this.replace({ ...current, phase: 'closed', moved: false }, 'closed')
    }
    // An OPEN while still `open` NEVER re-arms: nobody was seen shutting
    // anything. It is a re-published slice, a provider reconnect or a recovery
    // from `unavailable` — unless its own change time says it moved after the
    // arm, which is a close this set never saw (D735).
    if (current.phase === 'open') {
      const fresh =
        changedAt !== undefined &&
        Number.isFinite(changedAt) &&
        changedAt > Math.max(current.at, current.lastMoveAt, NO_CHANGE_TIME)
      // A re-delivery of the move not yet pressed leaves it pending; anything else is no move.
      const redelivered = current.moved && changedAt === current.lastMoveAt
      return this.replace(
        {
          ...current,
          moved: fresh || redelivered,
          lastMoveAt: fresh ? changedAt : current.lastMoveAt,
        },
        'unchanged',
      )
    }
    this.entries = this.entries.filter((e) => e.deviceId !== deviceId)
    return 'rearmed'
  }

  /**
   * Did the last reading of this sensor really move it (D735)? Consumed: the
   * press it caused asks once, and a later press of the same reading is a
   * duplicate. False for a sensor that is not excluded.
   */
  takeMoved(deviceId: number): boolean {
    const current = this.entries.find((e) => e.deviceId === deviceId)
    if (current === undefined || !current.moved) return false
    this.replace({ ...current, moved: false }, 'unchanged')
    return true
  }

  /**
   * Mark this sensor's ignored trigger as announced — true only the FIRST time
   * in this arm (the caller then announces and persists), false for a repeat
   * or for a sensor that is not excluded.
   */
  markAnnounced(deviceId: number): boolean {
    const current = this.entries.find((e) => e.deviceId === deviceId)
    if (current === undefined || current.announced) return false
    this.entries = this.entries.map((e) =>
      e.deviceId === deviceId ? { ...e, announced: true } : e,
    )
    return true
  }

  /**
   * Drop one sensor — it was DELETED, so it will never report the close that
   * would lift it. True when it was excluded (the caller then persists).
   */
  forget(deviceId: number): boolean {
    if (!this.blocks(deviceId)) return false
    this.entries = this.entries.filter((e) => e.deviceId !== deviceId)
    return true
  }

  /** Swap one entry for its next version — the set is replaced, never mutated. */
  private replace(next: NcExclusionEntry, change: NcExclusionChange): NcExclusionChange {
    this.entries = this.entries.map((e) => (e.deviceId === next.deviceId ? next : e))
    return change
  }

  /** The arm this belongs to is over. */
  clear(): void {
    this.entries = []
  }

  /** What to persist. Plain data — it rides the panel's config blob. */
  snapshot(): readonly NcExclusionRecord[] {
    return this.entries.map((e) => ({
      deviceId: e.deviceId,
      phase: e.phase,
      at: e.at,
      announced: e.announced,
    }))
  }

  /**
   * Rebuild from the persisted blob — a GUARD, never a cast.
   *
   * Anything unrecognised restores NOTHING, which is the failure that shows
   * itself (a bypassed sensor that fires) rather than the one that hides (a
   * sensor excluded forever by a blob nobody can read). A bare id with no phase
   * restores as still-OPEN: it needs a close before it can re-arm, which is the
   * half that cannot cause a false alarm.
   */
  restore(raw: unknown): void {
    if (!Array.isArray(raw)) return
    const out: NcExclusionEntry[] = []
    for (const item of raw) {
      if (typeof item === 'number' && Number.isInteger(item)) {
        out.push({
          deviceId: item,
          phase: 'open',
          at: 0,
          announced: false,
          moved: false,
          lastMoveAt: 0,
        })
        continue
      }
      if (item === null || typeof item !== 'object') continue
      const rec: Record<string, unknown> = { ...item }
      const deviceId = rec['deviceId']
      if (typeof deviceId !== 'number' || !Number.isInteger(deviceId)) continue
      const phase = isPhase(rec['phase']) ? rec['phase'] : 'open'
      const at = typeof rec['at'] === 'number' ? rec['at'] : 0
      out.push({
        deviceId,
        phase,
        at,
        announced: rec['announced'] === true,
        moved: false,
        lastMoveAt: 0,
      })
    }
    this.entries = out
  }
}
