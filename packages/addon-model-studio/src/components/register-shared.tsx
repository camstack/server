/**
 * Shared Register UI primitives for the plus catalog and plugin catalog catalog sources.
 *
 * Both sources are a facet cascade + an import action. plus catalog's only product
 * delta is the plus catalog API-key / account overlay — the facet select chrome
 * must not fork.
 */
import type { ReactNode } from 'react'
import { Field } from './Form.js'
import { Select } from '@camstack/ui-library'

export const REGISTER_SELECT_CLASS =
  'w-full px-3 py-1.5 text-xs rounded-md border border-border bg-surface text-foreground focus:outline-none focus:border-primary/50 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none disabled:opacity-50'

export const REGISTER_BUTTON_CLASS =
  'px-4 py-1.5 text-xs font-medium rounded-md bg-primary text-primary-foreground hover:bg-primary/90 disabled:opacity-50 transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none'

export const REGISTER_GHOST_BUTTON_CLASS =
  'px-2.5 py-1 text-[10px] font-medium rounded-md border border-border text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-primary motion-reduce:transition-none'

export interface FacetOption {
  readonly value: string
  readonly label: string
  readonly count?: number
}

export interface FacetSelectProps {
  readonly label: string
  readonly value: string
  readonly options: readonly FacetOption[]
  readonly onChange: (value: string) => void
  readonly disabled?: boolean
  readonly placeholder?: string
  /** When true and there is exactly one option, omit the control (keep `hint`). */
  readonly compactWhenSingle?: boolean
  readonly formatOption?: (option: FacetOption) => string
  readonly hint?: ReactNode
}

function defaultFormatOption(option: FacetOption): string {
  return option.count === undefined ? option.label : `${option.label} (${option.count})`
}

/**
 * One level of a catalog facet cascade — shared by plugin catalog and plus catalog.
 */
export function FacetSelect({
  label,
  value,
  options,
  onChange,
  disabled = false,
  placeholder = 'Select…',
  compactWhenSingle = false,
  formatOption = defaultFormatOption,
  hint,
}: FacetSelectProps) {
  if (options.length === 0) return null

  // Nothing to pick — a one-option <select> (or a dead chip) is noise.
  // The Coral / convert hint still has to surface under Runtime.
  if (compactWhenSingle && options.length === 1) {
    return hint ? <>{hint}</> : null
  }

  return (
    <Field label={label}>
      <Select
        wrapperClassName="inline-block w-auto"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        disabled={disabled || options.length === 0}
        className={REGISTER_SELECT_CLASS}
      >
        {value === '' && (
          <option value="" disabled>
            {placeholder}
          </option>
        )}
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {formatOption(option)}
          </option>
        ))}
      </Select>
      {hint}
    </Field>
  )
}
