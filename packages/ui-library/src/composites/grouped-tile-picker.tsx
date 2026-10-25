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
import type { JSX, ReactNode } from 'react'

export interface TilePickerTile {
  /** Unique within the picker; handed back to `onPick`. */
  readonly key: string
  readonly label: string
  readonly icon: ReactNode
  readonly testId?: string
}

export interface TilePickerGroup {
  readonly id: string
  /** Shown above the group's tiles (e.g. the providing addon). */
  readonly label: string
  readonly tiles: readonly TilePickerTile[]
}

export interface GroupedTilePickerProps {
  readonly groups: readonly TilePickerGroup[]
  readonly onPick: (key: string) => void
  /** Shown when there is no group at all. */
  readonly emptyMessage: string
}

export function GroupedTilePicker({
  groups,
  onPick,
  emptyMessage,
}: GroupedTilePickerProps): JSX.Element {
  return (
    <div className="space-y-4">
      {groups.length === 0 && <p className="text-xs text-foreground-subtle">{emptyMessage}</p>}
      {groups.map((group) => (
        <div key={group.id}>
          <div className="mb-1.5 text-[10px] font-semibold uppercase tracking-wider text-foreground-subtle">
            {group.label}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {group.tiles.map((tile) => (
              <button // ui-check-ok: the library's one tile — icon over label in a grid
                key={tile.key}
                type="button"
                data-testid={tile.testId}
                onClick={() => onPick(tile.key)}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-border bg-surface px-3 py-3 text-xs transition-colors hover:border-primary/50 hover:bg-surface-hover"
              >
                {tile.icon}
                <span className="text-center font-medium text-foreground">{tile.label}</span>
              </button>
            ))}
          </div>
        </div>
      ))}
    </div>
  )
}
