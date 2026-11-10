/**
 * The dispatcher's half of #483: a notification is cut down to the fields the
 * target's KIND delivers before it is sent — the kind's declaration read through
 * `deliverableFields`, never a service name.
 *
 * Alexa declares a title and nothing else, so it speaks the title and joins
 * nothing to it. A target whose kind the catalog did not answer (`fields`
 * undefined) keeps everything: unknown is not "unsupported" (D315).
 */
import type { NotificationField } from '@camstack/types'
import type { NcNotificationInput } from './dispatcher.js'

/** The notification to send, and the fields that were dropped from it (for the log line). */
export interface NcDeliverableNotification {
  readonly notification: NcNotificationInput
  readonly dropped: readonly NotificationField[]
}

export function deliverableNotification(
  notification: NcNotificationInput,
  fields: readonly NotificationField[] | undefined,
): NcDeliverableNotification {
  if (fields === undefined) return { notification, dropped: [] }
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
  const { title, attachments, actions, priority, level, sound, clickUrl, body, ...rest } =
    notification
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
  }
}
