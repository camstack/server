/**
 * icon-picker — the ONE control for choosing an icon, wherever admin-ui asks.
 *
 * One view over the ONE icon catalog (`@camstack/types`' `icon-catalog`, D854):
 * every lucide icon both surfaces can draw, filed under its primary lucide
 * category, searched over the key, the Italian/English overlay and lucide's own
 * English tags. There is no curated section and no per-caller subset — a device
 * override, a room and a settings field all choose from the same ~1,700 icons.
 *
 * ## It is virtualised
 *
 * ~1,700 tiles is too many to mount at once (and each is an SVG component whose
 * glyph may still be loading). The list is flattened into fixed-height rows —
 * a category header or a row of seven tiles — and only the rows in (or just
 * past) the scrolled window are rendered; two spacers stand in for the rest.
 * Opening the popover mounts ~20 rows, and typing re-filters the same window.
 *
 * ## What it does NOT own
 *
 * - **The words.** Every string is a prop. This package has no i18n (one file
 *   in it imports react-i18next, and that is the exception). Section titles are
 *   derived from the lucide category id unless the caller supplies
 *   `categoryLabel`.
 * - **The write.** `onPick` is called and that is all; whether it is a form
 *   value or an immediate mutation is the caller's business.
 *
 * The glyphs come from `icon-glyphs.ts`: a synchronous fast table, then one
 * lazily loaded table for the rest, which opening the picker starts loading.
 *
 * ## The clear tile is never filtered away
 *
 * The "inherit" / "no icon" choice sits above the list and ignores the search.
 * A query that hid it would strand the operator on a glyph they picked by
 * accident with no way back to the default — the one action a picker must
 * always offer.
 */
import {
  ICON_CATEGORIES,
  type IconCategoryId,
  type IconKey,
  canonicalIconKey,
  iconCategoryLabel,
  iconsInCategory,
  searchIcons,
} from '@camstack/types'
import type { LucideIcon } from 'lucide-react'
import { type JSX, useEffect, useMemo, useRef, useState } from 'react'
import { Popover, PopoverContent, PopoverTrigger } from '../primitives/popover'
import { loadIconGlyphs, useDisplayIconResolver } from './icon-glyphs'

/** The strings this control shows. All of them, so nothing is hardcoded. */
export interface IconPickerLabels {
  /** The trigger button's accessible name, e.g. "Change the icon of Kitchen". */
  readonly trigger: string
  /** The popover's accessible name. */
  readonly panel: string
  readonly searchPlaceholder: string
  /** The tile that clears the pick — "No icon", "Inherit from the role", … */
  readonly clear: string
  /** Shown in place of the list when the query matches nothing. */
  readonly noMatches: string
}

export interface IconPickerProps {
  /** The chosen key (or a spelling that resolves to one), or `null` for "nothing chosen". */
  readonly value: string | null
  /** `null` clears the choice; otherwise a canonical catalog key. */
  readonly onPick: (key: IconKey | null) => void | Promise<void>
  /** What the trigger draws when `value` is null or undrawable. */
  readonly fallbackGlyph: LucideIcon
  /**
   * The glyph on the clear tile. Defaults to {@link fallbackGlyph}, which is
   * right when clearing means "inherit" and the tile should show what will be
   * inherited. A picker where clearing means "none at all" passes its own.
   */
  readonly clearGlyph?: LucideIcon
  /**
   * A human name for a key, for the tile's title and accessible name. The key
   * itself when absent — which is honest, since the key IS what gets stored.
   */
  readonly labelFor?: (key: IconKey) => string | undefined
  /** Title of a category section. Derived from the lucide category id when absent. */
  readonly categoryLabel?: (category: IconCategoryId) => string
  readonly labels: IconPickerLabels
  /**
   * Extra searchable words per key, for a caller that has translations this
   * package cannot see. Scored exactly like a synonym.
   */
  readonly extraWords?: ReadonlyMap<string, readonly string[]>
  readonly disabled?: boolean
}

// ── Virtual list geometry ───────────────────────────────────────────

const TILES_PER_ROW = 7
/** Matches `h-6` / `h-8` on the rows below. */
const HEADER_ROW_PX = 24
const TILE_ROW_PX = 32
/** Matches the `h-72` of the scroll area. */
const VIEWPORT_PX = 288
const OVERSCAN_PX = 96

type PickerRow =
  | { readonly kind: 'header'; readonly id: string; readonly category: IconCategoryId }
  | { readonly kind: 'tiles'; readonly id: string; readonly keys: readonly IconKey[] }

function chunk(keys: readonly IconKey[]): readonly (readonly IconKey[])[] {
  const rows: IconKey[][] = []
  for (let i = 0; i < keys.length; i += TILES_PER_ROW) rows.push(keys.slice(i, i + TILES_PER_ROW))
  return rows
}

function heightOf(row: PickerRow): number {
  return row.kind === 'header' ? HEADER_ROW_PX : TILE_ROW_PX
}

/** An empty query shows every category as a section; a query shows one ranked list. */
function buildRows(
  query: string,
  extraWords: ReadonlyMap<string, readonly string[]> | undefined,
): readonly PickerRow[] {
  if (query.trim().length > 0) {
    const keys = searchIcons(query, extraWords).map((h) => h.entry.key)
    return chunk(keys).map((row, i): PickerRow => ({ kind: 'tiles', id: `r${i}`, keys: row }))
  }
  return ICON_CATEGORIES.flatMap((category): readonly PickerRow[] => {
    const keys = iconsInCategory(category).map((e) => e.key)
    return [
      { kind: 'header', id: `h-${category}`, category },
      ...chunk(keys).map(
        (row, i): PickerRow => ({ kind: 'tiles', id: `${category}-${i}`, keys: row }),
      ),
    ]
  })
}

interface RowWindow {
  readonly rows: readonly PickerRow[]
  readonly padTop: number
  readonly padBottom: number
}

/** The rows intersecting the scrolled window, and the spacers that stand in for the rest. */
function windowRows(
  rows: readonly PickerRow[],
  offsets: readonly number[],
  total: number,
  scrollTop: number,
): RowWindow {
  const from = Math.max(0, scrollTop - OVERSCAN_PX)
  const to = scrollTop + VIEWPORT_PX + OVERSCAN_PX
  let start = 0
  while (start < rows.length - 1 && (offsets[start + 1] ?? total) <= from) start += 1
  let end = start
  while (end < rows.length && (offsets[end] ?? total) < to) end += 1
  return {
    rows: rows.slice(start, end),
    padTop: offsets[start] ?? 0,
    padBottom: Math.max(0, total - (offsets[end] ?? total)),
  }
}

export function IconPicker({
  value,
  onPick,
  fallbackGlyph,
  labels,
  extraWords,
  clearGlyph,
  labelFor,
  categoryLabel = iconCategoryLabel,
  disabled = false,
}: IconPickerProps): JSX.Element | null {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [scrollTop, setScrollTop] = useState(0)
  const scroller = useRef<HTMLDivElement>(null)
  const resolveGlyph = useDisplayIconResolver()

  useEffect(() => {
    if (open) loadIconGlyphs().catch(() => undefined)
  }, [open])

  const selectedKey = canonicalIconKey(value)

  // Titles are resolved at render time, so a caller's inline `categoryLabel`
  // does not rebuild ~1,700 entries on every scroll.
  const rows = useMemo(() => buildRows(query, extraWords), [query, extraWords])
  const { offsets, total } = useMemo(() => {
    const out: number[] = []
    let acc = 0
    for (const row of rows) {
      out.push(acc)
      acc += heightOf(row)
    }
    return { offsets: out, total: acc }
  }, [rows])
  const visible = useMemo(
    () => windowRows(rows, offsets, total, scrollTop),
    [rows, offsets, total, scrollTop],
  )

  const Current = (value === null ? undefined : resolveGlyph(value)) ?? fallbackGlyph
  const Clear = clearGlyph ?? fallbackGlyph

  const onQuery = (next: string): void => {
    setQuery(next)
    setScrollTop(0)
    if (scroller.current !== null) scroller.current.scrollTop = 0
  }

  const choose = async (next: IconKey | null): Promise<void> => {
    setOpenAndReset(false)
    await onPick(next)
  }

  const setOpenAndReset = (next: boolean): void => {
    setOpen(next)
    if (!next) onQuery('')
  }

  return (
    <Popover open={open} onOpenChange={setOpenAndReset}>
      <PopoverTrigger
        disabled={disabled}
        aria-label={labels.trigger}
        title={labels.trigger}
        className="rounded border border-border p-1 text-foreground-muted hover:bg-surface-hover disabled:opacity-50"
      >
        <Current className="h-4 w-4" />
      </PopoverTrigger>

      {/* Portalled by the library `Popover` (a bottom sheet on a phone), so a
          card with `overflow-hidden` around the trigger cannot clip the list. */}
      <PopoverContent aria-label={labels.panel} aria-labelledby={undefined} className="w-72 p-2">
        <div className="w-full">
          <input
            type="search"
            value={query}
            autoFocus
            onChange={(e) => onQuery(e.target.value)}
            placeholder={labels.searchPlaceholder}
            aria-label={labels.searchPlaceholder}
            className="mb-2 w-full rounded border border-border bg-surface-raised px-2 py-1 text-xs text-foreground placeholder:text-foreground-subtle"
          />

          <button
            type="button"
            onClick={() => void choose(null)}
            aria-pressed={value === null}
            className="mb-2 flex w-full items-center gap-1.5 rounded px-1.5 py-1 text-[11px] text-foreground-subtle hover:bg-surface-hover"
          >
            <Clear className="h-3.5 w-3.5" />
            {labels.clear}
          </button>

          {rows.length === 0 ? (
            <p className="px-1.5 py-2 text-[11px] text-foreground-subtle">{labels.noMatches}</p>
          ) : (
            <div
              ref={scroller}
              onScroll={(e) => setScrollTop(e.currentTarget.scrollTop)}
              className="max-h-72 overflow-y-auto"
            >
              {/* ui-check-ok: virtualised list — the spacers ARE the rows not mounted */}
              <div style={{ paddingTop: visible.padTop, paddingBottom: visible.padBottom }}>
                {visible.rows.map((row) =>
                  row.kind === 'header' ? (
                    <h4
                      key={row.id}
                      className="flex h-6 items-center px-1.5 text-[10px] uppercase tracking-wide text-foreground-subtle"
                    >
                      {categoryLabel(row.category)}
                    </h4>
                  ) : (
                    <div key={row.id} className="grid h-8 grid-cols-7 gap-1 pb-1">
                      {row.keys.map((key) => {
                        const Glyph = resolveGlyph(key)
                        // Not loaded yet: hold the tile's place so the grid does not jump.
                        if (Glyph === undefined) return <span key={key} aria-hidden="true" />
                        const selected = selectedKey === key
                        return (
                          <button
                            key={key}
                            type="button"
                            onClick={() => void choose(key)}
                            aria-pressed={selected}
                            aria-label={labelFor?.(key) ?? key}
                            title={labelFor?.(key) ?? key}
                            className={
                              selected
                                ? 'flex items-center justify-center rounded border border-primary bg-primary/10 text-foreground'
                                : 'flex items-center justify-center rounded border border-transparent text-foreground-muted hover:bg-surface-hover'
                            }
                          >
                            <Glyph className="h-4 w-4" />
                          </button>
                        )
                      })}
                    </div>
                  ),
                )}
              </div>
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  )
}
