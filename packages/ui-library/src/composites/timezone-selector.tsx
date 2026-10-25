import { TIMEZONES, findTimezone } from '@camstack/types'
import type { Timezone, TimezoneDstRule, Weekday } from '@camstack/types'
import { type JSX } from 'react'
import { useUiText } from '../contexts/ui-text'

// Re-export the catalogue + helper + types so consumers can pull the
// whole timezone toolkit from `@camstack/ui-library` in one import.
export { TIMEZONES, findTimezone }
export type { Timezone, TimezoneDstRule, Weekday }

export interface TimezoneSelectorProps {
  /** Currently selected IANA id (e.g. 'Europe/Rome'). */
  readonly value: string
  /** Fired with the newly chosen IANA id. */
  readonly onChange: (id: string) => void
  readonly disabled?: boolean
}

// Match the form-field `<select>` chrome used by `config-form-field.tsx`
// SelectField so the picker reads as a native form control.
const SELECT_CLASS =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed'

/**
 * Friendly timezone picker. Renders a native `<select>` grouped by
 * region via `<optgroup>`, sourced from the curated `TIMEZONES`
 * catalogue. The selected value is the IANA id; DST is implied by the
 * chosen zone (each option carries its standard offset + DST rule),
 * so there is no separate DST control.
 */
export function TimezoneSelector({
  value,
  onChange,
  disabled,
}: TimezoneSelectorProps): JSX.Element {
  const t = useUiText()
  // Stable region order following the catalogue's declaration order.
  const regions: string[] = []
  for (const tz of TIMEZONES) {
    if (!regions.includes(tz.region)) regions.push(tz.region)
  }

  return (
    <select
      className={SELECT_CLASS}
      value={value}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      {/* Placeholder shown only until the operator picks a zone. */}
      {!findTimezone(value) && (
        <option value="">{t('uiLibrary.timezoneSelector.select', '— Select timezone —')}</option>
      )}
      {regions.map((region) => (
        <optgroup key={region} label={region}>
          {TIMEZONES.filter((tz) => tz.region === region).map((tz) => (
            <option key={tz.id} value={tz.id}>
              {tz.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  )
}
