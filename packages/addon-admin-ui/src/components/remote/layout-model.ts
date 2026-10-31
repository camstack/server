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
  type LayoutEditRefusal,
  MAX_LAYOUT_SPAN,
  moveGroup as moveGroupOp,
  REMOTE_KNOWN_ROLES,
  type RemoteButtonShape,
  type RemoteButtonTone,
  type RemoteLayoutButton,
  type RemoteLayoutGroup,
  type RemoteLayoutPayload,
  RemoteLayoutPayloadSchema,
  rectsOverlap,
  removeGroup as removeGroupOp,
} from '@camstack/types'

export const DEFAULT_LAYOUT_COLUMNS = 3
export const DEFAULT_LAYOUT_ROWS = 4

export type LayoutRefusal =
  | 'overlap'
  | 'outside'
  | 'would-drop-buttons'
  | 'unknown-button'
  | 'invalid-size'
  | LayoutEditRefusal

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

function inGrid(grid: Pick<RemoteLayoutPayload, 'columns' | 'rows'>, b: LayoutBox) {
  return (
    b.row >= 0 && b.col >= 0 && b.row + b.rowSpan <= grid.rows && b.col + b.colSpan <= grid.columns
  )
}

const overlaps = rectsOverlap

/** What a placement check needs of a button or a group: its rectangle. */
type LayoutBox = Pick<RemoteLayoutButton, 'row' | 'col' | 'rowSpan' | 'colSpan'>

function contains(outer: LayoutBox, inner: LayoutBox): boolean {
  return (
    inner.row >= outer.row &&
    inner.col >= outer.col &&
    inner.row + inner.rowSpan <= outer.row + outer.rowSpan &&
    inner.col + inner.colSpan <= outer.col + outer.colSpan
  )
}

export function groupsOf(grid: RemoteLayoutPayload): readonly RemoteLayoutGroup[] {
  return grid.groups ?? []
}

export function groupById(grid: RemoteLayoutPayload, id: string): RemoteLayoutGroup | undefined {
  return groupsOf(grid).find((g) => g.id === id)
}

/** The members of a group, in layout order. */
export function membersOf(grid: RemoteLayoutPayload, groupId: string): RemoteLayoutButton[] {
  return grid.buttons.filter((b) => b.groupId === groupId)
}

function withGroupList(
  grid: RemoteLayoutPayload,
  groups: readonly RemoteLayoutGroup[],
): RemoteLayoutPayload {
  const { groups: _previous, ...rest } = grid
  return groups.length === 0 ? rest : { ...rest, groups: [...groups] }
}

/**
 * Settle which group `candidate` belongs to once it sits at its new place. A
 * button entirely inside a group's rectangle joins it (a divider holds no
 * buttons, so it refuses); one that touches a group's edge is refused; one
 * clear of every group is loose. The schema refuses any other combination, so
 * every button this returns is one the store accepts.
 */
function settleGroup(
  grid: RemoteLayoutPayload,
  candidate: RemoteLayoutButton,
): RemoteLayoutButton | LayoutRefusal {
  const { groupId: _was, ...loose } = candidate
  for (const group of groupsOf(grid)) {
    if (!overlaps(group, candidate)) continue
    if (group.frame === 'divider' || !contains(group, candidate)) return 'overlap'
    return { ...loose, groupId: group.id }
  }
  return loose
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
  if (clash) return 'overlap'
  const settled = settleGroup(grid, candidate)
  return typeof settled === 'string' ? settled : null
}

function withButton(grid: RemoteLayoutPayload, next: RemoteLayoutButton): LayoutResult {
  const reason = placementRefusal(grid, next, next.id)
  if (reason !== null) return refused(reason)
  const settled = settleGroup(grid, next)
  if (typeof settled === 'string') return refused(settled)
  return ok({
    ...grid,
    buttons: grid.buttons.map((b) => (b.id === next.id ? settled : b)),
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

/** The first free 1×1 cell outside every group, reading left to right and top to bottom. */
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
      // A key added without a place never lands inside a group's frame.
      const inGroup = groupsOf(grid).some((g) => overlaps(g, probe))
      if (!inGroup && placementRefusal(grid, probe, null) === null) return { row, col }
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
  const settled = settleGroup(grid, button)
  if (typeof settled === 'string') return refused(settled)
  return ok({ ...grid, buttons: [...grid.buttons, settled] })
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
  const { icon: _icon, label: _label, ...kept } = button
  const next: RemoteLayoutButton = {
    ...kept,
    role: face.role ?? button.role,
    ...(icon === undefined ? {} : { icon }),
    ...(label === undefined ? {} : { label }),
  }
  return ok({
    ...grid,
    buttons: grid.buttons.map((b) => (b.id === id ? next : b)),
  })
}

export interface ButtonLook {
  /** `null` clears the shape back to the plain look. */
  readonly shape?: RemoteButtonShape | null
  readonly tone?: RemoteButtonTone | null
}

/** Shape and tone of a button — drawing only, it never moves anything. */
export function setButtonLook(
  grid: RemoteLayoutPayload,
  id: string,
  look: ButtonLook,
): LayoutResult {
  const button = find(grid, id)
  if (button === undefined) return refused('unknown-button')
  const { shape: _shape, tone: _tone, ...kept } = button
  const shape = look.shape === undefined ? button.shape : (look.shape ?? undefined)
  const tone = look.tone === undefined ? button.tone : (look.tone ?? undefined)
  const next: RemoteLayoutButton = {
    ...kept,
    ...(shape === undefined ? {} : { shape }),
    ...(tone === undefined ? {} : { tone }),
  }
  return ok({
    ...grid,
    buttons: grid.buttons.map((b) => (b.id === id ? next : b)),
  })
}

export function removeButton(grid: RemoteLayoutPayload, id: string): RemoteLayoutPayload {
  return { ...grid, buttons: grid.buttons.filter((b) => b.id !== id) }
}

const fromEdit = (result: ReturnType<typeof moveGroupOp>): LayoutResult =>
  result.ok ? ok(result.layout) : refused(result.reason)

/** Move a group and all its buttons as one. */
export function moveGroup(
  grid: RemoteLayoutPayload,
  groupId: string,
  row: number,
  col: number,
): LayoutResult {
  return fromEdit(moveGroupOp(grid, groupId, { row, col }))
}

/** Delete a group; its buttons stay as loose keys or go with it. */
export function deleteGroup(
  grid: RemoteLayoutPayload,
  groupId: string,
  keepButtons: boolean,
): LayoutResult {
  return fromEdit(removeGroupOp(grid, groupId, { keepButtons }))
}

/** A group's frame title; blank clears it. */
export function setGroupTitle(
  grid: RemoteLayoutPayload,
  groupId: string,
  title: string,
): LayoutResult {
  const group = groupById(grid, groupId)
  if (group === undefined) return refused('unknown-group')
  const { title: _old, ...rest } = group
  const trimmed = title.trim()
  const next: RemoteLayoutGroup = trimmed === '' ? rest : { ...rest, title: title.slice(0, 40) }
  return ok(
    withGroupList(
      grid,
      groupsOf(grid).map((g) => (g.id === groupId ? next : g)),
    ),
  )
}

/** How a divider is drawn: a slim rule unless the group asks for a full row. */
export function isSlimDivider(group: RemoteLayoutGroup): boolean {
  return group.frame === 'divider' && group.rowSpan === 1 && group.size !== 'normal'
}

/**
 * The grid rows that hold nothing but slim dividers; they are drawn as a thin
 * strip instead of a full-height row.
 */
export function slimRowsOf(grid: RemoteLayoutPayload): ReadonlySet<number> {
  const slim = new Set<number>()
  const groups = groupsOf(grid)
  for (const group of groups) {
    if (!isSlimDivider(group)) continue
    const row = group.row
    const shared =
      grid.buttons.some((b) => b.row <= row && row < b.row + b.rowSpan) ||
      groups.some((g) => g !== group && g.row <= row && row < g.row + g.rowSpan)
    if (!shared) slim.add(row)
  }
  return slim
}

/** Relative row heights (rem, gaps included) for mapping a pointer to a row. */
export function rowWeightsOf(grid: RemoteLayoutPayload): readonly number[] {
  const slim = slimRowsOf(grid)
  return Array.from({ length: grid.rows }, (_, row) => (slim.has(row) ? 1 : 2.75) + 0.375)
}

export interface SeparatorOptions {
  readonly size?: 'compact' | 'normal'
  readonly hideTitle?: boolean
}

/** A divider's size and whether its label is drawn; the defaults are stored as absent. */
export function setSeparatorOptions(
  grid: RemoteLayoutPayload,
  groupId: string,
  options: SeparatorOptions,
): LayoutResult {
  const group = groupById(grid, groupId)
  if (group === undefined) return refused('unknown-group')
  const { size: _size, hideTitle: _hide, ...rest } = group
  const size = options.size ?? group.size
  const hideTitle = options.hideTitle ?? group.hideTitle
  const next: RemoteLayoutGroup = {
    ...rest,
    ...(size === 'normal' ? { size } : {}),
    ...(hideTitle === true ? { hideTitle } : {}),
  }
  return ok(
    withGroupList(
      grid,
      groupsOf(grid).map((g) => (g.id === groupId ? next : g)),
    ),
  )
}

/** New grid size; refused when a button would be left outside it. */
export function resizeGrid(grid: RemoteLayoutPayload, columns: number, rows: number): LayoutResult {
  const bad = (n: number) => !Number.isInteger(n) || n < 1 || n > MAX_LAYOUT_SPAN
  if (bad(columns) || bad(rows)) return refused('invalid-size')
  const next = { ...grid, columns, rows }
  if (grid.buttons.some((b) => !inGrid(next, b)) || groupsOf(grid).some((g) => !inGrid(next, g))) {
    return refused('would-drop-buttons')
  }
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

export interface ButtonSpec {
  readonly id: string
  readonly role: string
  readonly row: number
  readonly col: number
  readonly rowSpan?: number
  readonly colSpan?: number
  readonly icon?: string
  readonly label?: string
}

/**
 * A grid of `columns` × `rows` with `specs` placed on it, each through the same
 * placement check an edit goes through. Meant for code-defined layouts (the
 * built-in presets): a spec that overlaps or leaves the grid is a programming
 * error, so it throws instead of returning a refusal.
 */
export function buildLayout(
  columns: number,
  rows: number,
  specs: readonly ButtonSpec[],
): RemoteLayoutPayload {
  let grid: RemoteLayoutPayload = { columns, rows, buttons: [] }
  for (const spec of specs) {
    const candidate: RemoteLayoutButton = {
      id: spec.id,
      row: spec.row,
      col: spec.col,
      rowSpan: spec.rowSpan ?? 1,
      colSpan: spec.colSpan ?? 1,
      role: spec.role,
      ...(spec.icon === undefined ? {} : { icon: spec.icon }),
      ...(spec.label === undefined ? {} : { label: spec.label }),
    }
    const reason = placementRefusal(grid, candidate, null)
    if (reason !== null || grid.buttons.some((b) => b.id === spec.id)) {
      throw new Error(`layout button "${spec.id}": ${reason ?? 'duplicate id'}`)
    }
    grid = { ...grid, buttons: [...grid.buttons, candidate] }
  }
  return grid
}
