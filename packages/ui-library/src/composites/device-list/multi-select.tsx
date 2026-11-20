import { useUiText } from '../../contexts/ui-text'
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type RefObject } from 'react'
import { TopLayerPortal } from '../../primitives/top-layer-portal'
import {
  computeListboxCoords,
  isScrollInside,
  type ListboxCoords,
} from '../../lib/listbox-position'
import { Check, ChevronDown, type LucideIcon } from 'lucide-react'

export interface MultiSelectOption {
  readonly id: string
  readonly label: string
  readonly icon?: LucideIcon
}

export interface MultiSelectDropdownProps {
  /** Trigger label, e.g. "Type". A count badge is appended when items are selected. */
  readonly label: string
  readonly options: readonly MultiSelectOption[]
  readonly selected: readonly string[]
  readonly onChange: (selected: readonly string[]) => void
  /** Draw an option's caption (a tag chip, …) instead of its plain `label`. */
  readonly renderOption?: (option: MultiSelectOption) => ReactNode
  /** Controls at the end of an option's row (style, rename, remove…), outside its toggle. */
  readonly optionActions?: (option: MultiSelectOption) => ReactNode
}

/**
 * Compact multi-select dropdown — a single chip-sized trigger ("Label · N")
 * that opens a checklist. Self-contained (outside-click / Escape dismiss), so
 * it stays compressed regardless of how many options exist or how little
 * horizontal room the container has. Shared by the device list's generic-mode
 * type filter and any other multi-select needs.
 */
const LIST_MIN_WIDTH_PX = 180

/**
 * Anchors a dropdown list to its trigger in viewport coordinates, so the list
 * can be portalled out of any scroll / overflow ancestor (a table's scroll
 * area would otherwise grow scrollbars when the list opens). It follows the
 * trigger on scroll and resize.
 */
export function useFloatingListbox(
  open: boolean,
  triggerRef: RefObject<HTMLElement | null>,
): { readonly listRef: RefObject<HTMLDivElement | null>; readonly coords: ListboxCoords | null } {
  const listRef = useRef<HTMLDivElement | null>(null)
  const [coords, setCoords] = useState<ListboxCoords | null>(null)
  useLayoutEffect(() => {
    if (!open) {
      setCoords(null)
      return
    }
    const update = (): void => {
      const trigger = triggerRef.current
      if (trigger) setCoords(computeListboxCoords(trigger, { minWidth: LIST_MIN_WIDTH_PX }))
    }
    update()
    const onScroll = (event: Event): void => {
      if (!isScrollInside(event, listRef.current)) update()
    }
    window.addEventListener('resize', update)
    window.addEventListener('scroll', onScroll, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', onScroll, true)
    }
  }, [open, triggerRef])
  return { listRef, coords }
}

export function MultiSelectDropdown({
  label,
  options,
  selected,
  onChange,
  renderOption,
  optionActions,
}: MultiSelectDropdownProps): ReactNode {
  const t = useUiText()
  const [open, setOpen] = useState(false)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const { listRef, coords } = useFloatingListbox(open, rootRef)

  useEffect(() => {
    if (!open) return
    const onOutside = (e: MouseEvent | TouchEvent): void => {
      const target = e.target instanceof Node ? e.target : null
      if (!target) return
      if (rootRef.current?.contains(target) || listRef.current?.contains(target)) return
      setOpen(false)
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
    // Preserve the source order of `options` so the value stays stable.
    onChange(options.filter((o) => next.has(o.id)).map((o) => o.id))
  }

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`inline-flex items-center gap-1.5 h-7 px-2.5 rounded-full border text-[10.5px] font-medium transition-colors ${
          count > 0
            ? 'border-primary/40 bg-primary/15 text-primary'
            : 'border-border bg-surface text-foreground-subtle hover:text-foreground hover:bg-surface-hover'
        }`}
      >
        <span>
          {label}
          {count > 0 ? ` · ${String(count)}` : ''}
        </span>
        <ChevronDown className={`h-3 w-3 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && coords !== null && typeof document !== 'undefined' && (
        <TopLayerPortal
          anchor={rootRef}
          surfaceRef={listRef}
          role="listbox"
          // ui-check-ok: fixed portal anchor from trigger getBoundingClientRect (same as Select)
          style={{
            position: 'fixed',
            top: coords.top,
            left: coords.left,
            minWidth: coords.width,
            maxHeight: coords.maxHeight,
          }}
          className="z-50 overflow-y-auto rounded-lg border border-border bg-surface shadow-xl py-1"
        >
          {count > 0 && (
            <button
              type="button"
              onClick={() => onChange([])}
              className="flex w-full items-center px-3 py-1.5 text-left text-[10.5px] text-foreground-subtle hover:bg-surface-hover hover:text-foreground"
            >
              {t('uiLibrary.multiSelect.clear', 'Clear selection')}
            </button>
          )}
          {options.map((o) => {
            const active = selectedSet.has(o.id)
            const Icon = o.icon
            const toggleButton = (
              <button
                key={o.id}
                type="button"
                role="option"
                aria-selected={active}
                onClick={() => toggle(o.id)}
                className="flex w-full min-w-0 items-center gap-2 px-3 py-1.5 text-left text-[10.5px] text-foreground hover:bg-surface-hover"
              >
                <span
                  className={`flex h-3.5 w-3.5 items-center justify-center rounded border shrink-0 ${active ? 'border-primary bg-primary' : 'border-border'}`}
                >
                  {active && <Check className="h-2.5 w-2.5 text-primary-foreground" />}
                </span>
                {Icon && <Icon className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />}
                {renderOption ? renderOption(o) : <span className="truncate">{o.label}</span>}
              </button>
            )
            if (optionActions === undefined) return toggleButton
            return (
              <div key={o.id} className="flex items-center pr-1">
                {toggleButton}
                <span className="flex shrink-0 items-center">{optionActions(o)}</span>
              </div>
            )
          })}
        </TopLayerPortal>
      )}
    </div>
  )
}
