/**
 * SILENCE THIS RULE NOW — the admin UI's snooze, which did not exist.
 *
 * ## The bug this closes
 *
 * Operator report, 2026-08-14: *"ho premuto uno snooze sulla rule «Animale su
 * aiuola» e non compare in Silenced right now"* [I pressed snooze on the rule "Animal on flowerbed" and it does not appear in Silenced right now]. The triage found ZERO
 * server-side requests behind the tap — no tRPC call, no log line — and the
 * reason is not a detached handler: **the admin UI had no create-snooze call
 * site at all.** `notificationRules.createSnooze` was reachable from the viewer
 * and from a notification button, and from nowhere on this page.
 *
 * What the operator pressed was the rule editor's `Snooze buttons` palette
 * (`5 min · 10 min · 30 min …`) on the Advanced tab. Those buttons author
 * `NcRule.snoozeOptions` — WHICH DURATIONS THE NOTIFICATION WILL OFFER — and
 * they look exactly like "silence this for 10 minutes". They patch form state,
 * so until Save nothing is sent, and after Save the rule is not silenced. A
 * control that reads as an action and is a setting is worse than a missing
 * control, which is why this ships next to it.
 *
 * ## What it does
 *
 * One `createSnooze` per press, `scope: 'rule'`, the caller stamped
 * server-side. It then invalidates the SAME query key the "Silenced right now"
 * panel reads (`notificationRules.listSnoozes`), so the window appears in the
 * panel immediately rather than at its 30 s refetch — a snooze the operator
 * cannot see is the whole defect being fixed.
 *
 * An ALARM rule is refused by the hub (D133: a rule the alarm is about, or that
 * arms it, can never be silenced), so the control is disabled with that reason
 * rather than offering a window the server would reject.
 */

import { Button, Select, useSystem } from '@camstack/ui-library'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { BellOff, Loader2 } from 'lucide-react'
import { useState } from 'react'
import { snoozeChoiceLabel } from './notification-rules.helpers'
import { useTranslation } from 'react-i18next'

/**
 * The query key the "Silenced right now" panel reads. Duplicated from
 * `NotificationSnoozes.tsx` on purpose — importing the panel to reach a
 * constant would make a button depend on a card. The wiring spec pins that the
 * two agree.
 */
export const SNOOZES_QUERY_KEY = ['notificationRules', 'listSnoozes'] as const

/**
 * The durations offered. The SAME palette the rule editor offers as notification
 * buttons (`NC_SNOOZE_BUTTON_CHOICES`) would be too long for a row; these are
 * the four an operator silences a nuisance rule for.
 */
export const NC_SNOOZE_NOW_CHOICES: readonly number[] = [10, 30, 60, 120]

/** What the icon variant sends when nobody picked a duration. */
export const NC_SNOOZE_NOW_DEFAULT_MINUTES = 30

export interface NotificationRuleSnoozeControlProps {
  readonly ruleId: string
  readonly ruleName: string
  /** True when the hub would refuse the window (an alarm rule — D133). */
  readonly exempt?: boolean
  /** `icon` for a table row (one press, the default duration); `full` for the
   *  editor, where there is room to choose. */
  readonly variant?: 'icon' | 'full'
}

export function NotificationRuleSnoozeControl({
  ruleId,
  ruleName,
  exempt = false,
  variant = 'icon',
}: NotificationRuleSnoozeControlProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const queryClient = useQueryClient()
  const [minutes, setMinutes] = useState<number>(NC_SNOOZE_NOW_DEFAULT_MINUTES)
  const [error, setError] = useState<string | null>(null)

  const snooze = useMutation({
    mutationFn: (durationMinutes: number) =>
      system.trpcClient.notificationRules.createSnooze.mutate({
        snooze: { scope: 'rule', ruleId, durationMinutes },
      }),
    onMutate: () => setError(null),
    // The panel above the table reads this key. Invalidating it is what makes
    // the window VISIBLE at once instead of up to 30 s later — which is the
    // difference between "it worked" and the report this fixes.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: SNOOZES_QUERY_KEY }),
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The snooze could not be opened.'),
  })

  if (exempt) {
    return variant === 'icon' ? null : (
      <p className="text-[10px] text-foreground-subtle">
        {t(
          'system.notificationRuleSnoozeControl.thisRuleConcernsOrTriggers',
          'This rule concerns — or triggers — the alarm panel, so no snooze window can silence it.',
        )}
      </p>
    )
  }

  if (variant === 'icon') {
    return (
      <Button
        size="sm"
        variant="ghost"
        type="button"
        disabled={snooze.isPending}
        onClick={() => snooze.mutate(NC_SNOOZE_NOW_DEFAULT_MINUTES)}
        title={t(
          'system.notificationRuleSnoozeControl.silenceThisRuleForIt',
          'Silence this rule for {{value1}} — it appears under "Silenced right now"',
          { value1: snoozeChoiceLabel(NC_SNOOZE_NOW_DEFAULT_MINUTES) },
        )}
        aria-label={t('system.notificationRuleSnoozeControl.snooze', 'snooze {{ruleName}}', {
          ruleName,
        })}
        data-testid="nc-rule-snooze-now"
      >
        {snooze.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <BellOff className="h-3.5 w-3.5" />
        )}
      </Button>
    )
  }

  return (
    <div className="space-y-1">
      <div className="flex items-end gap-2">
        <div className="w-32">
          <Select
            value={String(minutes)}
            onChange={(e) => {
              const next = Number(e.target.value)
              if (Number.isFinite(next) && next > 0) setMinutes(next)
            }}
            options={NC_SNOOZE_NOW_CHOICES.map((m) => ({
              value: String(m),
              label: snoozeChoiceLabel(m),
            }))}
          />
        </div>
        <Button
          size="sm"
          variant="outline"
          type="button"
          disabled={snooze.isPending}
          onClick={() => snooze.mutate(minutes)}
          data-testid="nc-rule-snooze-now"
        >
          {snooze.isPending ? (
            <Loader2 className="h-3.5 w-3.5 animate-spin" />
          ) : (
            <BellOff className="h-3.5 w-3.5" />
          )}
          {t('system.notificationRuleSnoozeControl.silenceThisRuleNow', 'Silence this rule now')}
        </Button>
      </div>
      <p className="text-[10px] text-foreground-subtle">
        {t(
          'system.notificationRuleSnoozeControl.opensARealSnoozeWindow',
          'Opens a real snooze window right now — distinct from the buttons above, which only choose the durations this rule\'s NOTIFICATION offers. It appears under "Silenced right now" and can be ended from there.',
        )}
      </p>
      {error !== null && <p className="text-[10px] text-danger">{error}</p>}
    </div>
  )
}

export default NotificationRuleSnoozeControl
