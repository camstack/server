/**
 * "As of now, would this occupancy rule fire?" — the rule tester's occupancy probe.
 *
 * Every other trigger dry-runs against PERSISTED records: `testRule` scans
 * object events, closed tracks and package rows. An occupancy edge persists no
 * record of its own, so a rule carrying an `occupancy` condition dry-ran to an
 * EMPTY list — on screen indistinguishable from "this rule matches nothing",
 * for the one rule kind whose truth is fully available right now.
 *
 * It IS available: the live ZoneAnalytics snapshot is exactly the state the
 * condition is about. So the probe reads that snapshot, reduces it through the
 * SAME {@link resolveOccupancyScope} the live watcher uses, and hands the
 * synthesized subject to the SAME `evaluateRule`. There is no second matcher
 * and no second count derivation — a dry-run cannot disagree with the edge that
 * snapshot would produce.
 *
 * What it must never claim: that a fire is imminent. This is a LEVEL answer and
 * the label says so — the engine fires on the TRANSITION, sustained for
 * `sustainSeconds`, and then only outside the rule's cooldown. Fail-closed is
 * REPORTED rather than hidden: "no snapshot for this camera" and "that zone is
 * not in the snapshot" are the two reasons a live occupancy rule silently never
 * fires, and they are now rows an operator can read instead of an empty list.
 */

import type { CameraOccupancySnapshot, NcOccupancyCondition } from '@camstack/types'
import { DETECTION_MACRO_CLASSES, isDetectionMacroClass } from '@camstack/types'
import { occupancyThreshold, resolveOccupancyScope } from './occupancy-watcher.js'
import { type NcRuleSubject, subjectFromOccupancyEvent } from './rule-engine.js'

/** Why a probe could not be taken — the two fail-closed shapes of the live
 *  occupancy path, kept apart because they have different remedies (a camera
 *  that produced no frame vs a zoneId the rule outlived). */
export type NcOccupancyProbeUnavailable = 'no-snapshot' | 'zone-absent'

/** The answer to "as of now": either a synthesized subject + the counts it was
 *  built from, or the named reason there is none. */
export type NcOccupancyProbe =
  | {
      readonly kind: 'probed'
      /** The subject, ready for the ORDINARY `evaluateRule`. */
      readonly subject: NcRuleSubject
      /** The count actually read for the rule's scope. */
      readonly count: number
      /** The capacity the predicate compared it against (`<=C` keys on C+1). */
      readonly threshold: number
      readonly zoneName?: string
      /** Frame timestamp of the snapshot the counts came from — how FRESH the
       *  reading is, which is a different question from "now". */
      readonly observedAt: number
    }
  | { readonly kind: 'unavailable'; readonly reason: NcOccupancyProbeUnavailable }

export interface NcOccupancyProbeInput {
  readonly occupancy: NcOccupancyCondition
  readonly deviceId: number
  /** The camera's CURRENT occupancy snapshot; `null` when it has none. */
  readonly snapshot: CameraOccupancySnapshot | null
  /** The tester's clock. The probe stamps the subject with the SNAPSHOT's
   *  frame time (how fresh the reading is); `now` is carried for the caller's
   *  unavailable rows, where there is no frame to stamp. */
  readonly now: number
}

/** The prefix a probe's record id carries. A dry-run row is never mistakable
 *  for a committed edge (`occ:…`) in a log, a screenshot or a bug report. */
const PROBE_ID_PREFIX = 'dryrun:'

/**
 * Read one camera's live occupancy for one rule condition and synthesize the
 * subject the engine would see if that level were committed as an edge.
 *
 * The subject is built by {@link subjectFromOccupancyEvent} — the SAME builder
 * the live path uses — off a synthesized edge, so every field the engine reads
 * (scope, threshold, the occupied predicate) is derived exactly once.
 * `previousCount` is the honest exception: a single snapshot holds no previous
 * level, so it carries the current count and nothing matches on it.
 */
export function probeOccupancyNow(input: NcOccupancyProbeInput): NcOccupancyProbe {
  const { occupancy, deviceId, snapshot } = input
  if (snapshot === null) return { kind: 'unavailable', reason: 'no-snapshot' }
  const scope = {
    ...(occupancy.zoneId !== undefined ? { zoneId: occupancy.zoneId } : {}),
    ...(occupancy.className !== undefined ? { className: occupancy.className } : {}),
  }
  const resolved = resolveOccupancyScope(snapshot, scope)
  if (resolved === null) return { kind: 'unavailable', reason: 'zone-absent' }
  const threshold = occupancyThreshold(occupancy)
  const subject = subjectFromOccupancyEvent({
    deviceId,
    ...scope,
    ...(resolved.zoneName !== undefined ? { zoneName: resolved.zoneName } : {}),
    count: resolved.count,
    previousCount: resolved.count,
    occupied: resolved.count >= threshold,
    threshold,
    timestamp: snapshot.ts,
  })
  return {
    kind: 'probed',
    subject: { ...subject, recordId: `${PROBE_ID_PREFIX}${subject.recordId}` },
    count: resolved.count,
    threshold,
    ...(resolved.zoneName !== undefined ? { zoneName: resolved.zoneName } : {}),
    observedAt: snapshot.ts,
  }
}

/**
 * The one line the tester shows for a probe: the counts it evaluated, the level
 * it read, and what a LIVE fire additionally needs.
 *
 * It goes in `NcTestResult.label` because that is the field the result list
 * already renders; the counts have to travel somewhere, and inventing a schema
 * field for them would be a cross-package change for a sentence.
 */
export function occupancyProbeLabel(
  occupancy: NcOccupancyCondition,
  probe: NcOccupancyProbe,
  cooldownSec: number,
): string {
  const classNote = occupancyClassWarning(occupancy.className)
  if (probe.kind === 'unavailable') {
    const reason =
      probe.reason === 'no-snapshot'
        ? 'no ZoneAnalytics snapshot for this camera — the condition fails closed until one arrives'
        : 'that zone is not in the camera’s current snapshot — the condition fails closed (deleted zone?)'
    // The class fault is stated even here: a rule can be broken BOTH ways, and
    // fixing the snapshot would only reveal the second fault later.
    return classNote === null ? reason : `${classNote} · ${reason}`
  }
  const where =
    probe.zoneName ?? (occupancy.zoneId === undefined ? 'whole frame' : occupancy.zoneId)
  const what = occupancy.className ?? 'objects'
  const parts = [
    `${where}: ${String(probe.count)}/${String(probe.threshold)} ${what}`,
    probe.subject.occupancy?.occupied === true ? 'occupied now' : 'not occupied now',
    `fires on the transition, sustained ${String(occupancy.sustainSeconds)} s`,
  ]
  if (cooldownSec > 0) parts.push(`cooldown ${String(cooldownSec)} s`)
  // The note goes FIRST when there is one: a reading of 0 is not the headline
  // when the reason for the 0 is that the question is unanswerable.
  return classNote === null ? parts.join(' · ') : `${classNote} · ${parts.join(' · ')}`
}

/**
 * The one-clause warning for a class scope the snapshots can never key on, or
 * `null` when the scope is fine.
 *
 * The dry-run's whole job is to make "why does this rule never fire?" answerable
 * before the operator waits a night for it. A sub-type class produced the most
 * convincing wrong answer it can give — "0/1 car · not occupied now" — which is
 * pixel-identical to an empty parking space. `byClass` is MACRO-keyed, so that
 * counter is 0 structurally and no scene can change it.
 */
export function occupancyClassWarning(className: string | undefined): string | null {
  if (className === undefined || isDetectionMacroClass(className)) return null
  const macros = [...DETECTION_MACRO_CLASSES].join(' / ')
  return `⚠ “${className}” is a sub-type, not a macro class: this counter is always 0 (use ${macros})`
}
