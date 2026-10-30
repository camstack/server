/**
 * The button grid of a remote layout (D964, D973): the editor's canvas and the
 * modal's preview. It draws a `RemoteLayoutPayload` — buttons with their shape
 * and tone, groups with their frame and title — and reports taps, grabs and
 * arrow keys; it owns no data. A button wears its icon, else its label, else
 * its role's name. The look of a shape, tone or frame is `remote-look`.
 */
import type { RemoteLayoutButton, RemoteLayoutGroup, RemoteLayoutPayload } from '@camstack/types'
import { Button, cn, useDisplayIconResolver } from '@camstack/ui-library'
import { GripVertical } from 'lucide-react'
import type { KeyboardEvent, PointerEvent, ReactNode, Ref } from 'react'
import { useTranslation } from 'react-i18next'
import { AppBrandGlyph } from './AppBrandGlyph'
import { resolveAppBrand } from './app-brand-icons'
import type { DragItem, DragPreview } from './layout-drag'
import { humanRole } from './layout-model'
import { clampToGrid, frameClass, isDividerFrame, shapeClass, toneClass } from './remote-look'

/** A drag in progress: what is held and where it would land. */
export interface GridDrag {
  readonly item: DragItem
  readonly preview: DragPreview | null
}

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
  /** A thumbnail: small cells, no words. */
  readonly compact?: boolean
  /** The grid element, for the editor's pointer maths. */
  readonly gridRef?: Ref<HTMLDivElement>
  readonly selectedGroupId?: string | null
  readonly onSelectGroup?: (id: string) => void
  /** Present = the grid is editable: items can be grabbed by pointer and nudged by arrow keys. */
  readonly onItemPointerDown?: (item: DragItem, event: PointerEvent<HTMLElement>) => void
  readonly onItemKeyDown?: (item: DragItem, event: KeyboardEvent<HTMLElement>) => void
  readonly drag?: GridDrag | null
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

/** The tones that ARE the content of a key (a colour key): no text on them. */
const COLOUR_TONES: ReadonlySet<string> = new Set(['red', 'green', 'yellow', 'blue'])

/** What a key is called to a screen reader and in a tooltip: its label, else its role's name. */
function keyName(button: RemoteLayoutButton, roleName: string): string {
  return button.label ?? resolveAppBrand(button.icon)?.label ?? roleName
}

/** A key shows an icon, or a colour, or text: text only when nothing else says what it is. */
function showsWords(button: RemoteLayoutButton, hasIcon: boolean): boolean {
  if (hasIcon || resolveAppBrand(button.icon) !== undefined) return false
  return button.tone === undefined || !COLOUR_TONES.has(button.tone)
}

function Face({
  button,
  name,
  compact,
}: {
  readonly button: RemoteLayoutButton
  readonly name: string
  readonly compact: boolean
}): ReactNode {
  const resolve = useDisplayIconResolver()
  const brand = resolveAppBrand(button.icon)
  const Icon = button.icon === undefined || brand !== undefined ? undefined : resolve(button.icon)
  const words = showsWords(button, Icon !== undefined) ? name : undefined
  return (
    <span className="flex flex-col items-center justify-center gap-0.5 leading-none">
      {brand !== undefined && <AppBrandGlyph brand={brand} />}
      {Icon !== undefined && <Icon className="h-4 w-4" aria-hidden />}
      {words !== undefined && !compact && (
        <span className="max-w-full truncate text-[11px]">{words}</span>
      )}
    </span>
  )
}

function placement(rect: {
  readonly row: number
  readonly col: number
  readonly rowSpan: number
  readonly colSpan: number
}): { gridRow: string; gridColumn: string } {
  return {
    gridRow: `${rect.row + 1} / span ${rect.rowSpan}`,
    gridColumn: `${rect.col + 1} / span ${rect.colSpan}`,
  }
}

interface GroupFrameProps {
  readonly group: RemoteLayoutGroup
  readonly selected: boolean
  readonly dragging: boolean
  readonly compact: boolean
  readonly editable: boolean
  readonly onSelect: (() => void) | undefined
  readonly onPointerDown: ((event: PointerEvent<HTMLElement>) => void) | undefined
  readonly onKeyDown: ((event: KeyboardEvent<HTMLElement>) => void) | undefined
}

/** The box (or rule) behind a group, with its title and, when editable, a handle to move it. */
function GroupFrame({
  group,
  selected,
  dragging,
  compact,
  editable,
  onSelect,
  onPointerDown,
  onKeyDown,
}: GroupFrameProps): ReactNode {
  const { t } = useTranslation()
  const divider = isDividerFrame(group.frame)
  const title = compact ? undefined : group.title
  return (
    <div
      data-testid={`remote-group-${group.id}`}
      data-frame={group.frame}
      className={cn(
        'relative -m-0.5 flex',
        frameClass(group.frame),
        dragging && 'opacity-40',
        selected && 'ring-2 ring-primary',
      )}
      // ui-check-ok: computed grid placement of a group frame
      style={placement(group)}
    >
      {divider ? (
        <div className="flex w-full items-center gap-2 px-1 text-[10px] uppercase tracking-wide text-foreground-muted">
          <span className="h-px flex-1 bg-border" aria-hidden />
          {title !== undefined && <span className="truncate">{title}</span>}
          {title !== undefined && <span className="h-px flex-1 bg-border" aria-hidden />}
        </div>
      ) : (
        title !== undefined && (
          <span className="absolute -top-1.5 left-3 max-w-[70%] truncate bg-background-elevated px-1 text-[10px] uppercase leading-none tracking-wide text-foreground-muted">
            {title}
          </span>
        )
      )}
      {editable && (
        // ui-check-ok: a 16px drag grip on the frame corner; IconButton has no touch-none drag-handle size
        <button
          type="button"
          aria-label={t('remote.layout.groupHandle', { name: group.title ?? group.componentId })}
          aria-pressed={selected}
          data-testid={`remote-group-handle-${group.id}`}
          className="absolute -right-1 -top-2.5 z-20 flex h-4 w-4 touch-none cursor-grab items-center justify-center rounded-full border border-border bg-surface-hover text-foreground-muted hover:text-foreground"
          onClick={onSelect}
          onPointerDown={onPointerDown}
          onKeyDown={onKeyDown}
        >
          <GripVertical className="h-3 w-3" aria-hidden />
        </button>
      )}
    </div>
  )
}

export function RemoteGrid({
  grid,
  label,
  selectedId = null,
  onSelect,
  boundRoles,
  showEmptyCells = false,
  compact = false,
  gridRef,
  selectedGroupId = null,
  onSelectGroup,
  onItemPointerDown,
  onItemKeyDown,
  drag = null,
}: RemoteGridProps): ReactNode {
  const { t } = useTranslation()
  const editable = onItemPointerDown !== undefined
  const dragging = drag !== null
  const taken = occupied(grid)
  const cells: { row: number; col: number }[] = []
  if (showEmptyCells || dragging) {
    for (let row = 0; row < grid.rows; row += 1) {
      for (let col = 0; col < grid.columns; col += 1) {
        // While dragging every cell shows, so the operator sees the whole grid.
        if (dragging || !taken.has(`${row}:${col}`)) cells.push({ row, col })
      }
    }
  }
  const ghost = drag?.preview ?? null
  return (
    <div
      role="group"
      aria-label={label}
      data-testid="remote-grid"
      ref={gridRef}
      className={cn(
        'grid gap-1.5',
        compact ? 'auto-rows-[1.25rem] gap-0.5' : 'auto-rows-[2.75rem]',
      )}
      // ui-check-ok: computed grid geometry from the layout payload
      style={{ gridTemplateColumns: `repeat(${grid.columns}, minmax(0, 1fr))` }}
    >
      {cells.map(({ row, col }) => (
        <div
          key={`e${row}:${col}`}
          aria-hidden
          data-testid="remote-grid-cell"
          className={cn(
            'rounded-md border border-dashed',
            dragging ? 'border-border' : 'border-border-subtle',
          )}
          // ui-check-ok: computed grid placement of a cell
          style={{ gridRow: `${row + 1}`, gridColumn: `${col + 1}` }}
        />
      ))}
      {(grid.groups ?? []).map((group) => (
        <GroupFrame
          key={group.id}
          group={group}
          selected={group.id === selectedGroupId}
          dragging={drag?.item.kind === 'group' && drag.item.id === group.id}
          compact={compact}
          editable={editable}
          onSelect={onSelectGroup === undefined ? undefined : () => onSelectGroup(group.id)}
          onPointerDown={
            onItemPointerDown === undefined
              ? undefined
              : (event) => onItemPointerDown({ kind: 'group', id: group.id }, event)
          }
          onKeyDown={
            onItemKeyDown === undefined
              ? undefined
              : (event) => onItemKeyDown({ kind: 'group', id: group.id }, event)
          }
        />
      ))}
      {grid.buttons.map((button) => {
        const selected = button.id === selectedId
        const bound = boundRoles === undefined || boundRoles.has(button.role)
        const held = drag?.item.kind === 'button' && drag.item.id === button.id
        const item: DragItem = { kind: 'button', id: button.id }
        const name = keyName(button, t(`remote.role.${button.role}`, humanRole(button.role)))
        return (
          <Button
            key={button.id}
            type="button"
            size="sm"
            variant={bound ? 'secondary' : 'outline'}
            aria-pressed={onSelect === undefined ? undefined : selected}
            aria-label={name}
            title={name}
            data-testid={`remote-grid-button-${button.id}`}
            data-shape={button.shape}
            data-tone={button.tone}
            className={cn(
              'z-10 h-full min-w-0 overflow-hidden border border-border px-1',
              compact && 'px-0',
              shapeClass(button.shape),
              toneClass(button.tone),
              editable && 'touch-none',
              held && 'opacity-40',
              selected && 'ring-2 ring-primary ring-offset-1 ring-offset-background',
            )}
            // ui-check-ok: computed grid placement of a button
            style={placement(button)}
            onClick={onSelect === undefined ? undefined : () => onSelect(button.id)}
            onPointerDown={
              onItemPointerDown === undefined
                ? undefined
                : (event) => onItemPointerDown(item, event)
            }
            onKeyDown={
              onItemKeyDown === undefined ? undefined : (event) => onItemKeyDown(item, event)
            }
          >
            <Face button={button} name={name} compact={compact} />
          </Button>
        )
      })}
      {ghost !== null && (
        <div
          aria-hidden
          data-testid="remote-drop-target"
          data-valid={ghost.valid}
          className={cn(
            'pointer-events-none z-30 rounded-md border-2 border-dashed',
            ghost.valid ? 'border-success bg-success/20' : 'border-danger bg-danger/20',
          )}
          // ui-check-ok: computed grid placement of the drop footprint
          style={placement(clampToGrid(grid, ghost.rect))}
        />
      )}
    </div>
  )
}
