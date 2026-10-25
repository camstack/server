/**
 * One alarm duration field, shared by the global "Default delays" card and every mode card.
 *
 * Committed on BLUR: local state until then, so a half-typed "4" of "45" never reaches the panel —
 * an alarm briefly configured with a 4-second entry delay is not a UI detail. The field does NOT
 * decide whether a typed value is a change: a mode that inherits 45 s and is typed 45 must still
 * store the override, so the caller decides (`modeDelayEdit` for a mode, a plain compare for the
 * global value).
 */

import {
  NC_ALARM_DELAY_MAX_SEC,
  NC_ALARM_TRIGGERED_MAX_SEC,
  type NcAlarmDelayField,
} from '@camstack/types'
import { FormField, Input } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { delayLabel, parseDelayInput } from './notification-alarm.helpers'
import i18n from '../../i18n/index'

export interface AlarmDelayMeta {
  readonly field: NcAlarmDelayField
  /** The segment of a per-mode test id: `alarm-delay-<mode>-<key>`. */
  readonly key: 'exit' | 'entry' | 'siren'
  readonly labelKey: string
  readonly hintKey: string
  readonly max: number
  readonly zeroMeansKey: string
}

/** The three durations, in the order the page shows them. The bounds are the hub's own. */
export const ALARM_DELAY_META: readonly AlarmDelayMeta[] = [
  {
    field: 'exitDelaySec',
    key: 'exit',
    labelKey: 'system.alarmDelay.exitLabel',
    hintKey: 'system.alarmDelay.exitHint',
    max: NC_ALARM_DELAY_MAX_SEC,
    zeroMeansKey: 'system.alarmDelay.exitZero',
  },
  {
    field: 'entryDelaySec',
    key: 'entry',
    labelKey: 'system.alarmDelay.entryLabel',
    hintKey: 'system.alarmDelay.entryHint',
    max: NC_ALARM_DELAY_MAX_SEC,
    zeroMeansKey: 'system.alarmDelay.entryZero',
  },
  {
    field: 'triggeredDurationSec',
    key: 'siren',
    labelKey: 'system.alarmDelay.sirenLabel',
    hintKey: 'system.alarmDelay.sirenHint',
    max: NC_ALARM_TRIGGERED_MAX_SEC,
    zeroMeansKey: 'system.alarmDelay.sirenZero',
  },
]

interface DelayFieldProps {
  readonly label: string
  readonly value: number
  readonly max: number
  readonly zeroMeans: string
  readonly disabled: boolean
  readonly testId: string
  /** The field's description line, under the label (the shared `FormField` convention). */
  readonly hint?: string
  /** Beside the unit: for a mode field the "default" badge or the reset button. */
  readonly adornment?: ReactNode
  readonly onCommit: (seconds: number) => void
}

/** Said while a typed value would be refused on blur, so a discarded entry is never silent. */
export function delayRangeError(max: number): string {
  return i18n.t('system.alarmDelay.rangeError', { max })
}

/** Said after a blur that discarded the typed text: what was dropped, and what would have been accepted. */
export function delayRefusedMessage(text: string, max: number): string {
  const typed = text.trim()
  const lead = typed === '' ? 'Nothing was entered, so nothing was saved' : `${typed} was not saved`
  return `${lead} — ${delayRangeError(max)}`
}

export function DelayField({
  label,
  value,
  max,
  zeroMeans,
  disabled,
  testId,
  hint,
  adornment,
  onCommit,
}: DelayFieldProps) {
  const [draft, setDraft] = useState<string | null>(null)
  // What a refused blur discarded; said until the next keystroke so the entry is never lost silently.
  const [refused, setRefused] = useState<string | null>(null)
  const shown = draft ?? String(value)
  // An empty draft is mid-edit (the operator is retyping), not an error — it is judged on blur.
  const invalid = draft !== null && draft.trim() !== '' && parseDelayInput(draft, max) === null
  // "45 s" is the unit already beside the box; only 0 ("arms immediately") and minutes add words.
  const readout = delayLabel(value, zeroMeans)

  const commit = (): void => {
    const parsed = draft === null ? null : parseDelayInput(draft, max)
    setDraft(null)
    if (parsed !== null) {
      setRefused(null)
      onCommit(parsed)
    } else if (draft !== null) {
      setRefused(draft)
    }
  }

  return (
    <FormField
      label={label}
      {...(hint !== undefined ? { description: hint } : {})}
      {...(invalid
        ? { error: delayRangeError(max) }
        : refused !== null
          ? { error: delayRefusedMessage(refused, max) }
          : {})}
    >
      <div className="flex items-center gap-2">
        <Input
          type="number"
          min={0}
          max={max}
          value={shown}
          disabled={disabled}
          state={invalid || refused !== null ? 'error' : 'default'}
          aria-label={label}
          onChange={(e) => {
            setRefused(null)
            setDraft(e.target.value)
          }}
          onBlur={commit}
          className="w-20"
          data-testid={testId}
        />
        <span className="text-xs text-foreground-subtle">s</span>
        {adornment}
      </div>
      {readout !== `${value} s` ? (
        <span className="text-[10px] text-foreground-subtle">{readout}</span>
      ) : null}
    </FormField>
  )
}
