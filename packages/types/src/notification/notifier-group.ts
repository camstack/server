/**
 * A notifier group: a notification target whose delivery is a fan-out to other targets (D1071).
 *
 * The group is an instance of `notification-output` of the record kind `notify-group`, owned by the
 * core builtin `core-notifier`. Its body holds a `members` list; each member is a target id plus the
 * policy that decides whether, and with what content, that member receives a notification.
 *
 * Everything here is pure: the schemas, the per-member decision, the content shaping and the clamp to a
 * member's own capabilities. Delivery, the throttle and the retry ledger live in the builtin.
 */
import { z } from 'zod'
import { AlarmStateSchema } from '../capabilities/alarm-panel.cap.js'
import type { Notification } from '../interfaces/notification.js'
import {
  type GroupMemberOutcome,
  type GroupSkipReason,
  type NotificationField,
  NotificationFieldSchema,
  type TargetKindCaps,
} from '../capabilities/notification-output.cap.js'
import { NcScheduleSchema } from '../capabilities/notification-rules.cap.js'
import { isScheduleActive } from './schedule.js'

/** The target kind a group is. */
export const NOTIFIER_GROUP_KIND = 'group'

/** The core builtin that owns groups. */
export const NOTIFIER_GROUP_ADDON_ID = 'core-notifier'

/** When a member receives: always, inside a schedule, or while an alarm panel is in a state. */
export const GroupMemberWhenSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('always') }),
  z.object({ kind: z.literal('schedule'), schedule: NcScheduleSchema }),
  z.object({
    kind: z.literal('alarm'),
    deviceId: z.number().int().nonnegative(),
    states: z.array(AlarmStateSchema).min(1),
  }),
])
export type GroupMemberWhen = z.infer<typeof GroupMemberWhenSchema>

/** The `metadata` key a sender stamps with the kind of event behind a notification. */
export const NOTIFICATION_META_EVENT_KIND = 'eventKind'

/** The `metadata` key a sender stamps with the detected class (person, car, ...) of a notification. */
export const NOTIFICATION_META_CLASS_NAME = 'className'

/** The `metadata` key a sender stamps with the rule that produced a notification. */
export const NOTIFICATION_META_RULE_ID = 'ruleId'

/** What kind of event a notification is about, as a member's content filter names it. */
export const NotificationEventKindSchema = z.enum([
  'detection',
  'audio',
  'device-event',
  'occupancy',
  'package',
  'appliance',
  'system-event',
  'timelapse',
  'summary',
  'calendar',
])
export type NotificationEventKind = z.infer<typeof NotificationEventKindSchema>

/**
 * Which notifications a member receives by content. Each list that is set must match; a
 * notification that does not carry the value (no event kind, no class) does not match it.
 */
export const GroupMemberFilterSchema = z.object({
  eventKinds: z.array(NotificationEventKindSchema).min(1).optional(),
  /** Detected classes, compared without case. */
  classes: z.array(z.string().min(1)).min(1).optional(),
})
export type GroupMemberFilter = z.infer<typeof GroupMemberFilterSchema>

/**
 * One member's policy. Every key but `targetId` is optional and means "no restriction" when absent
 * (never a Zod default: a default does not run on the addon cap path).
 */
export const GroupMemberSchema = z.object({
  targetId: z.string().min(1),
  enabled: z.boolean().optional(),
  when: GroupMemberWhenSchema.optional(),
  /** Which message fields this member receives. Absent = all of them. */
  fields: z.array(NotificationFieldSchema).optional(),
  /** `{{title}}`, `{{body}}`, `{{priority}}` and any `{{key}}` of the notification's metadata. */
  templates: z.object({ title: z.string().optional(), body: z.string().optional() }).optional(),
  minPriority: z.number().int().min(1).max(5).optional(),
  /** At most one delivery per window; a burst becomes one. 0 or absent = no throttle. */
  throttleSec: z.number().int().nonnegative().optional(),
  /** Receives only the notifications of these event kinds / classes. Absent = all of them. */
  filter: GroupMemberFilterSchema.optional(),
  /**
   * Escalation: the target ids of other members of this group. This member is tried only when
   * NONE of them was delivered in the same send (each failed or was skipped). Absent = always tried.
   */
  onlyIfUndelivered: z.array(z.string().min(1)).min(1).optional(),
})
export type GroupMember = z.infer<typeof GroupMemberSchema>

/** The members a group's config holds, and how many rows could not be read. */
export interface GroupMembersRead {
  readonly members: readonly GroupMember[]
  readonly invalid: number
}

/** Read the `members` of a group's config; an unreadable row is counted, never silently dropped. */
export function groupMembersOf(config: Readonly<Record<string, unknown>>): GroupMembersRead {
  const rows = config['members']
  if (!Array.isArray(rows)) return { members: [], invalid: 0 }
  const members: GroupMember[] = []
  let invalid = 0
  for (const row of rows) {
    const parsed = GroupMemberSchema.safeParse(row)
    if (parsed.success) members.push(parsed.data)
    else invalid += 1
  }
  return { members, invalid }
}

export type MemberDecision =
  | { readonly send: true }
  | { readonly send: false; readonly reason: GroupSkipReason }

export interface MemberDecisionInput {
  readonly member: GroupMember
  readonly notification: Notification
  readonly nowMs: number
  /** The alarm state read for an `alarm` member; `null` = the read failed. */
  readonly alarmState?: z.infer<typeof AlarmStateSchema> | null
  /** A test press carries no event: the content filter is not applied to it. */
  readonly ignoreFilter?: boolean
}

/** Whether a notification is one the filter names: every list that is set must match. */
export function matchesMemberFilter(
  filter: GroupMemberFilter,
  notification: Notification,
): boolean {
  const kind = notification.metadata?.[NOTIFICATION_META_EVENT_KIND]
  if (filter.eventKinds !== undefined) {
    const parsed = NotificationEventKindSchema.safeParse(kind)
    if (!parsed.success || !filter.eventKinds.includes(parsed.data)) return false
  }
  if (filter.classes !== undefined) {
    const className = notification.metadata?.[NOTIFICATION_META_CLASS_NAME]
    if (typeof className !== 'string') return false
    const wanted = className.toLowerCase()
    if (!filter.classes.some((name) => name.toLowerCase() === wanted)) return false
  }
  return true
}

/**
 * Whether a fallback member is needed: none of the members it backs up was delivered. A member
 * skipped as `already-delivered` got this notification on an earlier attempt, so it counts as
 * delivered; one with no outcome yet (listed later, or not in the group) counts as not delivered.
 */
export function escalationNeeded(
  member: GroupMember,
  outcomes: readonly GroupMemberOutcome[],
): boolean {
  if (member.onlyIfUndelivered === undefined) return true
  const delivered = new Set(
    outcomes
      .filter(
        (outcome) =>
          outcome.status === 'sent' ||
          (outcome.status === 'skipped' && outcome.reason === 'already-delivered'),
      )
      .map((outcome) => outcome.targetId),
  )
  return !member.onlyIfUndelivered.some((targetId) => delivered.has(targetId))
}

/** The policy of one member that needs no state of the group: enabled, priority, schedule, alarm. */
export function decideMember(input: MemberDecisionInput): MemberDecision {
  const { member, notification, nowMs } = input
  if (member.enabled === false) return { send: false, reason: 'member-disabled' }
  if (member.minPriority !== undefined && notification.priority < member.minPriority) {
    return { send: false, reason: 'below-min-priority' }
  }
  if (
    member.filter !== undefined &&
    input.ignoreFilter !== true &&
    !matchesMemberFilter(member.filter, notification)
  ) {
    return { send: false, reason: 'content-filter' }
  }
  const when = member.when
  if (when?.kind === 'schedule' && !isScheduleActive(when.schedule, nowMs)) {
    return { send: false, reason: 'schedule-inactive' }
  }
  if (when?.kind === 'alarm') {
    if (input.alarmState === undefined || input.alarmState === null) {
      return { send: false, reason: 'alarm-unreadable' }
    }
    if (!when.states.includes(input.alarmState)) return { send: false, reason: 'alarm-state' }
  }
  return { send: true }
}

/** `{{name}}` filled from the notification; an unknown name is empty. */
export function renderMemberTemplate(template: string, notification: Notification): string {
  return template.replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (_match, name: string) => {
    if (name === 'title') return notification.title ?? ''
    if (name === 'body') return notification.body
    if (name === 'priority') return String(notification.priority)
    const value = notification.metadata?.[name]
    return typeof value === 'string' || typeof value === 'number' ? String(value) : ''
  })
}

/** The notification as this member should receive it: its templates applied, its fields kept. */
export function shapeForMember(member: GroupMember, notification: Notification): Notification {
  const keep = (field: NotificationField): boolean =>
    member.fields === undefined || member.fields.includes(field)
  const title =
    member.templates?.title !== undefined
      ? renderMemberTemplate(member.templates.title, notification)
      : notification.title
  const body =
    member.templates?.body !== undefined
      ? renderMemberTemplate(member.templates.body, notification)
      : notification.body
  const { attachments, actions, sound, clickUrl, ...rest } = notification
  return {
    ...rest,
    body: keep('body') ? body : '',
    ...(keep('title') && title !== undefined ? { title } : { title: undefined }),
    priority: keep('priority') ? notification.priority : 3,
    ...(keep('attachments') && attachments !== undefined ? { attachments } : {}),
    ...(keep('actions') && actions !== undefined ? { actions } : {}),
    ...(keep('sound') && sound !== undefined ? { sound } : {}),
    ...(keep('clickUrl') && clickUrl !== undefined ? { clickUrl } : {}),
  }
}

/**
 * The notification as ONE member's own kind can take it: its text fields, body length, attachment
 * media types and count, action count, level, sound and click URL. The group's own caps are permissive and only keep the
 * notification center from stripping a field before the group sees it; a member gets its own limits.
 */
export function clampToCaps(notification: Notification, caps: TargetKindCaps): Notification {
  const { attachments, actions, sound, clickUrl, level, ...rest } = notification
  const kept = (attachments ?? [])
    .filter((attachment) => caps.attachments.mediaTypes.includes(attachment.mediaType))
    .slice(0, caps.attachments.max)
  const buttons = (actions ?? []).slice(0, caps.actions)
  return {
    ...rest,
    body: caps.text?.body === false ? '' : notification.body.slice(0, caps.bodyMaxLen),
    ...(caps.text?.title === false || notification.title === undefined
      ? { title: undefined }
      : { title: notification.title }),
    ...(kept.length > 0 ? { attachments: kept } : {}),
    ...(buttons.length > 0 ? { actions: buttons } : {}),
    ...(level !== undefined && caps.levels.some((known) => known.id === level) ? { level } : {}),
    ...(caps.sound && sound !== undefined ? { sound } : {}),
    ...(caps.clickUrl && clickUrl !== undefined ? { clickUrl } : {}),
  }
}
