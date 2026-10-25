import { useUiText } from '../contexts/ui-text'
import type {
  ConfigDeviceMultiSelectField,
  ConfigDeviceSelectField,
  ConfigOption,
} from '@camstack/types'
import { Check, ChevronDown, Search, X } from 'lucide-react'
import { useMemo, useRef, useState, type JSX } from 'react'
import { useDeviceManagerListAll } from '../generated/system-hooks'
import { Dropdown, DropdownContent, DropdownTrigger } from '../primitives/dropdown'
import type { TranslationFn } from './config-form-builder'
import { resolveLabel } from './config-form-builder'
import {
  type DeviceOption,
  type DeviceSelectCandidate,
  deviceFacets,
  devicesToOptions,
  type FacetSelection,
  filterDeviceOptions,
  matchesFacets,
  NO_FACETS,
  partitionSuggested,
  type SuggestionFleetDevice,
  sameLocationSuggestions,
  selectedDeviceOptions,
} from './device-select-filter'

/**
 * `device-select` / `device-multiselect` renderers.
 *
 * Both fetch EVERY system device via `deviceManager.listAll` and narrow the
 * options CLIENT-SIDE with the field's declarative `deviceFilter` (see
 * `device-select-filter.ts`). No server-computed option list is involved —
 * the form field carries only the filter. Value(s) are device ids as strings.
 *
 * The multi variant is a searchable combobox (removable chips + typeahead
 * dropdown); the single variant is a native
 * select. Both are inline in ui-library (like `node-select`) so any host that
 * renders the shared form field gets them without extra registration.
 */

const INPUT_CLASS =
  'w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-xs text-foreground focus:border-primary focus:ring-1 focus:ring-primary/30 outline-none disabled:opacity-50 disabled:cursor-not-allowed'
const INPUT_SHELL =
  'flex items-center gap-1.5 rounded-md border border-border bg-background px-2 py-1.5 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary/30'
const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1 break-words'
const DESC_CLASS = 'text-[10px] text-foreground-subtle mt-0.5 break-words'

/** A listAll row as the fields read it: the option's facts, and what the suggestion rule needs. */
type FieldCandidate = DeviceSelectCandidate & SuggestionFleetDevice

function stringOrNull(v: unknown): string | null {
  return typeof v === 'string' ? v : null
}

/** The compact projection of the listAll rows the device fields consume. */
function toCandidates(rows: unknown): readonly FieldCandidate[] {
  if (!Array.isArray(rows)) return []
  const nameById = new Map<number, string>()
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.id === 'number' && typeof r.name === 'string') nameById.set(r.id, r.name)
  }
  const out: FieldCandidate[] = []
  for (const row of rows) {
    if (typeof row !== 'object' || row === null) continue
    const r = row as Record<string, unknown>
    if (typeof r.id !== 'number' || typeof r.type !== 'string' || typeof r.name !== 'string') {
      continue
    }
    // A container child is named after its container (`in <Container>`):
    // "Faretti hall 2" alone does not say which switch it is.
    const parentName =
      typeof r.parentDeviceId === 'number' ? (nameById.get(r.parentDeviceId) ?? null) : null
    out.push({
      id: r.id,
      type: r.type,
      name: r.name,
      location: typeof r.location === 'string' ? r.location : null,
      features: Array.isArray(r.features)
        ? r.features.filter((f): f is string => typeof f === 'string')
        : [],
      parentName,
      stableId: typeof r.stableId === 'string' ? r.stableId : '',
      parentDeviceId: typeof r.parentDeviceId === 'number' ? r.parentDeviceId : null,
      primaryChildEntityId: stringOrNull(r.primaryChildEntityId),
      role: stringOrNull(r.role),
    })
  }
  return out
}

const GROUP_HEADING =
  'px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle'

const FACET_TRIGGER =
  'inline-flex max-w-full items-center gap-1 rounded-md border border-border bg-background px-2 py-1 text-[11px] text-foreground hover:bg-surface-hover'
const FACET_ITEM =
  'flex h-7 w-full items-center gap-2 px-2 text-left text-xs text-foreground hover:bg-surface-hover'

/**
 * One facet as a compact MULTI-select dropdown: closed it is one line
 * ("Location · Kitchen, Hall"), open it lists every value with a check.
 * The operator asked for dropdowns over rows of chips (2026-09-05): with
 * sixteen rooms and a dozen types the chips ate the panel.
 */
function FacetDropdown({
  label,
  values,
  chosen,
  onChange,
}: {
  readonly label: string
  readonly values: readonly string[]
  readonly chosen: readonly string[]
  readonly onChange: (next: readonly string[]) => void
}) {
  const t = useUiText()
  if (values.length < 2) return null
  const summary =
    chosen.length === 0 ? t('uiLibrary.deviceSelectField.all', 'All') : chosen.join(', ')
  const toggle = (value: string): void => {
    onChange(chosen.includes(value) ? chosen.filter((v) => v !== value) : [...chosen, value])
  }
  return (
    <Dropdown>
      <DropdownTrigger className={FACET_TRIGGER}>
        <span className="text-foreground-subtle">{label}</span>
        <span aria-hidden="true">·</span>
        <span className="truncate">{summary}</span>
        <ChevronDown className="h-3 w-3 shrink-0 text-foreground-subtle" />
      </DropdownTrigger>
      <DropdownContent className="max-h-56 overflow-y-auto">
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={chosen.length === 0}
          className={FACET_ITEM}
          onClick={() => onChange([])}
        >
          <span className="inline-flex h-3.5 w-3.5 items-center justify-center rounded border border-border">
            {chosen.length === 0 && <Check className="h-2.5 w-2.5" />}
          </span>
          {t('uiLibrary.deviceSelectField.all', 'All')}
        </button>
        {values.map((v) => {
          const on = chosen.includes(v)
          return (
            <button
              key={v}
              type="button"
              role="menuitemcheckbox"
              aria-checked={on}
              className={FACET_ITEM}
              onClick={() => toggle(v)}
            >
              <span
                className={[
                  'inline-flex h-3.5 w-3.5 items-center justify-center rounded border',
                  on ? 'border-primary bg-primary text-white' : 'border-border',
                ].join(' ')}
              >
                {on && <Check className="h-2.5 w-2.5" />}
              </span>
              {v}
            </button>
          )
        })}
      </DropdownContent>
    </Dropdown>
  )
}

function FieldShell({
  label,
  description,
  required,
  translationFn,
  children,
}: {
  label?: string
  description?: string
  required?: boolean
  translationFn?: TranslationFn
  children: React.ReactNode
}) {
  const resolvedLabel = resolveLabel(label, translationFn)
  const resolvedDescription = resolveLabel(description, translationFn)
  const hasLabel = resolvedLabel !== undefined && resolvedLabel !== ''
  return (
    <div className="min-w-0">
      {hasLabel && (
        <label className={LABEL_CLASS}>
          {resolvedLabel}
          {required && <span className="text-danger ml-0.5">*</span>}
        </label>
      )}
      {children}
      {resolvedDescription && <p className={DESC_CLASS}>{resolvedDescription}</p>}
    </div>
  )
}

export function DeviceSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigDeviceSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}): JSX.Element | null {
  const t = useUiText()
  const { data } = useDeviceManagerListAll({})
  const options = useMemo(
    () => devicesToOptions(toCandidates(data), field.deviceFilter),
    [data, field.deviceFilter],
  )
  const current = value === undefined || value === null ? '' : String(value)
  return (
    <FieldShell
      label={field.label}
      description={field.description}
      required={field.required}
      translationFn={translationFn}
    >
      <select
        className={INPUT_CLASS}
        value={current}
        disabled={disabled || field.disabled}
        onChange={(e) => onChange(e.target.value)}
      >
        {!field.required && (
          <option value="">{t('uiLibrary.deviceSelectField.select', '— Select device —')}</option>
        )}
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </FieldShell>
  )
}

export function DeviceMultiSelectField({
  field,
  value,
  onChange,
  disabled,
  translationFn,
}: {
  field: ConfigDeviceMultiSelectField
  value: unknown
  onChange: (v: unknown) => void
  disabled?: boolean
  translationFn?: TranslationFn
}): JSX.Element | null {
  const t = useUiText()
  const { data } = useDeviceManagerListAll({})
  // The smart picker (linked devices): facets narrow the catalogue BEFORE
  // the search, and the room's own devices are suggested first. Both exist
  // only when the field names a location to suggest.
  const smart = field.suggestLocation !== undefined
  const [facets, setFacets] = useState<FacetSelection>(NO_FACETS)
  const candidates = useMemo(() => toCandidates(data), [data])
  const facetValues = useMemo(
    () => deviceFacets(candidates.filter((c) => c.id !== field.deviceFilter?.excludeDeviceId)),
    [candidates, field.deviceFilter?.excludeDeviceId],
  )
  const candidatesInScope = useMemo(
    () => (smart ? candidates.filter((c) => matchesFacets(c, facets)) : candidates),
    [candidates, facets, smart],
  )
  const options = useMemo<DeviceOption[]>(
    () => devicesToOptions(candidatesInScope, field.deviceFilter),
    [candidatesInScope, field.deviceFilter],
  )

  const selected = Array.isArray(value) ? value.map(String) : []
  const isDisabled = disabled === true || field.disabled === true
  const atMax = field.maxItems !== undefined && selected.length >= field.maxItems

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const selectedOptions = useMemo<ConfigOption[]>(
    () => selectedDeviceOptions(options, selected),
    [options, selected],
  )
  const searched = useMemo(() => filterDeviceOptions(options, query), [options, query])
  // Suggested first, then the rest: ONE ordered list for the keyboard, two
  // headed groups for the eye. A container family is suggested by its
  // primary child only (D749).
  const suggestedIds = useMemo(
    () => sameLocationSuggestions(candidates, smart ? field.suggestLocation : null),
    [candidates, smart, field.suggestLocation],
  )
  const partition = useMemo(
    () => partitionSuggested(searched, suggestedIds, (o) => Number(o.value)),
    [searched, suggestedIds],
  )
  const filtered = useMemo(() => [...partition.suggested, ...partition.others], [partition])
  const toggle = (optValue: string): void => {
    if (isDisabled) return
    if (selected.includes(optValue)) {
      onChange(selected.filter((v) => v !== optValue))
    } else {
      if (field.maxItems !== undefined && selected.length >= field.maxItems) return
      onChange([...selected, optValue])
    }
  }

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => (filtered.length === 0 ? 0 : (h + 1) % filtered.length))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => (filtered.length === 0 ? 0 : (h - 1 + filtered.length) % filtered.length))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const opt = filtered[highlight]
      if (opt) toggle(opt.value)
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (e.key === 'Backspace' && query === '' && selected.length > 0) {
      onChange(selected.slice(0, -1))
    }
  }

  const label = resolveLabel(field.label, translationFn)
  const description = resolveLabel(field.description, translationFn)
  const hasLabel = label !== undefined && label !== ''

  return (
    <div className="min-w-0">
      {hasLabel && <label className={LABEL_CLASS}>{label}</label>}

      {selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedOptions.map((opt) => (
            <span
              key={opt.value}
              className="inline-flex items-center gap-1 rounded-md bg-primary/10 px-1.5 py-0.5 text-[11px] text-primary max-w-full"
            >
              <span className="truncate">{opt.label}</span>
              {!isDisabled && (
                <button
                  type="button"
                  className="shrink-0 hover:text-danger"
                  aria-label={t('uiLibrary.deviceSelectField.remove', 'Remove {{label}}', {
                    label: opt.label,
                  })}
                  onClick={() => toggle(opt.value)}
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              )}
            </span>
          ))}
        </div>
      )}

      {smart && (
        <div className="mb-1.5 flex flex-wrap gap-1.5">
          <FacetDropdown
            label={t('uiLibrary.deviceSelectField.location', 'Location')}
            values={facetValues.locations}
            chosen={facets.locations}
            onChange={(locations) => setFacets((f) => ({ ...f, locations }))}
          />
          <FacetDropdown
            label={t('uiLibrary.deviceSelectField.type', 'Type')}
            values={facetValues.types}
            chosen={facets.types}
            onChange={(types) => setFacets((f) => ({ ...f, types }))}
          />
        </div>
      )}
      <div className={INPUT_SHELL + (isDisabled ? ' opacity-50' : '')}>
        <Search className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-label={field.label}
          aria-expanded={open}
          aria-controls={`dsel-${field.key}`}
          className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-disabled"
          value={query}
          placeholder={
            atMax
              ? t('uiLibrary.deviceSelectField.max', 'Max {{count}} selected', {
                  count: field.maxItems,
                })
              : (field.placeholder ?? t('uiLibrary.deviceSelectField.search', 'Search devices…'))
          }
          disabled={isDisabled}
          onChange={(e) => {
            setQuery(e.target.value)
            setOpen(true)
            setHighlight(0)
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => {
            blurTimer.current = setTimeout(() => setOpen(false), 120)
          }}
          onKeyDown={handleKeyDown}
        />
        <ChevronDown
          className="h-3.5 w-3.5 shrink-0 cursor-pointer text-foreground-subtle"
          onMouseDown={(e) => {
            e.preventDefault()
            if (blurTimer.current) clearTimeout(blurTimer.current)
            setOpen((o) => !o)
            inputRef.current?.focus()
          }}
        />
      </div>

      {open && !isDisabled && (
        <div
          id={`dsel-${field.key}`}
          role="listbox"
          className="mt-1 max-h-56 overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
          onMouseDown={(e) => {
            e.preventDefault()
          }}
        >
          {filtered.length === 0 ? (
            <div className="px-2.5 py-2 text-[11px] text-foreground-subtle italic">
              {options.length === 0
                ? t('uiLibrary.deviceSelectField.noDevices', 'No matching devices')
                : t('uiLibrary.deviceSelectField.noMatches', 'No matches for “{{query}}”', {
                    query,
                  })}
            </div>
          ) : (
            filtered.map((opt, i) => {
              const checked = selected.includes(opt.value)
              const blockedByMax = !checked && atMax
              const suggestedCount = partition.suggested.length
              const heading = !smart
                ? null
                : i === 0 && suggestedCount > 0
                  ? `Suggested · ${field.suggestLocation ?? ''}`
                  : i === suggestedCount && suggestedCount > 0
                    ? 'Other devices'
                    : null
              return (
                <div key={opt.value}>
                  {heading !== null && <div className={GROUP_HEADING}>{heading}</div>}
                  <button
                    type="button"
                    role="option"
                    aria-selected={checked}
                    disabled={blockedByMax}
                    className={[
                      'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                      i === highlight ? 'bg-primary/10' : 'hover:bg-surface-hover',
                      blockedByMax ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                    ].join(' ')}
                    onMouseEnter={() => setHighlight(i)}
                    onClick={() => toggle(opt.value)}
                  >
                    <span
                      className={[
                        'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                        checked ? 'border-primary bg-primary text-white' : 'border-border',
                      ].join(' ')}
                    >
                      {checked && <Check className="h-2.5 w-2.5" />}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-foreground">{opt.label}</span>
                      {opt.description !== undefined && (
                        <span className="block truncate text-[10px] text-foreground-subtle">
                          {opt.description}
                        </span>
                      )}
                    </span>
                  </button>
                </div>
              )
            })
          )}
        </div>
      )}

      {description && <p className={DESC_CLASS}>{description}</p>}
    </div>
  )
}
