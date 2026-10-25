import type { ConfigMultiSelectField, ConfigOption } from '@camstack/types'
import { OptionSelect, type OptionSelectOption } from '@camstack/ui-library'
import { resolveLabel, type TranslationFn } from './FormBuilder'
import { useTranslation } from 'react-i18next'

export { INPUT_SHELL, SelectedChip } from '@camstack/ui-library'

/**
 * Thin wrapper: large `multiselect` fields render via shared `OptionSelect`
 * (dropdown + pills). Kept so existing call sites / tests keep working;
 * FormBuilder prefers `OptionSelect` directly.
 */

interface SearchableMultiSelectFieldProps {
  readonly field: ConfigMultiSelectField
  readonly value: unknown
  readonly onChange: (value: unknown) => void
  readonly disabled?: boolean
  readonly translationFn?: TranslationFn
}

function toOptions(options: readonly ConfigOption[]): readonly OptionSelectOption[] {
  return options.map((o) => ({
    value: o.value,
    label: o.label,
    ...(o.description !== undefined ? { description: o.description } : {}),
    ...(o.iconId !== undefined ? { iconId: o.iconId } : {}),
  }))
}

function selectedStrings(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string')
}

export function SearchableMultiSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: SearchableMultiSelectFieldProps) {
  const { t } = useTranslation()
  const isDisabled = disabled === true || field.disabled === true
  const label = resolveLabel(field.label, translationFn)
  const description = resolveLabel(field.description, translationFn)

  return (
    <OptionSelect
      mode="multi"
      options={toOptions(field.options)}
      value={selectedStrings(value)}
      onChange={(next) => onChange(next)}
      disabled={isDisabled}
      searchable
      creatable={field.creatable === true}
      {...(field.createLabel !== undefined ? { createLabel: field.createLabel } : {})}
      {...(field.maxItems !== undefined ? { maxItems: field.maxItems } : {})}
      {...(label !== undefined ? { label } : {})}
      {...(description !== undefined ? { description } : {})}
      placeholder={
        field.placeholder ??
        t('formBuilder.searchableMultiSelectField.searchToAdd', 'Search to add…')
      }
      testId={`config-multiselect-${field.key}`}
      listboxId={`msel-${field.key}`}
    />
  )
}
