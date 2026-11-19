/**
 * `GroupedTilePicker` — choose ONE "type of thing" from tiles grouped by who
 * provides it (an AI profile kind, a notification-target kind…): an uppercase
 * group label, then a grid of icon + label tiles. The pre-modal of a
 * create-flow whose form depends on the choice.
 *
 * The tile is deliberately not a `Button`: a vertical icon-over-label card in
 * a grid, which toolbar-button chrome fights. One place owns that look so the
 * pickers stay identical.
 */
import { Info, Search } from 'lucide-react'
import { type JSX, type ReactNode, useState } from 'react'
import { BottomSheet } from '../primitives/bottom-sheet'
import { IconButton } from '../primitives/icon-button'
import { fuzzyMatch } from './device-list/fuzzy-match'

export interface TilePickerTile {
  /** Unique within the picker; handed back to `onPick`. */
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly testId?: string
  /**
   * Extra facts for the tile (supported operations, a shared-capability list).
   * A tap target beside the name — it does not choose the tile.
   */
  readonly detail?: ReactNode
  /** Accessible name of the detail control. Required when `detail` is set. */
  readonly detailLabel?: string
}

export interface TilePickerGroup {
  readonly id: string
  /** Shown above the group's tiles (e.g. the providing addon). */
  readonly label: string
  readonly tiles: readonly TilePickerTile[]
}

/** Labels of the optional search field (the caller's i18n owns the words). */
export interface TilePickerSearch {
  readonly placeholder: string
  readonly label: string
  /** Shown when the query matches no tile. */
  readonly noMatchMessage: string
}

/**
 * The groups with only the tiles whose label matches `query` (case and
 * separator-insensitive); a group left empty is dropped. An empty query
 * returns the groups untouched.
 */
export function filterTileGroups(
  groups: readonly TilePickerGroup[],
  query: string,
): readonly TilePickerGroup[] {
  if (query.trim() === '') return groups
  const kept: TilePickerGroup[] = []
  for (const group of groups) {
    const tiles = group.tiles.filter((tile) => fuzzyMatch(query, tile.label))
    if (tiles.length > 0) kept.push({ ...group, tiles })
  }
  return kept
}

export interface GroupedTilePickerProps {
  /** Adds a search field that filters the tiles of every group; focused when the picker's dialog opens. */
  readonly search?: TilePickerSearch
  readonly groups: readonly TilePickerGroup[]
  readonly onPick: (key: string) => void
  /** Shown when there is no group at all. */
  readonly emptyMessage: string
}

export function GroupedTilePicker({
  search,
  groups: allGroups,
  onPick,
  emptyMessage,
}: GroupedTilePickerProps): JSX.Element {
  const [openKey, setOpenKey] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const groups = search === undefined ? allGroups : filterTileGroups(allGroups, query)
  const openTile =
    openKey === null
      ? null
      : (allGroups.flatMap((group) => group.tiles).find((tile) => tile.key === openKey) ?? null)
  return (
    <div className="space-y-4">
      {search !== undefined && (
        <label className="relative block">
          <Search className="pointer-events-none absolute left-2 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-foreground-subtle" />
          <input // ui-check-ok: same search field as DataTableFilterBar
            data-dialog-autofocus=""
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={search.placeholder}
            aria-label={search.label}
            data-testid="tile-picker-search"
            className="w-full rounded border border-border bg-background py-1.5 pl-7 pr-2 text-xs text-foreground"
          />
        </label>
      )}
      {groups.length === 0 && (
        <p className="text-xs text-foreground-subtle">
          {allGroups.length > 0 && search !== undefined ? search.noMatchMessage : emptyMessage}
        </p>
      )}
      {groups.map((group) => (
        <div key={group.id}>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {group.label}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.tiles.map((tile) => (
              <div key={tile.key} className="relative">
                <button // ui-check-ok: the library's one tile — icon over label in a grid
                  type="button"
                  data-testid={tile.testId}
                  onClick={() => onPick(tile.key)}
                  className="flex h-full w-full flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3 text-xs transition-colors hover:border-primary/50 hover:bg-surface-hover"
                >
                  {tile.icon}
                  <span className="text-center font-medium text-foreground">{tile.label}</span>
                </button>
                {tile.detail !== undefined && tile.detailLabel !== undefined && (
                  <div className="absolute top-1 right-1">
                    <IconButton
                      type="button"
                      variant="ghost"
                      size="sm"
                      icon={Info}
                      aria-label={tile.detailLabel}
                      onClick={() =>
                        setOpenKey((current) => (current === tile.key ? null : tile.key))
                      }
                    />
                  </div>
                )}
              </div>
            ))}
          </div>
        </div>
      ))}
      {/* A popover portaled to document.body paints behind a top-layer dialog.
          This sheet is a child of the picker, so the tap still reaches it. */}
      {openTile?.detail !== undefined && (
        <BottomSheet open onClose={() => setOpenKey(null)}>
          {openTile.detail}
        </BottomSheet>
      )}
    </div>
  )
}
