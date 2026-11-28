/**
 * `notifier/group-members` — the member editor of a notifier group (D1071): a search over the other
 * notification targets and one policy card per member. It owns the form's `members` key; groups are
 * never offered, and a target the hub no longer lists stays visible so the operator can remove it.
 */
import type { Target } from '@dominevo/types'
import { Button, EmptyState, Input, Skeleton } from '@dominevo/ui-library'
import { Plus, Search } from 'lucide-react'
import { useState, type ReactElement } from 'react'
import { useTranslation } from 'react-i18next'
import { useNotificationTargets } from '../../pages/system/use-notification-targets'
import type { KindWidgetProps } from '../instances/kind-widgets'
import { GroupMemberCard } from './GroupMemberCard'
import {
  fallbackChoices,
  kindLabelOf,
  MEMBERS_KEY,
  pickCandidates,
  readMembers,
  withMembers,
  withoutMember,
} from './group-members-model'
import { useTargetKinds } from './use-target-kinds'

export const GROUP_MEMBERS_WIDGET_ID = 'notifier/group-members'

const MAX_CANDIDATES = 6

export function groupMembersOwnedKeys(): readonly string[] {
  return [MEMBERS_KEY]
}

export function GroupMembersWidget({ values, onValuesChange }: KindWidgetProps): ReactElement {
  const { t } = useTranslation()
  const targets = useNotificationTargets()
  const kinds = useTargetKinds()
  const [query, setQuery] = useState('')
  const [fresh, setFresh] = useState<ReadonlySet<string>>(new Set())
  const { members, invalid } = readMembers(values)
  const byId = new Map<string, Target>((targets.data ?? []).map((target) => [target.id, target]))
  const candidates = pickCandidates(targets.data ?? [], members, query).slice(0, MAX_CANDIDATES)

  const add = (target: Target): void => {
    onValuesChange(withMembers(values, [...members, { targetId: target.id }]))
    setFresh(new Set([...fresh, target.id]))
    setQuery('')
  }

  return (
    <div className="space-y-2" data-testid="group-members">
      <p className="text-xs font-medium text-foreground-muted">
        {t('notifierGroup.members', 'Members')} ({members.length})
      </p>
      {invalid > 0 && (
        <p className="text-xs text-danger">
          {t(
            'notifierGroup.invalidRows',
            '{{count}} saved member(s) could not be read and are left out.',
            {
              count: invalid,
            },
          )}
        </p>
      )}
      {members.length === 0 ? (
        <EmptyState
          title={t('notifierGroup.emptyTitle', 'No members yet')}
          description={t(
            'notifierGroup.emptyHint',
            'Search a notifier below to add it to this group.',
          )}
        />
      ) : (
        <div className="space-y-2">
          {members.map((member) => {
            const target = byId.get(member.targetId)
            return (
              <GroupMemberCard
                key={member.targetId}
                member={member}
                name={target?.name ?? member.targetId}
                kindLabel={target === undefined ? '' : kindLabelOf(kinds.data, target)}
                known={target !== undefined || targets.data === undefined}
                defaultOpen={fresh.has(member.targetId)}
                fallbackChoices={fallbackChoices(members, member.targetId).map((m) => ({
                  targetId: m.targetId,
                  name: byId.get(m.targetId)?.name ?? m.targetId,
                }))}
                onChange={(next) =>
                  onValuesChange(
                    withMembers(
                      values,
                      members.map((m) => (m.targetId === member.targetId ? next : m)),
                    ),
                  )
                }
                onRemove={() =>
                  onValuesChange(withMembers(values, withoutMember(members, member.targetId)))
                }
              />
            )
          })}
        </div>
      )}
      <div className="space-y-1">
        <div className="relative">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
          <Input
            className="pl-7"
            value={query}
            placeholder={t('notifierGroup.search', 'Search notifiers to add')}
            aria-label={t('notifierGroup.search', 'Search notifiers to add')}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        {targets.data === undefined ? (
          <Skeleton className="h-8 w-full" />
        ) : candidates.length === 0 ? (
          <p className="text-xs text-foreground-subtle">
            {t(
              'notifierGroup.noCandidates',
              'No other notifier matches. Groups cannot be members.',
            )}
          </p>
        ) : (
          <ul className="space-y-1">
            {candidates.map((target) => (
              <li
                key={target.id}
                className="flex items-center gap-2 rounded-md border border-border-subtle px-2 py-1"
              >
                <span className="min-w-0 flex-1 truncate text-sm text-foreground">
                  {target.name}
                </span>
                <span className="text-xs text-foreground-muted">
                  {kindLabelOf(kinds.data, target)}
                </span>
                <Button size="sm" variant="ghost" onClick={() => add(target)}>
                  <Plus className="h-3.5 w-3.5" />
                  {t('notifierGroup.add', 'Add')}
                </Button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
