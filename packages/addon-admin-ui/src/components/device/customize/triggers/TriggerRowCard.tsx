/**
 * One "Triggered by" row, stacked so it fits the narrow Customize pane: the
 * source and its remove button, the event it fires on, then the action, the
 * "on for" time and the active switch, wrapping as the pane narrows. Every
 * control edits the section's draft; none of them writes.
 */
import { IconButton, Select, Switch } from '@camstack/ui-library'
import { Clock, Pencil, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LinkedNameCell } from '../kinds/LinkedNameCell'
import {
  actionChoiceOf,
  filterSummary,
  isEditable,
  offeredChoices,
  type TriggerActionChoice,
  type TriggerRow,
} from './linked-triggers-model'
import { OnForField } from './OnForField'

export interface TriggerRowView extends TriggerRow {
  readonly name: string | null
  readonly detail: string | null
}

export interface TriggerRowCardProps {
  readonly row: TriggerRowView
  readonly disabled: boolean
  /** The most the target may be held on for. */
  readonly maxOnForSeconds: number
  readonly onAction: (choice: TriggerActionChoice) => void
  readonly onOnFor: (seconds: number) => void
  readonly onEnabled: (enabled: boolean) => void
  readonly onEditEvent: () => void
  readonly onEditWindow: () => void
  readonly onRemove: () => void
}

export function TriggerRowCard({
  row,
  disabled,
  maxOnForSeconds,
  onAction,
  onOnFor,
  onEnabled,
  onEditEvent,
  onEditWindow,
  onRemove,
}: TriggerRowCardProps): ReactNode {
  const { t } = useTranslation()
  const who = row.name ?? row.deviceId
  const choice = actionChoiceOf(row)
  const choices = offeredChoices(row.capability)
  const summary = filterSummary(row.filter)
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface px-3 py-2">
      <div className="flex items-start gap-2">
        <div className="min-w-0 flex-1">
          <LinkedNameCell name={row.name} deviceId={row.deviceId} detail={row.detail}>
            {row.flagged && (
              <span role="alert" className="text-[11px] text-warning">
                {t('customize.triggers.flagged')}
              </span>
            )}
          </LinkedNameCell>
        </div>
        <IconButton
          icon={X}
          variant="ghost"
          size="sm"
          aria-label={t('customize.assign.removeNamed', { name: who })}
          disabled={disabled}
          onClick={onRemove}
        />
      </div>
      <div className="flex items-start gap-1 text-xs text-foreground-subtle">
        <span className="min-w-0 flex-1 break-words">
          {row.filter.kind === 'motion'
            ? t('customize.triggers.motionDetected')
            : row.filter.kind === 'detection'
              ? row.filter.classes.map((c) => t(`customize.triggers.classes.${c}`)).join(', ')
              : summary.custom
                ? t('customize.triggers.customFilter')
                : [
                    summary.events.length === 0
                      ? t('customize.triggers.anyEvent')
                      : summary.events.join(', '),
                    ...(summary.parts.length === 0
                      ? []
                      : [t('customize.triggers.partsNamed', { parts: summary.parts.join(', ') })]),
                  ].join(' · ')}
          {(row.activeWindow !== null || row.activeWhen !== null) && (
            <span className="ml-1 text-[11px] text-foreground-muted">
              {t('customize.triggers.windowSet')}
            </span>
          )}
        </span>
        <div className="flex shrink-0 items-center">
          {isEditable(row.filter) && (
            <IconButton
              icon={Pencil}
              variant="ghost"
              size="sm"
              aria-label={t(
                row.filter.kind === 'detection'
                  ? 'customize.triggers.editClasses'
                  : 'customize.triggers.editFilter',
                { name: who },
              )}
              disabled={disabled}
              onClick={onEditEvent}
            />
          )}
          <IconButton
            icon={Clock}
            variant="ghost"
            size="sm"
            aria-label={t('customize.triggers.editWindow', { name: who })}
            disabled={disabled}
            onClick={onEditWindow}
          />
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="w-28 shrink-0">
          <Select
            aria-label={t('customize.triggers.actionFor', { name: who })}
            value={choice}
            disabled={disabled}
            options={choices.map((option) => ({
              value: option,
              label: t(`customize.triggers.actions.${option}`),
            }))}
            onChange={(e) => {
              const next = choices.find((option) => option === e.target.value)
              if (next !== undefined && next !== choice) onAction(next)
            }}
          />
        </div>
        {row.onForSeconds !== null && choice === 'on-for' && (
          <OnForField
            seconds={row.onForSeconds}
            label={t('customize.triggers.onForFor', { name: who })}
            hint={t('customize.triggers.onForHint')}
            disabled={disabled}
            testId={`trigger-on-for-${row.key}`}
            maxSeconds={maxOnForSeconds}
            onChange={onOnFor}
          />
        )}
        <label className="ml-auto flex items-center gap-2 text-[11px] text-foreground-muted">
          {t('customize.triggers.active')}
          <Switch
            checked={row.enabled}
            disabled={disabled}
            aria-label={t('customize.triggers.activeFor', { name: who })}
            onCheckedChange={onEnabled}
          />
        </label>
      </div>
    </div>
  )
}
