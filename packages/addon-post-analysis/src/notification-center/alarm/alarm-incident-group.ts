/**
 * The alarm INCIDENT as a grouped window (D705) — so the triggered notification
 * carries a mosaic of every subject that pressed the panel, through the ONE
 * mosaic path D692 built for grouped detection rules.
 *
 * Nothing here composes a picture. The combined `alarm-triggered` row already
 * takes the triggering rule's media policy and owners (D126); this module only
 * writes the row's `group` — the same v2 shape a grouped close writes — from the
 * source and the followers the panel collected during its entry delay. The
 * dispatcher then reads that group exactly as it reads a grouped detection row:
 * one tile per member, at most `NC_GROUPED_MOSAIC_MAX_TILES`, one shared still
 * wait, a member that never lands left out and named, a single landed tile
 * shipped as the plain still.
 *
 *  - The WINDOW is the entry delay: it opens at the source's match and closes when
 *    the alarm triggers (`closeReason: 'deadline'`). No wait is added to that notification.
 *  - A MEMBER is a fire ref with a media owner (`trackId` — a detection track, or
 *    a sensor's linked-camera still on the shelf). A match with none (a sensor
 *    nobody photographs) has no tile and is not a member.
 *  - Fewer than two members ⇒ no group: the row is byte-identical to D126's.
 *  - Order is ARRIVAL order, source first: the sentence names the source, and the
 *    first tile must be the picture of what set the alarm off.
 */
import type { NcOutboxGroupMemberV2, NcOutboxGroupV2 } from '../grouped/grouped-payload.js'
import type { NcRuleFireRef, NcSystemEventSubject } from '../rule-engine.js'

/** The class a member without one carries — the outbox row's own filler. */
const NC_ALARM_MEMBER_FALLBACK_CLASS = 'event'

/** The part of a system event the incident is read from. */
export type NcAlarmIncidentSubject = Pick<
  NcSystemEventSubject,
  'kind' | 'subject' | 'alarmSource' | 'alarmFollowers'
>

function memberOf(ref: NcRuleFireRef, trackId: string): NcOutboxGroupMemberV2 {
  return {
    trackId,
    className: ref.className ?? NC_ALARM_MEMBER_FALLBACK_CLASS,
    ...(ref.label !== undefined ? { label: ref.label } : {}),
    // D694: an event id is a reusable rowid — the tile reads THIS match's
    // generation (its camera and its record's instant), never the source's.
    ...(ref.eventId !== undefined
      ? { eventId: ref.eventId, eventDeviceId: ref.deviceId, eventAt: ref.timestamp }
      : {}),
    triggerAt: ref.timestamp,
  }
}

/**
 * The members of the incident: source first, then the followers in arrival
 * order, each subject once (a track, or a shelf owner, appears once).
 */
function alarmIncidentMembers(
  source: NcRuleFireRef,
  followers: readonly NcRuleFireRef[],
): readonly NcOutboxGroupMemberV2[] {
  const seen = new Set<string>()
  const members: NcOutboxGroupMemberV2[] = []
  for (const ref of [source, ...followers]) {
    const trackId = ref.trackId
    if (trackId === undefined || seen.has(trackId)) continue
    seen.add(trackId)
    members.push(memberOf(ref, trackId))
  }
  return members
}

/**
 * The group a combined alarm row carries, or `undefined` when the row is not a
 * mosaic: not a triggered alarm, no source, or fewer than two members with a picture.
 * `closedAt` is the trigger instant (the subject's timestamp).
 */
export function alarmIncidentGroup(
  systemEvent: NcAlarmIncidentSubject,
  closedAt: number,
): NcOutboxGroupV2 | undefined {
  if (systemEvent.kind !== 'alarm-triggered') return undefined
  const source = systemEvent.alarmSource
  const followers = systemEvent.alarmFollowers
  if (source === undefined || followers === undefined || followers.length === 0) return undefined
  const members = alarmIncidentMembers(source, followers)
  if (members.length < 2) return undefined
  return {
    version: 2,
    // A label for the lines that name the message — never a dedup key or a push tag.
    key: `${systemEvent.subject}@${String(source.timestamp)}`,
    openedAt: source.timestamp,
    closedAt,
    closeReason: 'deadline',
    members,
  }
}
