/**
 * The pure side of the notifier-group member editor (D1071): reading and writing the `members`
 * rows of a group form, which targets may be picked, and the "what this member receives" line.
 * The shaping itself is the server's own `shapeForMember`, so the preview cannot drift from delivery.
 */
import {
  groupMembersOf,
  NOTIFIER_GROUP_KIND,
  NotificationEventKindSchema,
  NotificationFieldSchema,
  shapeForMember,
  type GroupMember,
  type GroupMemberFilter,
  type GroupMemberWhen,
  type NotificationEventKind,
  type NotificationField,
  type Target,
  type TargetKind,
} from '@dominevo/types'

export const MEMBERS_KEY = 'members'

/** Every field a member can be limited to, in the order the editor lists them. */
export const MEMBER_FIELDS: readonly NotificationField[] = NotificationFieldSchema.options

export const PRIORITY_LEVELS: readonly number[] = [1, 2, 3, 4, 5]

/** The sample the preview line renders: what a real notification would carry. */
export const PREVIEW_SAMPLE = {
  title: 'Person at the front door',
  body: 'A person was seen on Front door',
  priority: 4,
} as const

/** The members of a form's values; rows the schema cannot read are counted, never shown. */
export function readMembers(values: Readonly<Record<string, unknown>>): {
  readonly members: readonly GroupMember[]
  readonly invalid: number
} {
  return groupMembersOf(values)
}

export function withMembers(
  values: Record<string, unknown>,
  members: readonly GroupMember[],
): Record<string, unknown> {
  return { ...values, [MEMBERS_KEY]: members }
}

/** A target a group may hold: anything but another group (nesting is never delivered). */
export function isPickableTarget(target: Pick<Target, 'kind'>): boolean {
  return target.kind !== NOTIFIER_GROUP_KIND
}

/** The targets still free to add that match the search (name or kind), pickable ones only. */
export function pickCandidates(
  targets: readonly Target[],
  members: readonly GroupMember[],
  query: string,
): readonly Target[] {
  const taken = new Set(members.map((m) => m.targetId))
  const needle = query.trim().toLowerCase()
  return targets.filter(
    (t) =>
      isPickableTarget(t) &&
      !taken.has(t.id) &&
      (needle === '' ||
        t.name.toLowerCase().includes(needle) ||
        t.kind.toLowerCase().includes(needle)),
  )
}

/** The member without one of its optional keys (an absent key means "no restriction"). */
export function withoutKey<K extends Exclude<keyof GroupMember, 'targetId'>>(
  member: GroupMember,
  key: K,
): GroupMember {
  const copy: GroupMember = { ...member }
  delete copy[key]
  return copy
}

/** A weekday-office schedule: the starting point when a member is switched to "schedule". */
export const DEFAULT_SCHEDULE: GroupMemberWhen = {
  kind: 'schedule',
  schedule: {
    windows: [{ days: [1, 2, 3, 4, 5], startMinute: 540, endMinute: 1080 }],
  },
}

/** The lines the preview shows: the title and body this member would get, or that it gets nothing. */
export function previewOf(member: GroupMember): {
  readonly title: string
  readonly body: string
} {
  const shaped = shapeForMember(member, { ...PREVIEW_SAMPLE, format: 'text' })
  return { title: shaped.title ?? '', body: shaped.body }
}

/**
 * The human label of a target's kind from the kind catalogue (the one the targets list reads), matched
 * on kind AND providing addon. A catalogue that has not answered, or has no such kind, falls back to
 * the raw kind id rather than to nothing.
 */
export type KindLabelSource = Pick<TargetKind, 'kind' | 'label' | 'addonId'>

export function kindLabelOf(
  kinds: readonly KindLabelSource[] | undefined,
  target: Pick<Target, 'kind' | 'addonId'>,
): string {
  const match = kinds?.find((k) => k.kind === target.kind && k.addonId === target.addonId)
  return match?.label ?? target.kind
}

/** The event kinds a member's content filter can name, in the order the editor lists them. */
export const MEMBER_EVENT_KINDS: readonly NotificationEventKind[] =
  NotificationEventKindSchema.options

/** The event kinds a member does NOT receive (none when it has no kind filter). */
export function eventKindsOff(member: GroupMember): ReadonlySet<string> {
  const kept = member.filter?.eventKinds
  return new Set(kept === undefined ? [] : MEMBER_EVENT_KINDS.filter((k) => !kept.includes(k)))
}

function withFilter(member: GroupMember, filter: GroupMemberFilter): GroupMember {
  return filter.eventKinds === undefined && filter.classes === undefined
    ? withoutKey(member, 'filter')
    : { ...member, filter }
}

/** The member receiving only `kept` kinds; every kind (or none) kept means no kind filter. */
export function withEventKinds(
  member: GroupMember,
  kept: readonly NotificationEventKind[],
): GroupMember {
  const { eventKinds: _dropped, ...rest } = member.filter ?? {}
  const all = kept.length === 0 || kept.length === MEMBER_EVENT_KINDS.length
  return withFilter(member, all ? rest : { ...rest, eventKinds: [...kept] })
}

/** The class filter as the operator types it: names separated by commas. */
export function classesText(member: GroupMember): string {
  return (member.filter?.classes ?? []).join(', ')
}

/** The member receiving only the classes typed in `text`; an empty text means no class filter. */
export function withClassesText(member: GroupMember, text: string): GroupMember {
  const classes = text
    .split(',')
    .map((name) => name.trim())
    .filter((name) => name !== '')
  const { classes: _dropped, ...rest } = member.filter ?? {}
  return withFilter(member, classes.length === 0 ? rest : { ...rest, classes })
}

/** The members a member can be a fallback for: the ones listed before it. */
export function fallbackChoices(
  members: readonly GroupMember[],
  targetId: string,
): readonly GroupMember[] {
  const index = members.findIndex((m) => m.targetId === targetId)
  return index <= 0 ? [] : members.slice(0, index)
}

/** The member as a fallback for `primaryId`, or always delivered when it is undefined. */
export function withFallbackFor(member: GroupMember, primaryId: string | undefined): GroupMember {
  return primaryId === undefined
    ? withoutKey(member, 'onlyIfUndelivered')
    : { ...member, onlyIfUndelivered: [primaryId] }
}

/** The list without a member, and without any fallback rule that named it. */
export function withoutMember(
  members: readonly GroupMember[],
  targetId: string,
): readonly GroupMember[] {
  return members
    .filter((m) => m.targetId !== targetId)
    .map((m) => {
      if (m.onlyIfUndelivered === undefined || !m.onlyIfUndelivered.includes(targetId)) return m
      const rest = m.onlyIfUndelivered.filter((id) => id !== targetId)
      return rest.length === 0
        ? withoutKey(m, 'onlyIfUndelivered')
        : { ...m, onlyIfUndelivered: rest }
    })
}
