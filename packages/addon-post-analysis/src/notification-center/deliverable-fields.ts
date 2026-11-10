/**
 * The dispatcher's half of #483: a notification is cut down to the fields the
 * target's KIND delivers before it is sent — the kind's declaration read through
 * `deliverableFields`, never a service name.
 *
 * Alexa declares a title and nothing else, so it speaks the title and joins
 * nothing to it. A target whose kind the catalog did not answer (`fields`
 * undefined) keeps everything: unknown is not "unsupported" (D315).
 *
 * A kind that delivers the title but not the body, handed a title that
 * rendered empty, is given the rendered body instead, cut to the title's
 * limit — a speaker must not say nothing (D1030).
 */
import {
  NC_TEMPLATE_TITLE_MAX_CHARS,
  type NotificationField,
  targetAttachmentAllows,
} from '@camstack/types'
import type { NcNotificationInput } from './dispatcher.js'
import type { NcOutboxTargetSettings } from './target-settings.js'

/** The notification to send, and the fields that were dropped from it (for the log line). */
export interface NcDeliverableNotification {
  readonly notification: NcNotificationInput
  readonly dropped: readonly NotificationField[]
  /** True when the title was empty and the body stood in for it. */
  readonly titleFromBody: boolean
  /**
   * What the target's OWN settings (D1031) took out of a delivery its kind
   * could otherwise carry: the media it did not ask for, the buttons it turned
   * off. Named on the delivery line so a missing picture has a reason.
   */
  readonly narrowed: readonly ('attachments' | 'actions')[]
}

/** The target's own settings, applied to what was built — before the kind's cut. */
function narrowedBySettings(
  notification: NcNotificationInput,
  settings: NcOutboxTargetSettings | undefined,
): {
  readonly notification: NcNotificationInput
  readonly narrowed: readonly ('attachments' | 'actions')[]
} {
  if (settings === undefined) return { notification, narrowed: [] }
  const narrowed: ('attachments' | 'actions')[] = []
  let next = notification
  const kept = (notification.attachments ?? []).filter((part) =>
    targetAttachmentAllows(settings.attachment, part.mediaType),
  )
  if (kept.length < (notification.attachments?.length ?? 0)) {
    narrowed.push('attachments')
    const { attachments: _all, ...rest } = next
    next = kept.length > 0 ? { ...rest, attachments: kept } : rest
  }
  if (settings.actions === false && (notification.actions?.length ?? 0) > 0) {
    narrowed.push('actions')
    const { actions: _all, ...rest } = next
    next = rest
  }
  return { notification: next, narrowed }
}

export function deliverableNotification(
  built: NcNotificationInput,
  fields: readonly NotificationField[] | undefined,
  settings?: NcOutboxTargetSettings,
): NcDeliverableNotification {
  const { notification, narrowed } = narrowedBySettings(built, settings)
  if (fields === undefined) return { notification, dropped: [], titleFromBody: false, narrowed }
  const has = (field: NotificationField): boolean => fields.includes(field)
  const dropped: NotificationField[] = []
  const note = (field: NotificationField, present: boolean): boolean => {
    if (!has(field) && present) dropped.push(field)
    return has(field)
  }
  const keepTitle = note('title', notification.title !== undefined)
  const keepBody = note('body', notification.body.length > 0)
  const keepAttachments = note('attachments', (notification.attachments?.length ?? 0) > 0)
  const keepActions = note('actions', (notification.actions?.length ?? 0) > 0)
  const keepPriority = note(
    'priority',
    notification.priority !== undefined || notification.level !== undefined,
  )
  const keepSound = note('sound', notification.sound !== undefined)
  const keepClickUrl = note('clickUrl', notification.clickUrl !== undefined)
  const {
    title: rendered,
    attachments,
    actions,
    priority,
    level,
    sound,
    clickUrl,
    body,
    ...rest
  } = notification
  const titleFromBody =
    keepTitle && !keepBody && (rendered ?? '').trim().length === 0 && body.trim().length > 0
  const title = titleFromBody ? body.trim().slice(0, NC_TEMPLATE_TITLE_MAX_CHARS) : rendered
  return {
    notification: {
      ...rest,
      // `body` is the one required field of the canonical message; a kind
      // that delivers none is handed an empty one.
      body: keepBody ? body : '',
      ...(keepTitle && title !== undefined ? { title } : {}),
      ...(keepAttachments && attachments !== undefined ? { attachments } : {}),
      ...(keepActions && actions !== undefined ? { actions } : {}),
      ...(keepPriority && priority !== undefined ? { priority } : {}),
      ...(keepPriority && level !== undefined ? { level } : {}),
      ...(keepSound && sound !== undefined ? { sound } : {}),
      ...(keepClickUrl && clickUrl !== undefined ? { clickUrl } : {}),
    },
    dropped,
    titleFromBody,
    narrowed,
  }
}
