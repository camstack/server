/**
 * <FilterChips> — top-row filter UI for DeviceList.
 *
 * Layout: [Type chips] [Integration multi-select] [Clear filters]
 * (search input lives separately; this component only handles the
 * chip-style selectors + the integration dropdown).
 *
 * Type is radio-like (clicking the active chip clears it). Integration
 * is a compact MULTI-select dropdown — previously every integration
 * spilled into the row as inline chips and only one could be active;
 * now a single "Integration" button opens a checkbox menu so several
 * integrations can be filtered at once without flooding the toolbar.
 */
import { useUiText } from '../../contexts/ui-text'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Check, ChevronDown, X } from 'lucide-react'
import { cn } from '../../lib/cn'
import { ResponsiveTypeFilter } from './type-filter'
import type { MultiSelectOption } from './multi-select'

export interface FilterChipsAddonOption {
  readonly id: string
  readonly name: string
  readonly icon?: ReactNode
}

export interface FilterChipsProps {
  /**
   * Ready-made options for the shared multi-select type filter. Built once by
   * the caller from the exhaustive device-type meta (`allDeviceTypeFilterOptions`)
   * so the option set is complete + identical everywhere. Omit to hide the
   * type filter entirely.
   */
  readonly typeOptions?: readonly MultiSelectOption[]
  readonly selectedTypes: readonly string[]
  readonly onTypesChange: (types: readonly string[]) => void
  readonly addons?: readonly FilterChipsAddonOption[]
  /** Currently-selected integration ids (multi-select). */
  readonly selectedAddons: readonly string[]
  readonly onAddonsChange: (addons: readonly string[]) => void
  /** When true, the addon group is hidden (used by Integrations expand-row inner DeviceList). */
  readonly hideAddons?: boolean
  /**
   * Free-text search, read ONLY to decide whether any filter is set. The input
   * itself lives outside this component; a Clear that ignored it would leave
   * the list filtered after the operator was told it had been cleared.
   */
  readonly query?: string
  /** Clear every filter at once. Omit to hide the affordance entirely. */
  readonly onClearFilters?: () => void
}

export function FilterChips({
  typeOptions,
  selectedTypes,
  onTypesChange,
  addons,
  selectedAddons,
  onAddonsChange,
  hideAddons = false,
  query = '',
  onClearFilters,
}: FilterChipsProps): ReactNode {
  const t = useUiText()
  // Shown only when there is something TO clear — a permanently visible Clear
  // that does nothing most of the time teaches the operator to ignore it.
  const hasActiveFilter =
    selectedTypes.length > 0 || selectedAddons.length > 0 || query.trim().length > 0
  return (
    <div className="flex items-center gap-2 flex-wrap">
      {/* Type filter — shared responsive multi-select (chips ↔ dropdown by
          available width). Same component the adoption modal uses. */}
      {typeOptions && typeOptions.length > 0 && (
        <ResponsiveTypeFilter
          label={t('uiLibrary.filterChips.type', 'Type')}
          options={typeOptions}
          selected={selectedTypes}
          onChange={onTypesChange}
        />
      )}

      {/* Integration multi-select */}
      {!hideAddons && addons && addons.length > 0 && (
        <IntegrationMultiSelect
          addons={addons}
          selected={selectedAddons}
          onChange={onAddonsChange}
        />
      )}

      {/* Clear — last in the row, and present ONLY while something is filtered.
          It clears the search box too, which is why `query` is a prop here even
          though the input is rendered elsewhere: telling the operator the
          filters are cleared while a search term still narrows the list is
          worse than not offering the button. */}
      {onClearFilters !== undefined && hasActiveFilter && (
        <button
          type="button"
          onClick={onClearFilters}
          className="inline-flex items-center gap-1 h-7 rounded-md border border-border bg-surface px-2 text-[10.5px] text-foreground-subtle transition-colors hover:text-foreground hover:border-foreground-subtle/40"
        >
          <X className="h-3 w-3" />
          {t('uiLibrary.filterChips.clearFilters', 'Clear filters')}
        </button>
      )}
    </div>
  )
}

// ── Integration multi-select dropdown ───────────────────────────────

interface IntegrationMultiSelectProps {
  readonly addons: readonly FilterChipsAddonOption[]
  readonly selected: readonly string[]
  readonly onChange: (addons: readonly string[]) => void
}

function IntegrationMultiSelect({
  addons,
  selected,
  onChange,
}: IntegrationMultiSelectProps): ReactNode {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)

  // Dismiss on outside click / tap / Escape.
  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent | TouchEvent): void => {
      const target = e.target as Node | null
      if (target && rootRef.current && !rootRef.current.contains(target)) setOpen(false)
    }
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onOutside)
    document.addEventListener('touchstart', onOutside)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onOutside)
      document.removeEventListener('touchstart', onOutside)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  const selectedSet = new Set(selected)
  const count = selected.length
  const toggle = (id: string): void => {
    const next = new Set(selectedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    // Preserve the source order of `addons` so the URL value is stable.
    onChange(addons.filter((a) => next.has(a.id)).map((a) => a.id))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className={cn(
          'inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[10.5px] font-medium transition-colors',
          count > 0
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
        )}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span>
          {count > 0
            ? t('uiLibrary.filterChips.integrationCount', 'Integration · {{count}}', { count })
            : t('uiLibrary.filterChips.integration', 'Integration')}
        </span>
        <ChevronDown className={cn('h-3 w-3 transition-transform', open && 'rotate-180')} />
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-[180px] max-h-72 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl py-1"
        >
          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex w-full items-center px-3 py-1.5 text-left text-[10.5px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            >
              {t('uiLibrary.filterChips.clearSelection', 'Clear selection')}
            </button>
          )}
          {addons.map((a) => {
            const active = selectedSet.has(a.id)
            return (
              <button
                key={a.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => toggle(a.id)}
                className={cn(
                  'flex w-full items-center gap-2 px-3 py-1.5 text-left text-[10.5px] transition-colors',
                  active ? 'text-primary' : 'text-foreground hover:bg-surface-hover',
                )}
              >
                <span
                  className={cn(
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                    active ? 'border-primary bg-primary/20' : 'border-border',
                  )}
                >
                  {active && <Check className="h-2.5 w-2.5" />}
                </span>
                {a.icon && <span className="inline-flex items-center">{a.icon}</span>}
                <span className="truncate">{a.name}</span>
              </button>
            )
          })}
        </div>
      )}
    </div>
  )
}
