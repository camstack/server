/**
 * The simulator's ANSWER panel.
 *
 * The whole value of the tester is here: a run that produced no notification
 * has to READ as a result, never as an empty box. So the panel always leads
 * with one sentence ({@link summariseSimulateResult}) — "no enabled rule
 * declares this delivery" is an answer; a blank list is not — and every rule
 * that was consulted gets a row saying what happened to it, including the FIRST
 * condition that failed.
 *
 * `notes[]` is rendered verbatim and in full. Those sentences are the server
 * explaining every surprising verdict (a still that could not be taken, a
 * device-event that cannot carry one at all, a rule skipped for a reason the
 * outcome row has no column for), and dropping them would leave the operator
 * with a "no" and no reason.
 */

import { Badge, Button } from '@camstack/ui-library'
import { AlertCircle, CheckCircle, Copy } from 'lucide-react'
import { useState } from 'react'

import type {
  NcSimulateCooldown,
  NcSimulateOutcome,
  NcSimulateResult,
  NcSimulateStillVerdict,
} from './notification-simulate.helpers'
import { summariseSimulateResult } from './notification-simulate.helpers'
import { Trans, useTranslation } from 'react-i18next'

/** What each still verdict MEANS — `unattachable` is a fact about production. */
const STILL_HINT: Readonly<Record<NcSimulateStillVerdict, string>> = {
  live: 'A live snapshot of the camera was taken and attached.',
  none: 'No still was requested.',
  unavailable: 'A still was requested but the camera could not produce one.',
  unattachable:
    'This trigger cannot carry a still at all — an audio or occupancy notification freezes no media owner, so it ships text-only in production too. This is not a limit of the test.',
}

/** What each cooldown verdict means, one line, on hover. */
const COOLDOWN_HINT: Readonly<Record<NcSimulateCooldown, string>> = {
  'n/a': 'The rule did not match, so no cooldown was consulted.',
  clear: 'No cooldown was in effect — the rule was free to fire.',
  suppressed: 'A cooldown from an earlier fire silenced this one. Re-run with "Ignore cooldown".',
  bypassed: 'A cooldown was in effect and was deliberately ignored for this run.',
}

export interface NotificationSimulateResultPanelProps {
  readonly result: NcSimulateResult
  /** Resolves a target id to its name; falls back to the id. */
  readonly targetName: (targetId: string) => string
}

export function NotificationSimulateResultPanel({
  result,
  targetName,
}: NotificationSimulateResultPanelProps) {
  const { t } = useTranslation()
  return (
    <div className="space-y-3 rounded-md border border-border px-3 py-3">
      <p className="text-xs font-medium text-foreground">{summariseSimulateResult(result)}</p>

      <div className="flex flex-wrap items-center gap-2 text-[11px] text-foreground-subtle">
        <RecordIdChip recordId={result.recordId} />
        <span>
          <Trans
            i18nKey="system.notificationSimulateResult.delivery"
            values={{ value: result.delivery }}
            components={{ b: <span className="text-foreground" /> }}
          />
        </span>
        <span>
          <Trans
            i18nKey="system.notificationSimulateResult.candidates"
            values={{ value: result.candidates }}
            components={{ b: <span className="text-foreground" /> }}
          />
        </span>
        <span title={STILL_HINT[result.still]}>
          <Trans
            i18nKey="system.notificationSimulateResult.still"
            values={{ value: result.still }}
            components={{ b: <span className="text-foreground" /> }}
          />
        </span>
        {result.droppedBy !== undefined && (
          <Badge variant="warning">
            {t('system.notificationSimulateResult.droppedBy', { by: result.droppedBy })}
          </Badge>
        )}
      </div>

      {result.notes.length > 0 && (
        <ul className="space-y-1 rounded-md border border-border bg-surface px-2.5 py-2">
          {result.notes.map((note) => (
            <li key={note} className="text-[11px] leading-snug text-foreground-subtle">
              {note}
            </li>
          ))}
        </ul>
      )}

      {result.outcomes.length === 0 ? (
        <p className="text-[11px] text-foreground-subtle">
          <Trans
            i18nKey="system.notificationSimulateResult.noRuleEvaluated"
            values={{ delivery: result.delivery }}
            components={{ b: <span className="text-foreground" /> }}
          />
        </p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border">
          {result.outcomes.map((outcome) => (
            <OutcomeRow key={outcome.ruleId} outcome={outcome} targetName={targetName} />
          ))}
        </ul>
      )}
    </div>
  )
}

interface RecordIdChipProps {
  readonly recordId: string
}

/**
 * The synthetic record id, copyable.
 *
 * It is the grep key: the same string appears in the hub log lines, in the
 * outbox rows and in the delivery History tab, so copying it is the first thing
 * an operator does after a run that did not do what they expected.
 */
function RecordIdChip({ recordId }: RecordIdChipProps) {
  const { t } = useTranslation()
  const [copied, setCopied] = useState(false)
  const copy = (): void => {
    const clipboard = navigator.clipboard
    if (clipboard === undefined) return
    void clipboard.writeText(recordId).then(
      () => {
        setCopied(true)
        setTimeout(() => setCopied(false), 1_500)
      },
      () => setCopied(false),
    )
  }
  return (
    <span className="inline-flex items-center gap-1 rounded border border-border px-1.5 py-0.5">
      <code className="text-[10px] text-foreground">{recordId}</code>
      <Button
        size="sm"
        variant="ghost"
        type="button"
        onClick={copy}
        title={t('system.notificationSimulateResult.copyRecordId', 'Copy record id')}
      >
        <Copy className="h-3 w-3" />
      </Button>
      {copied && <span className="text-[10px] text-success">{t('common.copiedLower')}</span>}
    </span>
  )
}

interface OutcomeRowProps {
  readonly outcome: NcSimulateOutcome
  readonly targetName: (targetId: string) => string
}

function OutcomeRow({ outcome, targetName }: OutcomeRowProps) {
  const { t } = useTranslation()
  return (
    <li className="space-y-1 px-2.5 py-2">
      <div className="flex items-center gap-2">
        {outcome.matched ? (
          <CheckCircle className="h-3.5 w-3.5 shrink-0 text-success" />
        ) : (
          <AlertCircle className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        )}
        <span className="min-w-0 flex-1 truncate text-xs text-foreground">{outcome.ruleName}</span>
        <span
          className="shrink-0 text-[10px] text-foreground-subtle"
          title={COOLDOWN_HINT[outcome.cooldown]}
        >
          cooldown: {outcome.cooldown}
        </span>
      </div>

      {!outcome.matched && (
        <p className="pl-5 text-[11px] text-foreground-subtle">
          {outcome.failedCondition !== undefined ? (
            <Trans
              i18nKey="system.notificationSimulateResult.failingCondition"
              values={{ condition: outcome.failedCondition }}
              components={{ code: <code className="text-foreground" /> }}
            />
          ) : (
            t(
              'system.notificationSimulateResult.didNotMatchTheEngine',
              'Did not match. The engine reported no failing condition id.',
            )
          )}
        </p>
      )}

      {outcome.matched && (
        <p className="pl-5 text-[11px] text-foreground-subtle">
          {t('system.notificationSimulateResult.enqueued', { count: outcome.enqueued })}
          {outcome.targetIds.length > 0
            ? ` → ${outcome.targetIds.map(targetName).join(', ')}`
            : ` — ${t('system.notificationSimulateResult.noTargetResolved')}`}
          .
        </p>
      )}

      {outcome.matchedOn !== undefined && outcome.matchedOn.length > 0 && (
        <p className="pl-5 text-[10px] text-foreground-muted">
          {t('system.notificationSimulateResult.matchedOn', { on: outcome.matchedOn.join(', ') })}
        </p>
      )}
    </li>
  )
}
