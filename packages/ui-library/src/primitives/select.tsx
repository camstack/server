import {
  type ButtonHTMLAttributes,
  type ForwardRefExoticComponent,
  type KeyboardEvent,
  type ReactNode,
  type RefAttributes,
  forwardRef,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import { cn } from '../lib/cn'
import { computeListboxCoords, isScrollInside, type ListboxCoords } from '../lib/listbox-position'
import { findByPrefix, nextEnabled, parseSelectEntries, type SelectEntry } from './select-model'
import { TopLayerPortal } from './top-layer-portal'

export interface SelectOption {
  value: string
  label: string
  disabled?: boolean
}

/** What a `Select` reports: the shape of the native event that callers read (`e.target.value`). */
export interface SelectChangeTarget {
  readonly value: string
  readonly name: string
}

export interface SelectChangeEvent {
  readonly target: SelectChangeTarget
  readonly currentTarget: SelectChangeTarget
  /** No-ops: the change is reported once, to this handler, and never bubbles (kept so a handler written for the native event still compiles). */
  stopPropagation(): void
  preventDefault(): void
}

type SelectButtonAttributes = Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'onChange' | 'value' | 'defaultValue' | 'children' | 'type' | 'role' | 'name'
>

export interface SelectProps extends SelectButtonAttributes {
  /** The choices. Omit it and pass `<option>` / `<optgroup>` children for a grouped or computed list. */
  options?: SelectOption[]
  /** `<option>` / `<optgroup>` children, read once per render into the dropdown list. */
  children?: ReactNode
  value?: string | number
  defaultValue?: string | number
  onChange?: (event: SelectChangeEvent) => void
  /** Submitted with a surrounding `<form>` through a hidden input. */
  name?: string
  required?: boolean
  /** Shown while the value matches no row. */
  placeholder?: string
  /** Classes of the wrapper that carries the chevron (default `relative w-full`). */
  wrapperClassName?: string
  /**
   * No field chrome: no border, a transparent background and no chevron. For a
   * dropdown that sits inside a control that already draws the box (a panel
   * row, a compact inline control) — a second border there reads as a field
   * inside a field.
   */
  bare?: boolean
}

const LISTBOX_MIN_WIDTH_PX = 160
const TYPE_AHEAD_RESET_MS = 700

/**
 * The common dropdown. It renders OUR list (a token-styled listbox in the top
 * layer), never the browser's native popup, and keeps the `<select>` calling
 * convention: `value` / `defaultValue`, `onChange` with `e.target.value`,
 * `options` or `<option>` / `<optgroup>` children, `name` (a hidden input),
 * `disabled`, `bare`.
 *
 * The trigger is a `combobox` button with `aria-haspopup="listbox"`; the list
 * is driven from the trigger (`aria-activedescendant`), so focus never leaves
 * it: arrows / Home / End move, Enter or Space pick, Escape closes (and is
 * swallowed, so a surrounding dialog stays open), letters type-ahead.
 *
 * `disabled:` classes belong HERE and not on each call site: a disabled
 * dropdown that looks live is the "language selector does not open" report of
 * 2026-08-15. Guarded by `disabled-affordance.test.tsx`.
 */
export const Select: ForwardRefExoticComponent<SelectProps & RefAttributes<HTMLButtonElement>> =
  forwardRef<HTMLButtonElement, SelectProps>(
    (
      {
        className,
        options,
        wrapperClassName,
        disabled,
        bare = false,
        children,
        value,
        defaultValue,
        onChange,
        name,
        required,
        placeholder,
        onKeyDown,
        onClick,
        ...props
      },
      ref,
    ) => {
      const entries: SelectEntry[] = useMemo(
        () => parseSelectEntries(options, children),
        [options, children],
      )
      const controlled = value !== undefined
      const [inner, setInner] = useState<string | undefined>(
        defaultValue === undefined ? undefined : String(defaultValue),
      )
      // Uncontrolled and untouched: like a native select, the first enabled row.
      const current: string | undefined = controlled
        ? String(value)
        : (inner ?? entries.find((e) => !e.disabled)?.value)
      const selectedIndex = entries.findIndex((e) => e.value === current)
      const selected = selectedIndex >= 0 ? entries[selectedIndex] : undefined

      const [open, setOpen] = useState(false)
      const [highlight, setHighlight] = useState(-1)
      const [coords, setCoords] = useState<ListboxCoords | null>(null)
      const triggerRef = useRef<HTMLButtonElement | null>(null)
      const listRef = useRef<HTMLDivElement | null>(null)
      const typed = useRef<{ text: string; at: number }>({ text: '', at: 0 })
      const listId = useId()
      const setTrigger = useCallback(
        (node: HTMLButtonElement | null): void => {
          triggerRef.current = node
          if (typeof ref === 'function') ref(node)
          else if (ref !== null) ref.current = node
        },
        [ref],
      )

      const isDisabled = disabled === true

      const openList = useCallback((): void => {
        if (isDisabled || entries.length === 0) return
        setHighlight(selectedIndex >= 0 ? selectedIndex : nextEnabled(entries, -1, 1))
        setOpen(true)
      }, [isDisabled, entries, selectedIndex])

      const closeList = useCallback((): void => {
        setOpen(false)
      }, [])

      const choose = (index: number): void => {
        const entry = entries[index]
        if (entry === undefined || entry.disabled) return
        setOpen(false)
        triggerRef.current?.focus()
        if (entry.value === current) return
        if (!controlled) setInner(entry.value)
        const target: SelectChangeTarget = {
          value: entry.value,
          name: name ?? '',
        }
        onChange?.({
          target,
          currentTarget: target,
          stopPropagation: () => {},
          preventDefault: () => {},
        })
      }

      useLayoutEffect(() => {
        if (!open) {
          setCoords(null)
          return
        }
        const update = (): void => {
          const trigger = triggerRef.current
          if (trigger !== null) {
            setCoords(computeListboxCoords(trigger, { minWidth: LISTBOX_MIN_WIDTH_PX }))
          }
        }
        update()
        window.addEventListener('resize', update)
        const onScroll = (event: Event): void => {
          if (!isScrollInside(event, listRef.current)) update()
        }
        window.addEventListener('scroll', onScroll, true)
        return () => {
          window.removeEventListener('resize', update)
          window.removeEventListener('scroll', onScroll, true)
        }
      }, [open])

      useEffect(() => {
        if (!open) return
        const onPointer = (e: MouseEvent): void => {
          const t = e.target
          if (!(t instanceof Node)) return
          if (listRef.current?.contains(t) || triggerRef.current?.contains(t)) return
          closeList()
        }
        document.addEventListener('mousedown', onPointer)
        return () => document.removeEventListener('mousedown', onPointer)
      }, [open, closeList])

      // A disabled-while-open select closes; keep the highlighted row visible.
      useEffect(() => {
        if (isDisabled) setOpen(false)
      }, [isDisabled])
      // Keyed on whether the list is PLACED, not on its coordinates: a
      // re-anchor (an ancestor scrolled) must not drag the operator's own
      // scroll position back to the highlighted row.
      const placed = coords !== null
      useEffect(() => {
        if (!open || !placed || highlight < 0) return
        listRef.current?.querySelector(`[data-index="${highlight}"]`)?.scrollIntoView?.({
          block: 'nearest',
        })
      }, [open, highlight, placed])

      const typeAhead = (key: string): void => {
        const now = Date.now()
        const prior = now - typed.current.at > TYPE_AHEAD_RESET_MS ? '' : typed.current.text
        const text = prior + key
        typed.current = { text, at: now }
        const idx = findByPrefix(entries, text, open ? highlight : selectedIndex)
        if (idx < 0) return
        if (open) setHighlight(idx)
        else choose(idx)
      }

      const handleKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
        onKeyDown?.(e)
        if (e.defaultPrevented || isDisabled) return
        const k = e.key
        if (!open) {
          if (k === 'ArrowDown' || k === 'ArrowUp' || k === 'Enter' || k === ' ') {
            e.preventDefault()
            openList()
          } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
            typeAhead(k)
          }
          return
        }
        if (k === 'Escape') {
          e.preventDefault()
          e.stopPropagation()
          closeList()
        } else if (k === 'Tab') {
          closeList()
        } else if (k === 'ArrowDown') {
          e.preventDefault()
          setHighlight((h) => nextEnabled(entries, h, 1))
        } else if (k === 'ArrowUp') {
          e.preventDefault()
          setHighlight((h) => nextEnabled(entries, h, -1))
        } else if (k === 'Home') {
          e.preventDefault()
          setHighlight(nextEnabled(entries, -1, 1))
        } else if (k === 'End') {
          e.preventDefault()
          setHighlight(nextEnabled(entries, 0, -1))
        } else if (k === 'Enter' || k === ' ') {
          e.preventDefault()
          if (highlight >= 0) choose(highlight)
          else closeList()
        } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
          typeAhead(k)
        }
      }

      const label = selected?.label ?? placeholder ?? ''
      const showMuted = selected === undefined || selected.value === ''
      const activeId = open && highlight >= 0 ? `${listId}-${highlight}` : undefined

      const rows: ReactNode[] = []
      let lastGroup: string | null = null
      entries.forEach((entry, index) => {
        if (entry.group !== null && entry.group !== lastGroup) {
          rows.push(
            <div
              key={`g-${entry.group}-${index}`}
              role="presentation"
              className="px-2.5 pt-1.5 pb-0.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle"
            >
              {entry.group}
            </div>,
          )
        }
        lastGroup = entry.group
        const isSelected = index === selectedIndex
        rows.push(
          <div
            key={`o-${entry.value}-${index}`}
            id={`${listId}-${index}`}
            role="option"
            aria-selected={isSelected}
            aria-disabled={entry.disabled || undefined}
            data-index={index}
            data-value={entry.value}
            className={cn(
              'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs',
              entry.group !== null && 'pl-4',
              entry.disabled
                ? 'cursor-not-allowed text-foreground-disabled'
                : 'cursor-pointer text-foreground',
              !entry.disabled && index === highlight && 'bg-surface-hover',
              isSelected && 'font-medium text-primary',
            )}
            onMouseEnter={() => !entry.disabled && setHighlight(index)}
            onClick={() => choose(index)}
          >
            <span className="min-w-0 flex-1 truncate">{entry.label}</span>
            {isSelected && <Check className="h-3.5 w-3.5 shrink-0" />}
          </div>,
        )
      })

      return (
        <div className={cn(bare ? 'relative min-w-0' : 'relative w-full', wrapperClassName)}>
          <button
            {...props}
            ref={setTrigger}
            type="button"
            role="combobox"
            aria-haspopup="listbox"
            aria-expanded={open}
            aria-controls={open ? listId : undefined}
            aria-activedescendant={activeId}
            aria-required={required === true ? true : undefined}
            value={current ?? ''}
            disabled={isDisabled}
            onKeyDown={handleKeyDown}
            onClick={(e) => {
              onClick?.(e)
              if (e.defaultPrevented) return
              if (open) closeList()
              else openList()
            }}
            className={cn(
              'flex items-center text-left text-xs focus:outline-none',
              bare
                ? 'w-full gap-1'
                : 'h-7 w-full px-2.5 border border-border rounded-md pr-7 focus-visible:ring-1 focus-visible:ring-primary',
              'disabled:opacity-50 disabled:cursor-not-allowed',
              className,
              // Last, so twMerge keeps them: a caller-supplied bg-* must never leave it transparent.
              bare ? 'bg-transparent text-foreground' : 'bg-surface text-foreground',
            )}
          >
            <span className={cn('min-w-0 flex-1 truncate', showMuted && 'text-foreground-muted')}>
              {label}
            </span>
          </button>
          {name !== undefined && <input type="hidden" name={name} value={current ?? ''} />}
          {/* The chevron travels with the field: an arrow at full strength over a
            dimmed control reads as "this one is still clickable". */}
          {!bare && (
            <div
              className={cn(
                'absolute right-2 top-1/2 -translate-y-1/2 pointer-events-none text-foreground-muted',
                isDisabled ? 'opacity-50' : '',
              )}
            >
              <ChevronDown className="h-3.5 w-3.5" />
            </div>
          )}
          {open && coords !== null && typeof document !== 'undefined' && (
            <TopLayerPortal
              anchor={triggerRef}
              surfaceRef={listRef}
              id={listId}
              role="listbox"
              // ui-check-ok: computed viewport geometry of the floating list
              style={{
                position: 'fixed',
                top: coords.top,
                left: coords.left,
                width: coords.width,
                maxHeight: coords.maxHeight,
                zIndex: 9999,
              }}
              className="overflow-y-auto rounded-md border border-border bg-surface py-1 shadow-lg"
              onMouseDown={(e) => {
                // Keep focus on the trigger.
                e.preventDefault()
              }}
              // React bubbles through a portal: a click on a row must not reach the
              // card / row the select sits in (which would navigate or toggle).
              onClick={(e) => e.stopPropagation()}
            >
              {rows}
            </TopLayerPortal>
          )}
        </div>
      )
    },
  )

Select.displayName = 'Select'
