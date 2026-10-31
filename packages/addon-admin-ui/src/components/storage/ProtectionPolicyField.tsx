/**
 * The one protection control: a unit and a value.
 *
 * ## Why the unit is component state
 *
 * The unit is a PENDING EDIT and cannot be derived from the stored config.
 * Picking "GB of free space" before typing a number clears both keys — that is
 * the point, 10% and 10 GB are not the same reserve — and a unit re-derived
 * from the config then reads back as `percent`, so the selector snapped back to
 * the unit the operator had just moved away from and the next number was
 * written to the wrong key. That shipped. The unit lives here; only the VALUE
 * is read from the config (`readProtectionValue`).
 */
import { useState } from 'react'
import {
  DEFAULT_MIN_FREE_PERCENT,
  type ProtectionPolicy,
  type ProtectionUnit,
  parseProtectionValue,
  protectionHelpText,
  protectionUnitLabel,
  readLegacyMaxUsedGb,
  readProtectionPolicy,
  readProtectionValue,
  writeProtectionPolicy,
} from './location-protection'
import { useTranslation } from 'react-i18next'
import { Input, Select } from '@camstack/ui-library'

export interface ProtectionPolicyFieldProps {
  readonly config: Readonly<Record<string, unknown>>
  /** The provider's declared default, when it has one. */
  readonly defaultPercent?: number
  /** Receives the WHOLE config with the policy keys rewritten. */
  readonly onChange: (config: Record<string, unknown>) => void
}

export function ProtectionPolicyField({
  config,
  defaultPercent = DEFAULT_MIN_FREE_PERCENT,
  onChange,
}: ProtectionPolicyFieldProps) {
  const { t } = useTranslation()
  const [unit, setUnit] = useState<ProtectionUnit>(() => readProtectionPolicy(config).unit)
  const value = readProtectionValue(config, unit)
  const policy: ProtectionPolicy = { unit, value }
  const legacyMaxUsedGb = readLegacyMaxUsedGb(config)

  const selectUnit = (next: ProtectionUnit): void => {
    setUnit(next)
    // Switching units never reinterprets the number as the other unit.
    onChange(writeProtectionPolicy(config, { unit: next, value: null }))
  }
  const typeValue = (raw: string): void => {
    onChange(writeProtectionPolicy(config, { unit, value: parseProtectionValue(raw, unit) }))
  }

  return (
    <div className="space-y-1">
      <label className="text-[10px] uppercase tracking-wide text-foreground-subtle">
        {t('storage.protectionPolicyField.protectedFreeSpace', 'Protected free space')}
      </label>
      <div className="flex items-center gap-2">
        <Select
          wrapperClassName="inline-block w-auto"
          aria-label={t('storage.protectionPolicyField.protectionUnit', 'Protection unit')}
          value={unit}
          onChange={(e) => {
            selectUnit(e.target.value === 'gb' ? 'gb' : 'percent')
          }}
        >
          <option value="percent">
            {t('storage.protectionPolicyField.ofTheVolume', '% of the volume')}
          </option>
          <option value="gb">
            {t('storage.protectionPolicyField.gbOfFreeSpace', 'GB of free space')}
          </option>
        </Select>
        <Input
          type="number"
          aria-label={protectionUnitLabel(unit)}
          min={0}
          max={unit === 'percent' ? 100 : undefined}
          value={value === null ? '' : value}
          placeholder={unit === 'percent' ? String(defaultPercent) : t('common.defaultWord')}
          onChange={(e) => {
            typeValue(e.target.value)
          }}
          className="w-full rounded border border-border bg-background px-2 py-1.5 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
        />
      </div>
      <p className="text-[10px] text-foreground-subtle">
        {protectionHelpText(policy, defaultPercent)}
      </p>
      {legacyMaxUsedGb !== null && (
        <p className="text-[10px] text-foreground-subtle italic">
          {t('storage.protectionPolicyField.legacyMax', { gb: legacyMaxUsedGb })}
        </p>
      )}
    </div>
  )
}
