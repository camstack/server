import { useUiText } from '../../contexts/ui-text'
import {
  Fragment,
  type JSX,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Check, ChevronDown, Plus, Search } from 'lucide-react'
import { Badge } from '../../primitives/badge'
import { TopLayerPortal } from '../../primitives/top-layer-portal'
import { EventKindGlyph } from '../event-kind-visuals'
import { INPUT_SHELL, SelectedChip } from '../device-picker/SelectedChip'
import type { OptionSelectOption } from './option-select-model'
import {
  draftFromQuery,
  filterOptions,
  partitionSelected,
  resolveSearchable,
  shouldShowAddNewFooter,
  shouldShowUseQueryRow,
} from './option-select-model'

const LISTBOX_GAP_PX = 4
const LISTBOX_MAX_HEIGHT_PX = 224 // max-h-56
const VIEWPORT_MARGIN_PX = 8

type ListboxCoords = {
  readonly top: number
  readonly left: number
  readonly width: number
  readonly maxHeight: number
  readonly placement: 'below' | 'above'
}

const LABEL_CLASS = 'block text-[11px] font-medium text-foreground mb-1 break-words'
const DESC_CLASS = 'text-[10px] text-foreground-subtle mt-0.5 break-words'

type OptionSelectSharedProps = {
  readonly options: readonly OptionSelectOption[]
  readonly placeholder?: string
  readonly searchable?: boolean
  readonly disabled?: boolean
  readonly emptyMessage?: string
  readonly creatable?: boolean
  readonly createLabel?: string
  readonly onCreateRequest?: (draft: string) => void
  readonly label?: string
  readonly description?: string
  readonly testId?: string
  readonly optionTestIdPrefix?: string
  readonly listboxId?: string
}

export type OptionSelectSingleProps = OptionSelectSharedProps & {
  readonly mode: 'single'
  /**
   * `chip` (default): the choice is a removable chip above the field.
   * `field`: the field itself shows the current choice (placeholder-style, so
   * typing searches), no chip and no clear — for a choice that always exists.
   */
  readonly singleDisplay?: 'chip' | 'field'
  readonly value: string
  readonly onChange: (next: string) => void
}

export type OptionSelectMultiProps = OptionSelectSharedProps & {
  readonly mode: 'multi'
  readonly value: readonly string[]
  readonly onChange: (next: string[]) => void
  readonly maxItems?: number
}

export type OptionSelectProps = OptionSelectSingleProps | OptionSelectMultiProps

function OptionIcon({ opt }: { readonly opt: OptionSelectOption }) {
  if (opt.iconUrl !== undefined) {
    return (
      <img src={opt.iconUrl} alt="" className="h-3.5 w-3.5 shrink-0 rounded-sm object-contain" />
    )
  }
  if (opt.iconId !== undefined) {
    return <EventKindGlyph iconId={opt.iconId} size={13} />
  }
  return null
}

export function OptionSelect(props: OptionSelectProps): JSX.Element | null {
  const t = useUiText()
  const {
    mode,
    options,
    placeholder = 'Select…',
    disabled = false,
    emptyMessage = 'No options available.',
    creatable = false,
    createLabel = 'Add new…',
    onCreateRequest,
    label,
    description,
    testId,
    optionTestIdPrefix,
    listboxId: listboxIdProp,
  } = props

  const isDisabled = disabled
  const searchable = resolveSearchable(options.length, creatable, props.searchable)
  const listboxId = listboxIdProp ?? testId ?? 'option-select-listbox'

  const selectedValues: readonly string[] =
    mode === 'single' ? (props.value.length > 0 ? [props.value] : []) : props.value

  const maxItems = mode === 'multi' ? props.maxItems : undefined
  const atMax = mode === 'multi' && maxItems !== undefined && selectedValues.length >= maxItems

  const [query, setQuery] = useState('')
  const [open, setOpen] = useState(false)
  const [highlight, setHighlight] = useState(0)
  const [coords, setCoords] = useState<ListboxCoords | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  const triggerRef = useRef<HTMLElement | null>(null)
  const listboxRef = useRef<HTMLDivElement | null>(null)
  const blurTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const computeListboxCoords = (): ListboxCoords | null => {
    const trigger = triggerRef.current
    if (trigger === null) return null
    const rect = trigger.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom - VIEWPORT_MARGIN_PX
    const spaceAbove = rect.top - VIEWPORT_MARGIN_PX
    const preferBelow =
      spaceBelow >= Math.min(LISTBOX_MAX_HEIGHT_PX, spaceAbove) || spaceBelow >= 120
    const maxHeight = Math.max(
      96,
      Math.min(LISTBOX_MAX_HEIGHT_PX, preferBelow ? spaceBelow : spaceAbove),
    )
    const left = Math.max(
      VIEWPORT_MARGIN_PX,
      Math.min(rect.left, window.innerWidth - rect.width - VIEWPORT_MARGIN_PX),
    )
    if (preferBelow) {
      return {
        top: rect.bottom + LISTBOX_GAP_PX,
        left,
        width: rect.width,
        maxHeight,
        placement: 'below',
      }
    }
    return {
      top: Math.max(VIEWPORT_MARGIN_PX, rect.top - LISTBOX_GAP_PX - maxHeight),
      left,
      width: rect.width,
      maxHeight,
      placement: 'above',
    }
  }

  const { selectedOptions } = useMemo(
    () => partitionSelected(options, selectedValues),
    [options, selectedValues],
  )

  const filtered = useMemo(() => filterOptions(options, query), [options, query])

  const showUseQuery = shouldShowUseQueryRow(creatable, query, options)
  const showAddNewFooter = shouldShowAddNewFooter(creatable, onCreateRequest !== undefined)

  type DropdownRow =
    | {
        readonly kind: 'option'
        readonly opt: OptionSelectOption
        readonly index: number
      }
    | { readonly kind: 'use-query'; readonly draft: string }

  const dropdownRows: readonly DropdownRow[] = useMemo(() => {
    const rows: DropdownRow[] = filtered.map((opt, index) => ({
      kind: 'option',
      opt,
      index,
    }))
    if (showUseQuery) {
      const draft = draftFromQuery(query)
      if (draft !== null) {
        rows.push({ kind: 'use-query', draft })
      }
    }
    return rows
  }, [filtered, showUseQuery, query])

  // Portal listbox: re-anchor on open / viewport change so the panel never
  // expands the form layout (dialogs with sticky footers).
  useLayoutEffect(() => {
    if (!open || isDisabled) {
      setCoords(null)
      return
    }
    const update = (): void => {
      setCoords(computeListboxCoords())
    }
    update()
    window.addEventListener('resize', update)
    window.addEventListener('scroll', update, true)
    return () => {
      window.removeEventListener('resize', update)
      window.removeEventListener('scroll', update, true)
    }
  }, [open, isDisabled, selectedValues.length, query, dropdownRows.length])

  useEffect(() => {
    if (!open) return
    const onPointer = (e: MouseEvent): void => {
      const target = e.target as Node
      if (listboxRef.current?.contains(target)) return
      if (triggerRef.current?.contains(target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', onPointer)
    return () => {
      document.removeEventListener('mousedown', onPointer)
    }
  }, [open])

  const commitDraft = (draft: string): void => {
    const trimmed = draft.trim()
    if (trimmed.length === 0) return
    if (onCreateRequest !== undefined) {
      onCreateRequest(trimmed)
      setQuery('')
      setOpen(false)
      return
    }
    if (mode === 'single') {
      props.onChange(trimmed)
      setQuery('')
      setOpen(false)
      return
    }
    if (props.value.includes(trimmed)) return
    if (maxItems !== undefined && props.value.length >= maxItems) return
    props.onChange([...props.value, trimmed])
    setQuery('')
  }

  const toggleMulti = (optValue: string): void => {
    if (mode !== 'multi' || isDisabled) return
    if (props.value.includes(optValue)) {
      props.onChange(props.value.filter((v) => v !== optValue))
    } else {
      if (maxItems !== undefined && props.value.length >= maxItems) return
      props.onChange([...props.value, optValue])
    }
  }

  const selectSingle = (optValue: string): void => {
    if (mode !== 'single' || isDisabled) return
    props.onChange(optValue)
    setQuery('')
    setOpen(false)
  }

  const activateRow = (row: DropdownRow): void => {
    if (row.kind === 'option') {
      if (row.opt.disabled === true) return
      if (mode === 'single') {
        selectSingle(row.opt.value)
      } else {
        toggleMulti(row.opt.value)
      }
    } else if (row.kind === 'use-query') {
      commitDraft(row.draft)
    }
  }

  const rowCount = dropdownRows.length + (showAddNewFooter && !showUseQuery ? 1 : 0)

  const handleKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => (rowCount === 0 ? 0 : (h + 1) % rowCount))
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      setOpen(true)
      setHighlight((h) => (rowCount === 0 ? 0 : (h - 1 + rowCount) % rowCount))
    } else if (e.key === 'Enter') {
      e.preventDefault()
      if (showUseQuery && highlight === dropdownRows.length) {
        const draft = draftFromQuery(query)
        if (draft !== null) commitDraft(draft)
        return
      }
      if (showAddNewFooter && !showUseQuery && highlight === dropdownRows.length) {
        inputRef.current?.focus()
        return
      }
      const row = dropdownRows[highlight]
      if (row) activateRow(row)
      else if (creatable) {
        const draft = draftFromQuery(query)
        if (draft !== null) commitDraft(draft)
      }
    } else if (e.key === 'Escape') {
      setOpen(false)
    } else if (
      e.key === 'Backspace' &&
      query === '' &&
      mode === 'multi' &&
      props.value.length > 0
    ) {
      props.onChange(props.value.slice(0, -1))
    }
  }

  const handleNonSearchKeyDown = (e: KeyboardEvent<HTMLButtonElement>): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      setOpen((o) => !o)
    } else if (e.key === 'Escape') {
      setOpen(false)
    }
  }

  const removeChip = (value: string): void => {
    if (mode === 'single') {
      props.onChange('')
    } else {
      props.onChange(props.value.filter((v) => v !== value))
    }
  }

  const triggerPlaceholder = atMax === true ? `Max ${maxItems} selected` : placeholder

  const showEmptyCatalog =
    options.length === 0 && !showUseQuery && dropdownRows.length === 0 && open

  let dropdownBody: ReactNode

  if (showEmptyCatalog) {
    dropdownBody = (
      <div className="px-2.5 py-2 text-[11px] text-foreground-subtle">{emptyMessage}</div>
    )
  } else if (dropdownRows.length === 0 && !creatable) {
    dropdownBody = (
      <div className="px-2.5 py-2 text-[11px] text-foreground-subtle italic">
        {t('uiLibrary.optionSelect.noMatches', 'No matches for “{{query}}”', {
          query,
        })}
      </div>
    )
  } else {
    dropdownBody = (
      <>
        {dropdownRows.map((row, i) => {
          if (row.kind === 'use-query') {
            return (
              <button
                key="__use-query__"
                type="button"
                role="option"
                aria-selected={false}
                className={[
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                  i === highlight ? 'bg-primary/10' : 'hover:bg-surface-hover',
                  'cursor-pointer',
                ].join(' ')}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => commitDraft(row.draft)}
              >
                <Plus className="h-3.5 w-3.5 shrink-0 text-primary" />
                <span className="truncate text-foreground">
                  {t('uiLibrary.optionSelect.use', 'Use “{{value}}”', {
                    value: row.draft,
                  })}
                </span>
              </button>
            )
          }
          if (row.kind !== 'option') return null
          const { opt } = row
          const checked =
            mode === 'single' ? props.value === opt.value : props.value.includes(opt.value)
          const blockedByMax = mode === 'multi' && !checked && atMax === true
          const optionDisabled = opt.disabled === true || blockedByMax
          const previous = dropdownRows[i - 1]
          const previousGroup =
            previous !== undefined && previous.kind === 'option' ? previous.opt.group : undefined
          const heading =
            opt.group !== undefined && opt.group !== previousGroup ? (
              <div
                role="presentation"
                className="px-2.5 pb-0.5 pt-1.5 text-[10px] font-medium uppercase tracking-wide text-foreground-subtle"
              >
                {opt.group}
              </div>
            ) : null
          return (
            <Fragment key={opt.value}>
              {heading}
              <button
                type="button"
                role="option"
                aria-selected={checked}
                disabled={optionDisabled}
                data-testid={
                  optionTestIdPrefix !== undefined
                    ? `${optionTestIdPrefix}-${opt.value}`
                    : undefined
                }
                className={[
                  'flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs transition-colors',
                  i === highlight ? 'bg-primary/10' : 'hover:bg-surface-hover',
                  optionDisabled ? 'opacity-40 cursor-not-allowed' : 'cursor-pointer',
                ].join(' ')}
                onMouseEnter={() => setHighlight(i)}
                onClick={() => activateRow(row)}
              >
                <span
                  className={[
                    'flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border',
                    checked ? 'border-primary bg-primary text-white' : 'border-border',
                  ].join(' ')}
                >
                  {checked && <Check className="h-2.5 w-2.5" />}
                </span>
                <OptionIcon opt={opt} />
                <span className="min-w-0 flex-1 truncate text-foreground">{opt.label}</span>
                {opt.badge !== undefined && opt.badge.length > 0 ? (
                  <Badge variant="default">{opt.badge}</Badge>
                ) : null}
              </button>
            </Fragment>
          )
        })}
      </>
    )
  }

  const footerAddNewIndex = dropdownRows.length
  const fieldShowsChoice =
    mode === 'single' && props.singleDisplay === 'field' && selectedOptions.length > 0

  return (
    <div className="min-w-0 space-y-1" data-testid={testId}>
      {label !== undefined && label.length > 0 && <label className={LABEL_CLASS}>{label}</label>}

      {mode === 'multi' && selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedOptions.map((opt) => (
            <SelectedChip
              key={opt.value}
              label={opt.label}
              {...(opt.iconUrl !== undefined ? { iconUrl: opt.iconUrl } : {})}
              {...(opt.iconId !== undefined ? { iconId: opt.iconId } : {})}
              {...(!isDisabled ? { onRemove: () => removeChip(opt.value) } : {})}
              {...(optionTestIdPrefix !== undefined
                ? { testId: `${optionTestIdPrefix}-chip-${opt.value}` }
                : {})}
            />
          ))}
        </div>
      )}

      {mode === 'single' && props.singleDisplay !== 'field' && selectedOptions.length > 0 && (
        <div className="flex flex-wrap gap-1 mb-1.5">
          {selectedOptions.map((opt) => (
            <SelectedChip
              key={opt.value}
              label={opt.label}
              {...(opt.iconUrl !== undefined ? { iconUrl: opt.iconUrl } : {})}
              {...(opt.iconId !== undefined ? { iconId: opt.iconId } : {})}
              {...(!isDisabled ? { onRemove: () => removeChip(opt.value) } : {})}
            />
          ))}
        </div>
      )}

      {searchable ? (
        <div
          ref={(el) => {
            triggerRef.current = el
          }}
          className={INPUT_SHELL + (isDisabled ? ' opacity-50' : '')}
        >
          <Search className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
          <input
            ref={inputRef}
            type="text"
            role="combobox"
            aria-expanded={open}
            aria-controls={listboxId}
            className="min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-foreground-disabled"
            // Closed, the field READS as the choice (a value, not a placeholder); open, it is the search box.
            value={
              fieldShowsChoice && !open && query === '' ? (selectedOptions[0]?.label ?? '') : query
            }
            placeholder={fieldShowsChoice ? (selectedOptions[0]?.label ?? '') : triggerPlaceholder}
            disabled={isDisabled}
            onChange={(e) => {
              setQuery(e.target.value)
              setOpen(true)
              setHighlight(0)
            }}
            onFocus={() => setOpen(true)}
            onBlur={() => {
              // Keep open while focus moves into the portaled listbox.
              blurTimer.current = setTimeout(() => {
                const active = document.activeElement
                if (listboxRef.current?.contains(active)) return
                setOpen(false)
              }, 120)
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
      ) : (
        <button
          ref={(el) => {
            triggerRef.current = el
          }}
          type="button"
          role="combobox"
          aria-expanded={open}
          aria-controls={listboxId}
          disabled={isDisabled}
          className={[
            INPUT_SHELL,
            'w-full justify-between text-xs text-foreground',
            isDisabled ? 'opacity-50 cursor-not-allowed' : 'cursor-pointer',
          ].join(' ')}
          onClick={() => !isDisabled && setOpen((o) => !o)}
          onKeyDown={handleNonSearchKeyDown}
        >
          <span className="truncate text-foreground-subtle">
            {selectedOptions[0]?.label ?? triggerPlaceholder}
          </span>
          <ChevronDown className="h-3.5 w-3.5 shrink-0 text-foreground-subtle" />
        </button>
      )}

      {open && !isDisabled && coords !== null && typeof document !== 'undefined' && (
        <TopLayerPortal
          anchor={triggerRef}
          surfaceRef={listboxRef}
          id={listboxId}
          role="listbox"
          style={
            {
              position: 'fixed',
              top: coords.top,
              left: coords.left,
              width: coords.width,
              maxHeight: coords.maxHeight,
              zIndex: 9999,
            } satisfies CSSProperties
          }
          className="overflow-y-auto rounded-md border border-border bg-surface shadow-lg"
          onMouseDown={(e) => {
            // Prevent input blur from racing the click.
            e.preventDefault()
            if (blurTimer.current) clearTimeout(blurTimer.current)
          }}
        >
          {dropdownBody}
          {showAddNewFooter && (
            <button
              type="button"
              className={[
                'flex w-full items-center gap-2 border-t border-border px-2.5 py-1.5 text-left text-xs transition-colors',
                footerAddNewIndex === highlight ? 'bg-primary/10' : 'hover:bg-surface-hover',
                'cursor-pointer text-primary',
              ].join(' ')}
              onMouseEnter={() => setHighlight(footerAddNewIndex)}
              onClick={() => {
                const draft = draftFromQuery(query)
                if (draft !== null) {
                  onCreateRequest?.(draft)
                  setQuery('')
                  setOpen(false)
                  return
                }
                inputRef.current?.focus()
              }}
            >
              <Plus className="h-3.5 w-3.5 shrink-0" />
              {createLabel}
            </button>
          )}
        </TopLayerPortal>
      )}

      {description !== undefined && description.length > 0 && (
        <p className={DESC_CLASS}>{description}</p>
      )}
    </div>
  )
}
