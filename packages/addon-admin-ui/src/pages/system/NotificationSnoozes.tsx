/**
 * Active snooze windows, and the way out of them.
 *
 * This panel exists for ONE question an operator eventually asks in a hurry:
 * "why is that camera quiet?". A snooze answers it — but only if the silence is
 * visible somewhere, and endable by the person who did not set it. An admin
 * sees every window, including another user's personal one, because the
 * alternative is a household-wide silence nobody can locate.
 *
 * Windows end by the CLOCK, so the list refetches on an interval: a page left
 * open would otherwise keep showing a silence that is already over. "End now"
 * moves the expiry to this instant; the digest of what was hidden still goes
 * out, because it is still what the operator missed.
 *
 * The card is ALWAYS rendered, including when nothing is silenced. It used to
 * disappear on an empty list, which made "nothing is snoozed" and "this panel
 * does not exist in my build" the same picture — and the whole point of the
 * card is that a silence has somewhere to be found. An explicit "nothing is
 * silenced" is an answer; a missing card is not.
 */

import type { NcRule, NcSnooze } from '@camstack/types'
import { Badge, Button, Card, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { BellOff } from 'lucide-react'
import { useMemo } from 'react'
import { useTranslation } from 'react-i18next'
import i18n from '../../i18n/index'

const SNOOZES_QUERY_KEY = ['notificationRules', 'listSnoozes'] as const

/** Ends by itself in ~30 s of drift at worst. */
const REFETCH_MS = 30_000

interface NotificationSnoozesProps {
  /** Rule names, so a rule-scoped window says WHICH rule. */
  readonly rules: readonly NcRule[]
}

/** Whole minutes left, floored at zero — never a negative countdown. */
function minutesLeft(snooze: NcSnooze, nowMs: number): number {
  return Math.max(0, Math.ceil((snooze.expiresAt - nowMs) / 60_000))
}

function remainingLabel(minutes: number): string {
  if (minutes === 0) return i18n.t('system.notificationSnoozes.remEnding')
  if (minutes < 60) return i18n.t('system.notificationSnoozes.remMin', { count: minutes })
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  return rest === 0
    ? i18n.t('system.notificationSnoozes.remHour', { count: hours })
    : i18n.t('system.notificationSnoozes.remHourMin', { hours, minutes: rest })
}

export function NotificationSnoozes({ rules }: NotificationSnoozesProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()

  const snoozesQuery = useQuery({
    queryKey: SNOOZES_QUERY_KEY,
    refetchInterval: REFETCH_MS,
    queryFn: async (): Promise<readonly NcSnooze[]> => {
      const res = await system.trpcClient.notificationRules.listSnoozes.query({})
      return res.snoozes
    },
  })

  const cancel = useMutation({
    mutationFn: (snoozeId: string) =>
      system.trpcClient.notificationRules.cancelSnooze.mutate({ snoozeId }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SNOOZES_QUERY_KEY }),
  })

  const ruleNameById = useMemo(() => {
    const m = new Map<string, string>()
    for (const rule of rules) m.set(rule.id, rule.name)
    return m
  }, [rules])

  const now = Date.now()
  const active = (snoozesQuery.data ?? []).filter((s) => now >= s.startedAt && now < s.expiresAt)

  return (
    <Card className="p-4">
      <div className="flex items-center gap-2 mb-3">
        <BellOff className="h-4 w-4 text-foreground-subtle" />
        <h3 className="text-sm font-medium text-foreground">
          {t('system.notificationSnoozes.silencedRightNow', 'Silenced right now')}
        </h3>
      </div>
      {active.length === 0 && (
        <p className="text-[11px] text-foreground-subtle">
          {t(
            'system.notificationSnoozes.nothingIsSilencedASnooze',
            'Nothing is silenced. A snooze opened from the app or from a notification button appears here until its clock runs out.',
          )}
        </p>
      )}
      {/* Capped and scrolled INSIDE the card: this panel sits above the rules
          table and a household that snoozed a dozen cameras would otherwise
          push the whole list off the screen — the opposite of "a silence has
          somewhere to be found". */}
      <div className="max-h-64 space-y-2 overflow-y-auto">
        {active.map((snooze) => {
          const what =
            snooze.scope === 'all'
              ? 'Everything'
              : snooze.scope === 'device'
                ? `Camera ${snooze.deviceId ?? '?'}`
                : (ruleNameById.get(snooze.ruleId ?? '') ?? 'A rule')
          return (
            <div
              key={snooze.id}
              className="flex items-center justify-between gap-3 rounded-md border border-border px-3 py-2"
            >
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <span className="text-xs text-foreground truncate">{what}</span>
                  {snooze.global && (
                    <Badge variant="warning" className="text-[10px]">
                      {t('common.everyone')}
                    </Badge>
                  )}
                  {/* WHAT is silenced, not just where. A window can name the
                      subject classes it covers — "the cat, not the person" —
                      and a card that hid that would answer "why is 102 quiet"
                      only halfway. Absent = every class. */}
                  {snooze.classes !== undefined && snooze.classes.length > 0 && (
                    <Badge variant="info" className="text-[10px]">
                      {snooze.classes.join(', ')}
                    </Badge>
                  )}
                  {!snooze.summary && (
                    <Badge variant="default" className="text-[10px]">
                      {t('system.notificationSnoozes.noSummary', 'no summary')}
                    </Badge>
                  )}
                </div>
                <span className="text-[10px] text-foreground-subtle">
                  {t('system.notificationSnoozes.setBy', {
                    user: snooze.userId,
                    remaining: remainingLabel(minutesLeft(snooze, now)),
                  })}
                </span>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={cancel.isPending}
                onClick={() => cancel.mutate(snooze.id)}
              >
                {t('system.notificationSnoozes.endNow', 'End now')}
              </Button>
            </div>
          )
        })}
      </div>
    </Card>
  )
}
