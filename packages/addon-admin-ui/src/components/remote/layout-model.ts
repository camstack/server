/**
 * The pure model behind the remote layout editor (D964): a grid of columns ×
 * rows and the buttons placed on it. Every operation returns a NEW grid or a
 * typed refusal — an overlap or a button leaving the grid is refused here, in
 * the same terms `RemoteLayoutPayloadSchema` checks on the server, so an
 * accepted edit is always a payload the template store accepts.
 */
import {
  customKeyOfRole,
  isRemoteKnownRole,
  MAX_LAYOUT_SPAN,
  REMOTE_KNOWN_ROLES,
  type RemoteLayoutButton,
  type RemoteLayoutPayload,
  RemoteLayoutPayloadSchema,
} from '@camstack/types'

export const DEFAULT_LAYOUT_COLUMNS = 3
export const DEFAULT_LAYOUT_ROWS = 4

export type LayoutRefusal =
  | 'overlap'
  | 'outside'
  | 'would-drop-buttons'
  | 'unknown-button'
  | 'invalid-size'

export type LayoutResult =
  | { readonly status: 'ok'; readonly grid: RemoteLayoutPayload }
  | { readonly status: 'refused'; readonly reason: LayoutRefusal }

export function emptyLayout(): RemoteLayoutPayload {
  return {
    columns: DEFAULT_LAYOUT_COLUMNS,
    rows: DEFAULT_LAYOUT_ROWS,
    buttons: [],
  }
}

const refused = (reason: LayoutRefusal): LayoutResult => ({
  status: 'refused',
  reason,
})
const ok = (grid: RemoteLayoutPayload): LayoutResult => ({
  status: 'ok',
  grid,
})

function inGrid(grid: Pick<RemoteLayoutPayload, 'columns' | 'rows'>, b: RemoteLayoutButton) {
  return (
    b.row >= 0 && b.col >= 0 && b.row + b.rowSpan <= grid.rows && b.col + b.colSpan <= grid.columns
  )
}

function overlaps(a: RemoteLayoutButton, b: RemoteLayoutButton): boolean {
  return (
    a.row < b.row + b.rowSpan &&
    b.row < a.row + a.rowSpan &&
    a.col < b.col + b.colSpan &&
    b.col < a.col + a.colSpan
  )
}

/** Why `candidate` cannot sit on `grid` (ignoring the button `ignoreId`), or null when it fits. */
export function placementRefusal(
  grid: RemoteLayoutPayload,
  candidate: RemoteLayoutButton,
  ignoreId: string | null,
): LayoutRefusal | null {
  if (candidate.rowSpan < 1 || candidate.colSpan < 1) return 'invalid-size'
  if (!inGrid(grid, candidate)) return 'outside'
  const clash = grid.buttons.some((other) => other.id !== ignoreId && overlaps(other, candidate))
  return clash ? 'overlap' : null
}

function withButton(grid: RemoteLayoutPayload, next: RemoteLayoutButton): LayoutResult {
  const reason = placementRefusal(grid, next, next.id)
  if (reason !== null) return refused(reason)
  return ok({
    ...grid,
    buttons: grid.buttons.map((b) => (b.id === next.id ? next : b)),
  })
}

function find(grid: RemoteLayoutPayload, id: string): RemoteLayoutButton | undefined {
  return grid.buttons.find((b) => b.id === id)
}

export function nextButtonId(grid: RemoteLayoutPayload): string {
  const used = new Set(grid.buttons.map((b) => b.id))
  for (let n = grid.buttons.length + 1; ; n += 1) {
    if (!used.has(`b${n}`)) return `b${n}`
  }
}

/** The first free 1×1 cell, reading left to right and top to bottom. */
export function firstFreeCell(grid: RemoteLayoutPayload): { row: number; col: number } | null {
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.columns; col += 1) {
      const probe: RemoteLayoutButton = {
        id: '',
        row,
        col,
        rowSpan: 1,
        colSpan: 1,
        role: 'power',
      }
      if (placementRefusal(grid, probe, null) === null) return { row, col }
    }
  }
  return null
}

/** A new 1×1 button on the first free cell; refused as `outside` when the grid is full. */
export function addButton(grid: RemoteLayoutPayload, role: string): LayoutResult {
  if (grid.buttons.length >= 200) return refused('outside')
  const cell = firstFreeCell(grid)
  if (cell === null) return refused('outside')
  const button: RemoteLayoutButton = {
    id: nextButtonId(grid),
    row: cell.row,
    col: cell.col,
    rowSpan: 1,
    colSpan: 1,
    role,
  }
  return ok({ ...grid, buttons: [...grid.buttons, button] })
}

export function moveButton(
  grid: RemoteLayoutPayload,
  id: string,
  row: number,
  col: number,
): LayoutResult {
  const button = find(grid, id)
  if (button === undefined) return refused('unknown-button')
  return withButton(grid, { ...button, row, col })
}

export function shiftButton(
  grid: RemoteLayoutPayload,
  id: string,
  dRow: number,
  dCol: number,
): LayoutResult {
  const button = find(grid, id)
  if (button === undefined) return refused('unknown-button')
  return moveButton(grid, id, button.row + dRow, button.col + dCol)
}

export function resizeButton(
  grid: RemoteLayoutPayload,
  id: string,
  rowSpan: number,
  colSpan: number,
): LayoutResult {
  const button = find(grid, id)
  if (button === undefined) return refused('unknown-button')
  return withButton(grid, { ...button, rowSpan, colSpan })
}

export interface ButtonFace {
  readonly role?: string
  /** `null` clears the icon. */
  readonly icon?: string | null
  /** `null` or blank clears the label. */
  readonly label?: string | null
}

/** Role, icon and label of a button — the parts that never move it. */
export function setButtonFace(
  grid: RemoteLayoutPayload,
  id: string,
  face: ButtonFace,
): LayoutResult {
  const button = find(grid, id)
  if (button === undefined) return refused('unknown-button')
  const icon = face.icon === undefined ? button.icon : (face.icon ?? undefined)
  const rawLabel = face.label === undefined ? button.label : (face.label ?? undefined)
  const label = rawLabel === undefined || rawLabel.trim() === '' ? undefined : rawLabel
  const next: RemoteLayoutButton = {
    id: button.id,
    row: button.row,
    col: button.col,
    rowSpan: button.rowSpan,
    colSpan: button.colSpan,
    role: face.role ?? button.role,
    ...(icon === undefined ? {} : { icon }),
    ...(label === undefined ? {} : { label }),
  }
  return ok({
    ...grid,
    buttons: grid.buttons.map((b) => (b.id === id ? next : b)),
  })
}

export function removeButton(grid: RemoteLayoutPayload, id: string): RemoteLayoutPayload {
  return { ...grid, buttons: grid.buttons.filter((b) => b.id !== id) }
}

/** New grid size; refused when a button would be left outside it. */
export function resizeGrid(grid: RemoteLayoutPayload, columns: number, rows: number): LayoutResult {
  const bad = (n: number) => !Number.isInteger(n) || n < 1 || n > MAX_LAYOUT_SPAN
  if (bad(columns) || bad(rows)) return refused('invalid-size')
  const next = { ...grid, columns, rows }
  if (grid.buttons.some((b) => !inGrid(next, b))) return refused('would-drop-buttons')
  return ok(next)
}

/** The grid as the template store will read it, or null when the schema refuses it. */
export function checkedLayout(grid: RemoteLayoutPayload): RemoteLayoutPayload | null {
  const parsed = RemoteLayoutPayloadSchema.safeParse(grid)
  return parsed.success ? parsed.data : null
}

/** A payload read from the store, or an empty grid when it is not a remote layout. */
export function layoutOf(payload: unknown): RemoteLayoutPayload {
  const parsed = RemoteLayoutPayloadSchema.safeParse(payload)
  return parsed.success ? parsed.data : emptyLayout()
}

export type RoleGroup =
  | 'power'
  | 'volume'
  | 'channel'
  | 'navigation'
  | 'playback'
  | 'digits'
  | 'other'

export const ROLE_GROUP_ORDER: readonly RoleGroup[] = [
  'power',
  'volume',
  'channel',
  'navigation',
  'playback',
  'digits',
  'other',
]

/** The group a known role is listed under; derived from the vocabulary, never a second list. */
export function roleGroup(role: string): RoleGroup {
  if (role.startsWith('power')) return 'power'
  if (role.startsWith('volume') || role === 'mute') return 'volume'
  if (role.startsWith('channel')) return 'channel'
  if (role.startsWith('digit_')) return 'digits'
  if (['up', 'down', 'left', 'right', 'ok', 'back', 'home', 'menu', 'exit'].includes(role)) {
    return 'navigation'
  }
  if (
    ['play', 'pause', 'play_pause', 'stop', 'next', 'previous', 'fast_forward', 'rewind'].includes(
      role,
    )
  ) {
    return 'playback'
  }
  return 'other'
}

export function knownRolesOfGroup(group: RoleGroup): readonly string[] {
  return REMOTE_KNOWN_ROLES.filter((role) => roleGroup(role) === group)
}

/** `volume_up` → `Volume up`; `custom:hdmi_1` → `hdmi 1`. The fallback of an untranslated role. */
export function humanRole(role: string): string {
  const key = customKeyOfRole(role)
  const text = (key ?? role).replace(/_/g, ' ')
  return key === null ? text.charAt(0).toUpperCase() + text.slice(1) : text
}

export function isCustomRole(role: string): boolean {
  return customKeyOfRole(role) !== null && !isRemoteKnownRole(role)
}
