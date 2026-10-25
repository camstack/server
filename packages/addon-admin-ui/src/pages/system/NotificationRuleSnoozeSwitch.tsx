/**
 * The rules list's Snooze column (R3, D690): a SWITCH per row, on while the
 * rule has a live rule-scoped snooze window.
 *
 * On opens a window for {@link NC_SNOOZE_NOW_DEFAULT_MINUTES} (`createSnooze`,
 * scope `rule`, the caller stamped server-side); off ends every live window of
 * the rule the caller can see (`cancelSnooze`). Both invalidate the key the
 * "Silenced right now" panel reads, so the panel and the column never disagree.
 *
 * A rule no snooze can silence (it concerns or arms the alarm, D133) gets NO
 * switch — the cell is empty, and no prose explains it. A disabled rule gets a
 * disabled switch: there is nothing to silence.
 */
import type { NcRule, NcSnooze } from '@camstack/types'
import { Switch, useSystem } from '@camstack/ui-library'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { NC_SNOOZE_NOW_DEFAULT_MINUTES, SNOOZES_QUERY_KEY } from './NotificationRuleSnoozeControl'

/** The live rule-scoped windows of one rule at `nowMs` — expiry is exclusive. */
export function activeRuleSnoozeIds(
  snoozes: readonly NcSnooze[],
  ruleId: string,
  nowMs: number,
): readonly string[] {
  return snoozes
    .filter(
      (s) =>
        s.scope === 'rule' && s.ruleId === ruleId && nowMs >= s.startedAt && nowMs < s.expiresAt,
    )
    .map((s) => s.id)
}

/**
 * When the first of this rule's unexpired windows ends — `null` when none is.
 * Judged on `expiresAt` alone: a window opened after the list mounted starts
 * after any clock captured then, and must still be timed (review round 2).
 */
export function nextRuleSnoozeExpiry(
  snoozes: readonly NcSnooze[],
  ruleId: string,
  nowMs: number,
): number | null {
  const ends = snoozes
    .filter((s) => s.scope === 'rule' && s.ruleId === ruleId && nowMs < s.expiresAt)
    .map((s) => s.expiresAt)
  return ends.length === 0 ? null : Math.min(...ends)
}

/**
 * Re-renders the switch when the rule's first live window ends — a window ends
 * by the CLOCK, so a switch rendered once would stay on after it (review M6).
 * Re-armed whenever the windows change, measured against the real clock.
 */
function useSnoozeExpiryTick(snoozes: readonly NcSnooze[], ruleId: string): void {
  const [, setTick] = useState(0)
  useEffect(() => {
    const next = nextRuleSnoozeExpiry(snoozes, ruleId, Date.now())
    if (next === null) return undefined
    const timer = setTimeout(() => setTick((n) => n + 1), Math.max(0, next - Date.now()) + 50)
    return () => clearTimeout(timer)
  }, [snoozes, ruleId])
}

/** The windows the list reads — the SAME key and answer as the "Silenced right now" panel. */
export function useRuleSnoozes(): readonly NcSnooze[] {
  const system = useSystem()
  const query = useQuery({
    queryKey: SNOOZES_QUERY_KEY,
    queryFn: async (): Promise<readonly NcSnooze[]> => {
      const res = await system.trpcClient.notificationRules.listSnoozes.query({})
      return res.snoozes
    },
  })
  return query.data ?? []
}

export interface NotificationRuleSnoozeSwitchProps {
  readonly rule: NcRule
  readonly snoozes: readonly NcSnooze[]
  /** True when no window can silence this rule (an alarm rule — D133). */
  readonly exempt: boolean
}

export function NotificationRuleSnoozeSwitch({
  rule,
  snoozes,
  exempt,
}: NotificationRuleSnoozeSwitchProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  useSnoozeExpiryTick(snoozes, rule.id)
  const active = activeRuleSnoozeIds(snoozes, rule.id, Date.now())
  const refresh = (): Promise<void> =>
    queryClient.invalidateQueries({ queryKey: SNOOZES_QUERY_KEY })

  const open = useMutation({
    mutationFn: () =>
      system.trpcClient.notificationRules.createSnooze.mutate({
        snooze: { scope: 'rule', ruleId: rule.id, durationMinutes: NC_SNOOZE_NOW_DEFAULT_MINUTES },
      }),
    onSuccess: refresh,
  })
  const end = useMutation({
    mutationFn: async (ids: readonly string[]): Promise<void> => {
      for (const snoozeId of ids) {
        await system.trpcClient.notificationRules.cancelSnooze.mutate({ snoozeId })
      }
    },
    onSuccess: refresh,
  })

  if (exempt) return null
  const failed = open.isError || end.isError
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <Switch
        checked={active.length > 0}
        disabled={!rule.enabled || open.isPending || end.isPending}
        onCheckedChange={(next) => (next ? open.mutate() : end.mutate(active))}
        aria-label={t('notificationRules.snooze.aria', 'snooze {{name}}').replaceAll(
          '{{name}}',
          rule.name,
        )}
        title={t('notificationRules.snooze.title', {
          minutes: NC_SNOOZE_NOW_DEFAULT_MINUTES,
          defaultValue: 'Silence this rule for {{minutes}} minutes',
        }).replaceAll('{{minutes}}', String(NC_SNOOZE_NOW_DEFAULT_MINUTES))}
        data-testid="nc-rule-snooze-switch"
      />
      {failed && (
        <span className="text-[10px] text-danger" role="alert">
          {t('notificationRules.snooze.failed', 'The snooze could not be changed.')}
        </span>
      )}
    </span>
  )
}
