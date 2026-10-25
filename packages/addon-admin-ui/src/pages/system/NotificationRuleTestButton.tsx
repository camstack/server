/**
 * "TEST NOW" — fire one rule for real, from wherever the rule is listed.
 *
 * The operator's ask, 2026-08-14: a Test button on every rule row that sends the
 * notification IMMEDIATELY, without a trip through the Simulate tab. The
 * simulator is still there and still useful — it asks you to describe an event
 * and lets you tune it — but "does this rule reach my phone" is a one-click
 * question and it was three screens away.
 *
 * Everything about WHAT to inject is decided server-side (`nc.testRule` →
 * `planRuleTest`), deliberately: the plan has to satisfy conditions only the
 * engine's own vocabulary can express — a sound window must carry the rule's
 * exact spec or it fails closed, a system event carries catalog keys rather than
 * prose. A client-side plan would be a second answer to the same question, and
 * the wrong one for the two kinds that need it most.
 *
 * The result is rendered INLINE and briefly, because the real answer arrives on
 * the phone. What this shows is the part the phone cannot: whether the rule
 * matched, which condition it failed on if not, how many rows were enqueued, and
 * anything the plan could not reproduce.
 */

import { Button, useSystem } from '@camstack/ui-library'
import { useMutation } from '@tanstack/react-query'
import { AlertTriangle, Loader2, Send } from 'lucide-react'
import { useState } from 'react'
import { NC_ADDON_ID, NC_TEST_RULE_ACTION } from './notification-rule-status'
import {
  type NcRuleTestOutcome,
  parseRuleTestResult,
  summariseRuleTest,
} from './notification-rule-test'
import { useTranslation } from 'react-i18next'

export interface NotificationRuleTestButtonProps {
  readonly ruleId: string
  /** Shown in the aria-label so a screen reader says which rule. */
  readonly ruleName: string
  /** The camera to attribute the event to when the rule scopes none. */
  readonly fallbackDeviceId?: number
  /** `icon` for a table row, `full` for the editor's own button. */
  readonly variant?: 'icon' | 'full'
  /** Render the verdict under the button. Off in a table row, where there is no
   *  room for a paragraph — the row shows a one-line title instead. */
  readonly showResult?: boolean
}

export function NotificationRuleTestButton({
  ruleId,
  ruleName,
  fallbackDeviceId,
  variant = 'icon',
  showResult = false,
}: NotificationRuleTestButtonProps) {
  const { t } = useTranslation()
  const system = useSystem()
  const [outcome, setOutcome] = useState<NcRuleTestOutcome | null>(null)
  const [error, setError] = useState<string | null>(null)

  const run = useMutation({
    mutationFn: async (): Promise<NcRuleTestOutcome | null> => {
      const raw = await system.trpcClient.addons.custom.mutate({
        addonId: NC_ADDON_ID,
        action: NC_TEST_RULE_ACTION,
        input: {
          ruleId,
          ...(fallbackDeviceId !== undefined ? { deviceId: fallbackDeviceId } : {}),
        },
      })
      return parseRuleTestResult(raw)
    },
    onMutate: () => {
      setOutcome(null)
      setError(null)
    },
    onSuccess: (parsed) => setOutcome(parsed),
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The test could not be run.'),
  })

  const title = outcome !== null ? summariseRuleTest(outcome) : error !== null ? error : undefined

  return (
    <>
      <Button
        size="sm"
        variant={variant === 'icon' ? 'ghost' : 'outline'}
        type="button"
        disabled={run.isPending}
        onClick={() => run.mutate()}
        // The title carries the LAST verdict in a row, where there is no room
        // for the paragraph — hovering is how the operator reads it.
        title={
          title ??
          t(
            'system.notificationRuleTestButton.testNowFiresThisRule',
            'Test now — fires this rule and really sends the notification',
          )
        }
        aria-label={t('system.notificationRuleTestButton.testNow', 'test {{ruleName}} now', {
          ruleName,
        })}
        data-testid="nc-rule-test-now"
      >
        {run.isPending ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin" />
        ) : (
          <Send className="h-3.5 w-3.5" />
        )}
        {variant === 'full' && t('system.notificationRuleTestButton.testNow2', 'Test now')}
      </Button>

      {showResult && error !== null && (
        <div className="mt-2 rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-[11px] text-danger">
          {error}
        </div>
      )}

      {showResult && outcome !== null && (
        <div
          data-testid="nc-rule-test-result"
          className="mt-2 space-y-1 rounded-md border border-border px-3 py-2 text-[11px] text-foreground-subtle"
        >
          <p className="text-foreground">{summariseRuleTest(outcome)}</p>
          {outcome.planNotes.map((note) => (
            <p key={note.conditionId} className="flex gap-1.5">
              <AlertTriangle className="mt-0.5 h-3 w-3 shrink-0 text-warning" />
              <span>{note.note}</span>
            </p>
          ))}
          {outcome.notes.map((note) => (
            <p key={note}>· {note}</p>
          ))}
        </div>
      )}
    </>
  )
}

export default NotificationRuleTestButton
