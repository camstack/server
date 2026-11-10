/**
 * Which message fields a notification target can deliver (#483) — the ONE
 * reading of a kind's capability declaration (`TargetKind.caps`).
 *
 * The notifier declares; nobody else names a service. The dispatcher drops
 * what a target cannot deliver, the admin rule editor shows only what the
 * selected targets can deliver, and the viewer reads the same function — so
 * the three cannot disagree about which fields exist for a target.
 */
import type { NotificationField, TargetKindCaps } from '../capabilities/notification-output.cap.js'
import type { NcTargetOverride } from '../capabilities/notification-rules.cap.js'

/** Every field, in the order an editor meets them. */
export const NOTIFICATION_FIELDS: readonly NotificationField[] = [
  'title',
  'body',
  'attachments',
  'actions',
  'priority',
  'sound',
  'clickUrl',
]

/**
 * The fields a kind delivers, derived from its caps:
 *  - `title` / `body` — `caps.text`; absent = both (every kind declared before #483);
 *  - `attachments` — at least one slot and one media type;
 *  - `actions` — at least one button;
 *  - `priority` — at least two DISTINCT ordinals to choose between (one level
 *    means the priority changes nothing on that kind);
 *  - `sound`, `clickUrl` — their flags.
 */
export function deliverableFields(caps: TargetKindCaps): readonly NotificationField[] {
  const ordinals = new Set(
    caps.levels.map((level) => level.ordinal).filter((ordinal) => ordinal !== null),
  )
  const supported: Readonly<Record<NotificationField, boolean>> = {
    title: caps.text?.title ?? true,
    body: caps.text?.body ?? true,
    attachments: caps.attachments.max > 0 && caps.attachments.mediaTypes.length > 0,
    actions: caps.actions > 0,
    priority: ordinals.size >= 2,
    sound: caps.sound,
    clickUrl: caps.clickUrl,
  }
  return NOTIFICATION_FIELDS.filter((field) => supported[field])
}

/** One selected target as a field-support question sees it. */
export interface NotificationFieldTarget {
  readonly name: string
  /** `undefined` = the kind catalog did not answer: UNKNOWN, read as "delivers everything". */
  readonly fields: readonly NotificationField[] | undefined
}

/** Whether an editor shows a field, and which selected targets drop it. */
export interface NotificationFieldSupport {
  readonly field: NotificationField
  /** At least one selected target delivers it — or nothing is selected, or a kind is unknown. */
  readonly shown: boolean
  /** Names of the selected targets KNOWN not to deliver it (the per-field hint). */
  readonly droppedBy: readonly string[]
}

/**
 * The union of what the selected targets deliver, with the targets that drop
 * each field. No selection shows every field: a rule that addresses only users
 * (or nobody yet) has no declaration to narrow on, and not-yet-known must never
 * look like not-supported (D315).
 */
export function fieldSupportForTargets(
  targets: readonly NotificationFieldTarget[],
): readonly NotificationFieldSupport[] {
  return NOTIFICATION_FIELDS.map((field) => {
    const droppedBy = targets
      .filter((target) => target.fields !== undefined && !target.fields.includes(field))
      .map((target) => target.name)
    return {
      field,
      shown: targets.length === 0 || droppedBy.length < targets.length,
      droppedBy,
    }
  })
}

/**
 * A target override with every field the target cannot deliver removed — what
 * an editor may store. `fields` undefined (unknown kind) keeps everything; the
 * dispatcher still drops at send what the kind turns out not to deliver.
 * `undefined` when nothing is left, so an empty override is never stored.
 */
export function sanitizeTargetOverride(
  override: NcTargetOverride,
  fields: readonly NotificationField[] | undefined,
): NcTargetOverride | undefined {
  const has = (field: NotificationField): boolean => fields === undefined || fields.includes(field)
  const title = has('title') ? nonEmpty(override.template?.title) : undefined
  const body = has('body') ? nonEmpty(override.template?.body) : undefined
  const template =
    title !== undefined || body !== undefined
      ? { ...(title !== undefined ? { title } : {}), ...(body !== undefined ? { body } : {}) }
      : undefined
  const priority = has('priority') ? override.priority : undefined
  const next: NcTargetOverride = {
    ...(template !== undefined ? { template } : {}),
    ...(override.schedule !== undefined && override.schedule.windows.length > 0
      ? { schedule: override.schedule }
      : {}),
    ...(priority !== undefined ? { priority } : {}),
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  return trimmed === undefined || trimmed.length === 0 ? undefined : trimmed
}
