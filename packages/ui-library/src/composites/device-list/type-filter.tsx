import { useEffect, useRef, useState, type ReactNode } from 'react'
import { MultiSelectDropdown, type MultiSelectOption } from './multi-select'

export interface ResponsiveTypeFilterProps {
  readonly label: string
  readonly options: readonly MultiSelectOption[]
  readonly selected: readonly string[]
  readonly onChange: (selected: readonly string[]) => void
}

/**
 * Shared, multi-select type filter that adapts to its OWN available width
 * (measured via ResizeObserver, NOT the viewport — the adoption modal and the
 * Devices page differ at the same screen size):
 *   - wide enough  → inline toggle chips (Devices page stays chips)
 *   - too narrow   → the compact <MultiSelectDropdown> (adoption modal collapses)
 *
 * One component for every list consumer, so the filter looks and behaves the
 * same everywhere and only the FORM changes with available room.
 */
export function ResponsiveTypeFilter({
  label,
  options,
  selected,
  onChange,
}: ResponsiveTypeFilterProps): ReactNode {
  const ref = useRef<HTMLDivElement | null>(null)
  const [width, setWidth] = useState<number | null>(null)

  useEffect(() => {
    const el = ref.current
    // No ResizeObserver (SSR / jsdom) → stay on the compact dropdown default.
    if (!el || typeof ResizeObserver === 'undefined') return
    const ro = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (entry) setWidth(entry.contentRect.width)
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const selectedSet = new Set(selected)
  const toggle = (id: string): void => {
    const next = new Set(selectedSet)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id))
  }

  // Rough width the inline chips need: the label + ~88px per chip. Collapse to
  // the dropdown when the measured room can't hold them. Until first measure,
  // default to the dropdown (safe on narrow surfaces, no layout jump on wide
  // ones once the observer fires).
  const chipsEstimatePx = 56 + options.length * 88
  const useChips = width !== null && width >= chipsEstimatePx

  return (
    <div ref={ref} className="min-w-0 flex-1">
      {useChips ? (
        <div className="flex items-center gap-1.5 flex-wrap">
          <span className="text-[10px] font-medium uppercase tracking-wider text-foreground-subtle">
            {label}
          </span>
          {options.map((o) => {
            const active = selectedSet.has(o.id)
            const Icon = o.icon
            return (
              <button
                key={o.id}
                type="button"
                onClick={() => toggle(o.id)}
                aria-pressed={active}
                className={`inline-flex items-center gap-1 h-7 px-2.5 rounded-full border text-[10.5px] font-medium transition-colors ${
                  active
                    ? 'border-primary/40 bg-primary/15 text-primary'
                    : 'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
                }`}
              >
                {Icon && <Icon className="h-3 w-3 shrink-0" />}
                {o.label}
              </button>
            )
          })}
        </div>
      ) : (
        <MultiSelectDropdown
          label={label}
          options={options}
          selected={selected}
          onChange={onChange}
        />
      )}
    </div>
  )
}
