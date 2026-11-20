/**
 * A notifier group: a notification target whose delivery is a fan-out to other targets (D1071).
 *
 * The group is an instance of `notification-output` of the record kind `notify-group`, owned by the
 * core builtin `core-notifier`. Its body holds a `members` list; each member is a target id plus the
 * policy that decides whether, and with what content, that member receives a notification.
 *
 * Everything here is pure: the schemas, the per-member decision, the content shaping and the union of
 * the members' capabilities. Delivery, the throttle and the retry ledger live in the builtin.
 */
import { z } from 'zod'
import { AlarmStateSchema } from '../capabilities/alarm-panel.cap.js'
import type { Notification } from '../interfaces/notification.js'
import {
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

/** Why a member got nothing: logged per member (D391) and shown by the test panel. */
export type GroupSkipReason =
  | 'member-disabled'
  | 'below-min-priority'
  | 'schedule-inactive'
  | 'alarm-state'
  | 'alarm-unreadable'
  | 'throttled'
  | 'already-delivered'
  | 'nested-group'
  | 'unknown-target'
  | 'target-disabled'

export type MemberDecision =
  | { readonly send: true }
  | { readonly send: false; readonly reason: GroupSkipReason }

export interface MemberDecisionInput {
  readonly member: GroupMember
  readonly notification: Notification
  readonly nowMs: number
  /** The alarm state read for an `alarm` member; `null` = the read failed. */
  readonly alarmState?: z.infer<typeof AlarmStateSchema> | null
}

/** The policy of one member that needs no state of the group: enabled, priority, schedule, alarm. */
export function decideMember(input: MemberDecisionInput): MemberDecision {
  const { member, notification, nowMs } = input
  if (member.enabled === false) return { send: false, reason: 'member-disabled' }
  if (member.minPriority !== undefined && notification.priority < member.minPriority) {
    return { send: false, reason: 'below-min-priority' }
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
 * What a group delivers: the union of what its members deliver (D1030), so the notification center
 * does not strip a field a member needs. No members = title and body.
 */
export function unionTargetKindCaps(list: readonly TargetKindCaps[]): TargetKindCaps {
  const levels = new Map<string, TargetKindCaps['levels'][number]>()
  for (const caps of list) for (const level of caps.levels) levels.set(level.id, level)
  const mediaTypes = new Set(list.flatMap((caps) => caps.attachments.mediaTypes))
  const modes = new Set(list.map((caps) => caps.attachments.mode))
  const withAttachments = list.filter((caps) => caps.attachments.max > 0)
  const maxBytes = withAttachments
    .map((caps) => caps.attachments.maxBytes)
    .filter((bytes): bytes is number => bytes !== undefined)
  return {
    text: {
      title: list.length === 0 || list.some((caps) => caps.text?.title ?? true),
      body: list.length === 0 || list.some((caps) => caps.text?.body ?? true),
    },
    attachments: {
      mediaTypes: [...mediaTypes],
      mode: modes.size > 1 || modes.has('both') ? 'both' : (list[0]?.attachments.mode ?? 'url'),
      max: Math.max(0, ...list.map((caps) => caps.attachments.max)),
      ...(maxBytes.length > 0 ? { maxBytes: Math.max(...maxBytes) } : {}),
    },
    actions: Math.max(0, ...list.map((caps) => caps.actions)),
    actionIcons: list.some((caps) => caps.actionIcons === true),
    levels: [...levels.values()],
    format: [...new Set(list.flatMap((caps) => caps.format)).add('text')],
    clickUrl: list.some((caps) => caps.clickUrl),
    sound: list.some((caps) => caps.sound),
    ttl: list.some((caps) => caps.ttl),
    bodyMaxLen: Math.max(1, ...list.map((caps) => caps.bodyMaxLen)),
  }
}

/**
 * The notification as ONE member's own kind can take it: its text fields, body length, attachment
 * media types and count, action count, sound and click URL. The group's union caps only keep the
 * notification center from stripping a field before the group sees it; a member gets its own limits.
 */
export function clampToCaps(notification: Notification, caps: TargetKindCaps): Notification {
  const { attachments, actions, sound, clickUrl, ...rest } = notification
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
    ...(caps.sound && sound !== undefined ? { sound } : {}),
    ...(caps.clickUrl && clickUrl !== undefined ? { clickUrl } : {}),
  }
}
