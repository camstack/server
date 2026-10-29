/**
 * The button grid of a remote layout (D964): the editor's canvas and the
 * modal's preview. It draws a `RemoteLayoutPayload` and reports a tap; it owns
 * no data. A button wears its icon, else its label, else its role's name.
 */
import type { RemoteLayoutButton, RemoteLayoutPayload } from '@camstack/types'
import { Button, useDisplayIconResolver } from '@camstack/ui-library'
import type { ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { AppBrandGlyph } from './AppBrandGlyph'
import { resolveAppBrand } from './app-brand-icons'
import { humanRole } from './layout-model'

export interface RemoteGridProps {
  readonly grid: RemoteLayoutPayload
  /** The accessible name of the grid. */
  readonly label: string
  readonly selectedId?: string | null
  readonly onSelect?: (id: string) => void
  /** Roles that do something: the others are drawn as an outline. */
  readonly boundRoles?: ReadonlySet<string>
  /** Faint cells where nothing sits — the editor shows where a button may go. */
  readonly showEmptyCells?: boolean
}

function occupied(grid: RemoteLayoutPayload): ReadonlySet<string> {
  const cells = new Set<string>()
  for (const b of grid.buttons) {
    for (let r = b.row; r < b.row + b.rowSpan; r += 1) {
      for (let c = b.col; c < b.col + b.colSpan; c += 1) cells.add(`${r}:${c}`)
    }
  }
  return cells
}

/** A glyph-only app key has no visible text, so it carries the brand's name. */
function appButtonName(button: RemoteLayoutButton): { 'aria-label'?: string } {
  const brand = resolveAppBrand(button.icon)
  return brand === undefined ? {} : { 'aria-label': button.label ?? brand.label }
}

function Face({ button }: { readonly button: RemoteLayoutButton }): ReactNode {
  const { t } = useTranslation()
  const resolve = useDisplayIconResolver()
  const brand = resolveAppBrand(button.icon)
  const Icon = button.icon === undefined || brand !== undefined ? undefined : resolve(button.icon)
  const words =
    button.label ??
    (Icon === undefined && brand === undefined
      ? t(`remote.role.${button.role}`, humanRole(button.role))
      : null)
  return (
    <span className="flex flex-col items-center justify-center gap-0.5 leading-none">
      {brand !== undefined && <AppBrandGlyph brand={brand} />}
      {Icon !== undefined && <Icon className="h-4 w-4" aria-hidden />}
      {words !== null && <span className="max-w-full truncate text-[11px]">{words}</span>}
    </span>
  )
}

export function RemoteGrid({
  grid,
  label,
  selectedId = null,
  onSelect,
  boundRoles,
  showEmptyCells = false,
}: RemoteGridProps): ReactNode {
  const taken = occupied(grid)
  const empty: { row: number; col: number }[] = []
  if (showEmptyCells) {
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.columns; col += 1) {
        if (!taken.has(`${row}:${col}`)) empty.push({ row, col })
      }
    }
  }
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="remote-grid"
      className="grid auto-rows-[2.75rem] gap-1.5"
      // ui-check-ok: computed grid geometry from the layout payload
      style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}
    >
      {empty.map(({ row, col }) => (
        <div
          key={`e${row}:${col}`}
          aria-hidden
          className="rounded-md border border-dashed border-border-subtle"
          // ui-check-ok: computed grid placement of an empty cell
          style={{ gridRow: `${row + 1}`, gridColumn: `${col + 1}` }}
        />
      ))}
      {grid.buttons.map((button) => {
        const selected = button.id === selectedId
        const bound = boundRoles === undefined || boundRoles.has(button.role)
        return (
          <Button
            key={button.id}
            type="button"
            size="sm"
            variant={selected ? 'primary' : bound ? 'secondary' : 'outline'}
            aria-pressed={onSelect === undefined ? undefined : selected}
            {...appButtonName(button)}
            data-testid={`remote-grid-button-${button.id}`}
            className="h-full min-w-0 px-1"
            // ui-check-ok: computed grid placement of a button
            style={{
              gridRow: `${button.row + 1} / span ${button.rowSpan}`,
              gridColumn: `${button.col + 1} / span ${button.colSpan}`,
            }}
            onClick={onSelect === undefined ? undefined : () => onSelect(button.id)}
          >
            <Face button={button} />
          </Button>
        )
      })}
    </div>
  )
}
