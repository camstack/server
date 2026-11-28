/**
 * What a notification is ABOUT, as the `metadata` every delivery carries: the rule that produced it,
 * the kind of event behind it and, for a detection, its class. A notifier group reads these to route
 * a member by content and to keep two rules on one event apart; a member template can print them.
 */
import {
  NOTIFICATION_META_CLASS_NAME,
  NOTIFICATION_META_EVENT_KIND,
  NOTIFICATION_META_RULE_ID,
  type NotificationEventKind,
} from '@dominevo/types'
import type { NcOutboxEntry } from './outbox.js'

/** The event kind of an outbox row, from the delivery it was enqueued under and what its subject holds. */
export function eventKindOf(entry: NcOutboxEntry): NotificationEventKind {
  const { delivery, subject } = entry.payload
  if (delivery === 'system-event' || subject.systemEvent !== undefined) return 'system-event'
  if (delivery === 'timelapse') return 'timelapse'
  if (delivery === 'ai-summary') return 'summary'
  if (delivery === 'calendar-events') return 'calendar'
  if (delivery === 'package-event' || subject.packagePhase !== undefined) return 'package'
  if (subject.applianceCycle !== undefined) return 'appliance'
  if (subject.occupancy !== undefined) return 'occupancy'
  if (subject.audio !== undefined) return 'audio'
  if (delivery === 'device-event') return 'device-event'
  return 'detection'
}

/** The content keys of one row's notification. The class is carried only for a detection or a sound. */
export function contentMetadataOf(entry: NcOutboxEntry): Readonly<Record<string, string>> {
  const kind = eventKindOf(entry)
  const className = entry.payload.subject.className
  const classed = (kind === 'detection' || kind === 'audio') && className !== ''
  return {
    [NOTIFICATION_META_RULE_ID]: entry.ruleId,
    [NOTIFICATION_META_EVENT_KIND]: kind,
    ...(classed ? { [NOTIFICATION_META_CLASS_NAME]: className } : {}),
  }
}
