/**
 * One alarm duration field, shared by every mode card.
 *
 * Committed when focus LEAVES the field (`DurationInput` `deferred`), so a half-typed "4" of "45" never reaches the panel —
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
import { DurationInput, FormField } from '@camstack/ui-library'
import { type ReactNode, useState } from 'react'
import { delayLabel } from './notification-alarm.helpers'
import i18n from '../../i18n/index'

/** The fields an alarm delay shows; it is stored in seconds. */
const ALARM_DELAY_UNITS = ['minutes', 'seconds'] as const

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

interface AlarmDelayFieldProps {
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

/** Said when a typed value is outside what the hub accepts, so a discarded entry is never silent. */
export function delayRangeError(max: number): string {
  return i18n.t('system.alarmDelay.rangeError', { max })
}

/** Said after a refused entry: what was dropped, and what would have been accepted. */
export function delayRefusedMessage(seconds: number | null, max: number): string {
  const lead =
    seconds === null ? 'Nothing was entered, so nothing was saved' : `${seconds} s was not saved`
  return `${lead} — ${delayRangeError(max)}`
}

export function AlarmDelayField({
  label,
  value,
  max,
  zeroMeans,
  disabled,
  testId,
  hint,
  adornment,
  onCommit,
}: AlarmDelayFieldProps) {
  // What a refused entry discarded; said until the next change so the entry is never lost silently.
  const [refused, setRefused] = useState<number | null | 'empty'>(null)
  // "45 s" is the unit already beside the box; only 0 ("arms immediately") and minutes add words.
  const readout = delayLabel(value, zeroMeans)

  const commit = (seconds: number): void => {
    if (seconds > max) {
      setRefused(seconds)
      return
    }
    setRefused(null)
    onCommit(seconds)
  }

  return (
    <FormField
      label={label}
      {...(hint !== undefined ? { description: hint } : {})}
      {...(refused !== null
        ? { error: delayRefusedMessage(refused === 'empty' ? null : refused, max) }
        : {})}
    >
      <div className="flex items-center gap-2">
        <DurationInput
          deferred
          value={value}
          units={ALARM_DELAY_UNITS}
          max={max}
          disabled={disabled}
          aria-label={label}
          testIdPrefix={testId}
          onChange={commit}
          onEmptyCommit={() => setRefused('empty')}
        />
        {adornment}
      </div>
      {readout !== `${value} s` ? (
        <span className="text-[10px] text-foreground-subtle">{readout}</span>
      ) : null}
    </FormField>
  )
}
