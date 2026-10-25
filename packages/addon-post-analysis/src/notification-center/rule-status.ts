/**
 * "What is this rule doing RIGHT NOW" — the live status behind a rule's title.
 *
 * A rule list answers what an operator ASKED FOR; it never answers what is
 * happening. Two kinds make that gap painful, and they are the two this module
 * serves first:
 *
 *  - an OCCUPANCY rule's whole subject is a live count. "Did it fire?" is
 *    unanswerable from the rule, and the state that would answer it — the
 *    confirmed level and when it last changed — already exists in the watcher's
 *    mirror and in the ZoneAnalytics snapshot the probe reads.
 *  - a TIMELAPSE rule produces one video per window per camera, hours after the
 *    window closed, and for up to thirty minutes of that it is INDISTINGUISH-
 *    ABLE from a rule that produced nothing. "When did it last run, when does it
 *    run next, is it running now" are three facts the stores already hold.
 *
 * SHAPE: a discriminated union on `kind`, so a third rule kind is a new member
 * and never a widened object with half its fields absent. `none` is a real
 * member — "this kind has no live state worth showing" is an answer, and an
 * empty object would read as a failed read.
 *
 * EVERYTHING HERE IS DERIVED, NOTHING IS STORED. A status that were persisted
 * would be a second copy of the watcher's state and would lie the first time a
 * render failed (D62's argument, one level down).
 */

import type { NcOccupancyCondition } from '@camstack/types'
import { z } from 'zod'
import { NcArtifactRecordSchema } from './artifact-index.js'
import type { NcOccupancyProbe } from './occupancy-dry-run.js'
import { type OccupancyStateRow, occupancyKey } from './occupancy-watcher.js'

/**
 * The live occupancy of the scope ONE rule counts.
 *
 * `count`/`occupied` come from the SAME probe the dry-run uses
 * (`probeOccupancyNow`), so the status and the dry-run can never disagree about
 * a camera. `since` comes from the watcher's CONFIRMED row, which is a
 * different fact and the one the operator actually asks for: the probe reads a
 * level, the watcher records when that level was last confirmed to change.
 */
const NcOccupancyRuleStatusSchema = z.object({
  kind: z.literal('occupancy'),
  deviceId: z.number().int(),
  /** Zone NAME when the snapshot knows one, else the zone id, else absent for
   *  whole-frame — the words a card puts after "in". */
  scope: z.string().optional(),
  /** The class counted; absent = every class. */
  className: z.string().optional(),
  /** The capacity the predicate compares against (`<=C` keys on C+1). */
  threshold: z.number().int(),
  sustainSeconds: z.number().int(),
  /** The count read for the scope. Absent when the probe was unavailable. */
  count: z.number().int().optional(),
  /** `count >= threshold` at the probe. Absent when unavailable. */
  occupied: z.boolean().optional(),
  /** Frame time of the snapshot the count came from — how FRESH it is, which
   *  is a different question from "now". */
  observedAt: z.number().int().optional(),
  /** When the watcher last CONFIRMED a change of this key's level. Absent when
   *  the watcher holds no confirmed row (a cold boot, or a key nothing
   *  watches). */
  since: z.number().int().optional(),
  /** Why there is no count: the two fail-closed shapes of the live path. */
  unavailable: z.enum(['no-snapshot', 'zone-absent']).optional(),
  /** A scope the counter can never answer (a sub-type class) — stated, because
   *  its reading of 0 is pixel-identical to an empty zone. */
  warning: z.string().optional(),
})
export type NcOccupancyRuleStatus = z.infer<typeof NcOccupancyRuleStatusSchema>

/** One camera of a timelapse rule — each renders its own video. */
const NcTimelapseDeviceStatusSchema = z.object({
  deviceId: z.number().int(),
  /** Last successful generation for THIS camera (the per-device map, with the
   *  rule-wide fallback). Absent = never generated. */
  lastGeneratedAt: z.number().int().optional(),
  /** The artefact that generation produced, when it is still on the shelf. */
  lastArtifact: NcArtifactRecordSchema.optional(),
  /** A render this process is waiting on right now. */
  rendering: z
    .object({
      startedAt: z.number().int(),
      windowStartMs: z.number().int(),
      windowEndMs: z.number().int(),
    })
    .optional(),
})
export type NcTimelapseDeviceStatus = z.infer<typeof NcTimelapseDeviceStatusSchema>

const NcTimelapseRuleStatusSchema = z.object({
  kind: z.literal('timelapse'),
  devices: z.array(NcTimelapseDeviceStatusSchema),
  /** The most recent window that has already closed — what the next tick would
   *  render for any camera that has not got it yet. Absent = none in the
   *  lookback (a schedule that never closes, or a rule younger than its window). */
  lastWindow: z.object({ startMs: z.number(), endMs: z.number() }).optional(),
  /** The next OPENING. `endMs` null = the close is beyond the scan horizon. */
  nextWindow: z.object({ startMs: z.number(), endMs: z.number().nullable() }).optional(),
  /** How long after a close the producer waits for the footage to settle. */
  settleMs: z.number().int(),
})
export type NcTimelapseRuleStatus = z.infer<typeof NcTimelapseRuleStatusSchema>

/**
 * One OPEN window of a grouped rule (D692 §7): a window that is waiting is otherwise
 * invisible — the operator sees a rule that "did not fire" while it holds up to
 * `groupingSec` of people it has not yet been able to name.
 */
const NcGroupedWindowStatusSchema = z.object({
  deviceId: z.number().int(),
  windowKey: z.string(),
  /** The first event's own timestamp (the footage anchor). */
  openedAt: z.number().int(),
  /** The latest the window closes: `openedAt + groupingSec`. It may close earlier. */
  closesAt: z.number().int(),
  members: z.number().int(),
  /** The members whose outlook is NOT final at the moment of the read. */
  pending: z.number().int(),
})
export type NcGroupedWindowStatus = z.infer<typeof NcGroupedWindowStatusSchema>

/** A grouped immediate rule: its window length and the windows open on it right now. */
const NcGroupedRuleStatusSchema = z.object({
  kind: z.literal('grouped'),
  groupingSec: z.number().int(),
  /**
   * `null` = UNKNOWN (D315): this node cannot answer, which is not the same as "no window
   * open". `reason` then says why.
   */
  openWindows: z.array(NcGroupedWindowStatusSchema).nullable(),
  reason: z.string().optional(),
})
export type NcGroupedRuleStatus = z.infer<typeof NcGroupedRuleStatusSchema>

export const NcRuleStatusSchema = z.discriminatedUnion('kind', [
  /** A rule kind with no live state worth showing. An ANSWER, not an error. */
  z.object({ kind: z.literal('none'), reason: z.string() }),
  NcOccupancyRuleStatusSchema,
  NcTimelapseRuleStatusSchema,
  NcGroupedRuleStatusSchema,
])
export type NcRuleStatus = z.infer<typeof NcRuleStatusSchema>

/**
 * Assemble the occupancy status from the probe and the watcher's confirmed row.
 *
 * Pure. The two inputs are deliberately separate rather than one blob: they
 * answer different questions from different substrates, and merging them at the
 * source would let a missing snapshot erase a `since` the watcher still knows.
 */
export function buildOccupancyStatus(input: {
  readonly deviceId: number
  readonly condition: NcOccupancyCondition
  readonly probe: NcOccupancyProbe
  readonly confirmed: readonly OccupancyStateRow[]
  readonly threshold: number
  /** The impossible-class warning, when the scope has one. */
  readonly warning?: string
}): NcOccupancyRuleStatus {
  const { condition, probe, threshold } = input
  const key = occupancyKey(input.deviceId, condition.zoneId, condition.className, threshold)
  const row = input.confirmed.find((r) => r.key === key)
  const scope = probe.kind === 'probed' ? (probe.zoneName ?? condition.zoneId) : condition.zoneId
  return {
    kind: 'occupancy',
    deviceId: input.deviceId,
    ...(scope !== undefined ? { scope } : {}),
    ...(condition.className !== undefined ? { className: condition.className } : {}),
    threshold,
    sustainSeconds: condition.sustainSeconds,
    ...(probe.kind === 'probed'
      ? {
          count: probe.count,
          occupied: probe.subject.occupancy?.occupied === true,
          observedAt: probe.observedAt,
        }
      : { unavailable: probe.reason }),
    ...(row !== undefined ? { since: row.lastChangeAt } : {}),
    ...(input.warning !== undefined ? { warning: input.warning } : {}),
  }
}

/** One member of an open window, its finality already judged by the caller. */
export interface NcGroupedStatusMember {
  readonly trackId: string
  readonly final: boolean
}

/** What {@link buildGroupedStatus} reads of one open window: finality is already judged. */
export interface NcGroupedStatusWindow {
  readonly key: string
  readonly deviceId: number
  readonly openedAt: number
  readonly deadlineAt: number
  readonly members: readonly NcGroupedStatusMember[]
}

/** What {@link buildGroupedStatus} needs: the window length and the windows open now. */
export interface NcGroupedStatusInput {
  readonly groupingSec: number
  readonly windows: readonly NcGroupedStatusWindow[]
}

/**
 * A grouped rule's status when this node cannot say which windows are open (it does not run
 * rule evaluation): UNKNOWN, never an empty list (D315).
 */
export function buildGroupedStatusUnknown(
  groupingSec: number,
  reason: string,
): NcGroupedRuleStatus {
  return { kind: 'grouped', groupingSec, openWindows: null, reason }
}

/**
 * Assemble a grouped rule's status. Pure: the caller judges each member's finality (the
 * outlook is a live read of the recogniser) and hands the answer in, so the status can
 * never disagree with the early close, which asks the same question the same way.
 */
export function buildGroupedStatus(input: NcGroupedStatusInput): NcGroupedRuleStatus {
  return {
    kind: 'grouped',
    groupingSec: input.groupingSec,
    openWindows: input.windows.map((w) => ({
      deviceId: w.deviceId,
      windowKey: w.key,
      openedAt: w.openedAt,
      closesAt: w.deadlineAt,
      members: w.members.length,
      pending: w.members.filter((m) => !m.final).length,
    })),
  }
}
