/**
 * The per-member breakdown of a send to a notifier group (`SendResult.members`):
 * who got it, who was skipped and why, who failed and with what error.
 */
import type { GroupMemberOutcome, GroupSkipReason } from '@camstack/types'
import { useTranslation } from 'react-i18next'

interface SkipReasonLabel {
  readonly key: string
  readonly fallback: string
}

const SKIP_REASON_LABELS: Readonly<Record<GroupSkipReason, SkipReasonLabel>> = {
  'member-disabled': {
    key: 'system.notificationTestPanel.skipReason.memberDisabled',
    fallback: 'Switched off in the group',
  },
  'below-min-priority': {
    key: 'system.notificationTestPanel.skipReason.belowMinPriority',
    fallback: 'Priority below its minimum',
  },
  'schedule-inactive': {
    key: 'system.notificationTestPanel.skipReason.scheduleInactive',
    fallback: 'Outside its schedule',
  },
  'alarm-state': {
    key: 'system.notificationTestPanel.skipReason.alarmState',
    fallback: 'The alarm is not in one of its states',
  },
  'alarm-unreadable': {
    key: 'system.notificationTestPanel.skipReason.alarmUnreadable',
    fallback: 'The alarm state could not be read',
  },
  throttled: {
    key: 'system.notificationTestPanel.skipReason.throttled',
    fallback: 'Throttled: it received one too recently',
  },
  'already-delivered': {
    key: 'system.notificationTestPanel.skipReason.alreadyDelivered',
    fallback: 'Already received this notification',
  },
  'nested-group': {
    key: 'system.notificationTestPanel.skipReason.nestedGroup',
    fallback: 'A group cannot contain a group',
  },
  'unknown-target': {
    key: 'system.notificationTestPanel.skipReason.unknownTarget',
    fallback: 'The notifier no longer exists',
  },
  'target-disabled': {
    key: 'system.notificationTestPanel.skipReason.targetDisabled',
    fallback: 'The notifier is disabled',
  },
  'content-filter': {
    key: 'system.notificationTestPanel.skipReason.contentFilter',
    fallback: 'Its content filter does not include this event',
  },
  'escalation-not-needed': {
    key: 'system.notificationTestPanel.skipReason.escalationNotNeeded',
    fallback: 'Not needed: the member it backs up received it',
  },
}

interface NotificationGroupMemberOutcomesProps {
  readonly members: readonly GroupMemberOutcome[]
  /** Resolves a member's target id to its name; the id is shown when absent. */
  readonly targetName?: (targetId: string) => string
}

export function NotificationGroupMemberOutcomes({
  members,
  targetName,
}: NotificationGroupMemberOutcomesProps) {
  const { t } = useTranslation()
  if (members.length === 0) return null
  return (
    <ul className="mt-2 space-y-0.5 text-[11px]" data-testid="group-member-outcomes">
      {members.map((member) => (
        <li
          key={member.targetId}
          className="flex flex-wrap items-baseline gap-x-2"
          data-testid="group-member-outcome"
        >
          <span className="font-medium text-foreground">
            {targetName ? targetName(member.targetId) : member.targetId}
          </span>
          {member.status === 'sent' && (
            <span className="text-success">
              {t('system.notificationTestPanel.memberSent', 'Sent')}
            </span>
          )}
          {member.status === 'skipped' && (
            <>
              <span className="text-warning">
                {t('system.notificationTestPanel.memberSkipped', 'Skipped')}
              </span>
              <span className="text-foreground-subtle">
                {t(
                  SKIP_REASON_LABELS[member.reason].key,
                  SKIP_REASON_LABELS[member.reason].fallback,
                )}
              </span>
            </>
          )}
          {member.status === 'failed' && (
            <>
              <span className="text-danger">
                {t('system.notificationTestPanel.memberFailed', 'Failed')}
              </span>
              <span className="text-foreground-subtle">{member.error}</span>
            </>
          )}
        </li>
      ))}
    </ul>
  )
}
