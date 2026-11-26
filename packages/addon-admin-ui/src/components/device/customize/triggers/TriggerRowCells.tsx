/**
 * The cells of a "Triggered by" row in the Customize table, in the table's four
 * columns: the source (item), the event it fires on (value), the action and
 * its "on for" time (source column), and the active switch with edit and
 * remove (actions). Every control edits the hook's draft; none of them writes.
 */
import { IconButton, Select } from '@camstack/ui-library'
import { Pencil, X } from 'lucide-react'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { LinkedNameCell } from '../kinds/LinkedNameCell'
import { RowActiveSwitch } from '../table/RowActiveSwitch'
import { actionChoiceOf, filterSummary, offeredChoices } from './linked-triggers-model'
import { OnForField } from './OnForField'
import type { TriggeredByState, TriggerTableLine, TriggerTableRow } from './useTriggeredBy'

function Muted({ children }: { readonly children: ReactNode }): ReactNode {
  return <span className="text-xs text-foreground-subtle">{children}</span>
}

export function TriggerItem({ line }: { readonly line: TriggerTableLine }): ReactNode {
  const { t } = useTranslation()
  switch (line.kind) {
    case 'triggerSection':
      return (
        <span className="text-[11px] font-medium uppercase tracking-wide text-foreground-muted">
          {t('customize.triggers.title')}
        </span>
      )
    case 'triggerPending':
      return (
        <span role="status" className="text-xs text-foreground-subtle">
          {t('customize.assign.checking')}
        </span>
      )
    case 'triggerEmpty':
      return <Muted>{t('customize.assign.none')}</Muted>
    case 'triggerNotice':
      return (
        <span
          role="alert"
          className={`text-xs break-words ${line.tone === 'danger' ? 'text-danger' : 'text-warning'}`}
        >
          {line.message}
        </span>
      )
    case 'triggerEntry':
      return (
        <LinkedNameCell name={line.row.name} deviceId={line.row.deviceId} detail={line.row.detail}>
          {line.row.flagged && (
            <span role="alert" className="text-[11px] text-warning">
              {t('customize.triggers.flagged')}
            </span>
          )}
        </LinkedNameCell>
      )
  }
}

function EventSummary({ row }: { readonly row: TriggerTableRow }): ReactNode {
  const { t } = useTranslation()
  const summary = filterSummary(row.filter)
  return (
    <span className="min-w-0 break-words text-xs text-foreground-subtle">
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
  )
}

export function TriggerValue({ line }: { readonly line: TriggerTableLine }): ReactNode {
  if (line.kind !== 'triggerEntry') return null
  return <EventSummary row={line.row} />
}

interface TriggerActionProps {
  readonly row: TriggerTableRow
  readonly state: TriggeredByState
}

function TriggerAction({ row, state }: TriggerActionProps): ReactNode {
  const { t } = useTranslation()
  const who = row.name ?? row.deviceId
  const choice = actionChoiceOf(row)
  const choices = offeredChoices(row.capability)
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <div className="w-28 shrink-0">
        <Select
          aria-label={t('customize.triggers.actionFor', { name: who })}
          value={choice}
          disabled={state.busy}
          options={choices.map((option) => ({
            value: option,
            label: t(`customize.triggers.actions.${option}`),
          }))}
          onChange={(e) => {
            const next = choices.find((option) => option === e.target.value)
            if (next !== undefined && next !== choice) state.setAction(row, next)
          }}
        />
      </div>
      {row.onForSeconds !== null && choice === 'on-for' && (
        <OnForField
          seconds={row.onForSeconds}
          label={t('customize.triggers.onForFor', { name: who })}
          hint={t('customize.triggers.onForHint')}
          disabled={state.busy}
          testId={`trigger-on-for-${row.key}`}
          maxSeconds={state.maxOnForSeconds}
          onChange={(seconds) => state.setOnFor(row, seconds)}
        />
      )}
    </div>
  )
}

export function TriggerSource({
  line,
  state,
}: {
  readonly line: TriggerTableLine
  readonly state: TriggeredByState
}): ReactNode {
  if (line.kind !== 'triggerEntry') return null
  return <TriggerAction row={line.row} state={state} />
}

export function TriggerButtons({
  line,
  state,
}: {
  readonly line: TriggerTableLine
  readonly state: TriggeredByState
}): ReactNode {
  const { t } = useTranslation()
  if (line.kind !== 'triggerEntry') return null
  const { row } = line
  const who = row.name ?? row.deviceId
  return (
    <span className="flex items-center justify-end gap-1">
      <RowActiveSwitch
        title={String(who)}
        checked={row.enabled}
        disabled={state.busy}
        testId={`trigger-active-${row.key}`}
        onChange={(enabled) => state.setEnabled(row, enabled)}
      />
      <IconButton
        icon={Pencil}
        variant="ghost"
        size="sm"
        aria-label={t('customize.triggers.editTrigger', { name: who })}
        disabled={state.busy}
        onClick={() => state.openEdit(row)}
      />
      <IconButton
        icon={X}
        variant="ghost"
        size="sm"
        aria-label={t('customize.assign.removeNamed', { name: who })}
        disabled={state.busy}
        onClick={() => state.unlink(row)}
      />
    </span>
  )
}
