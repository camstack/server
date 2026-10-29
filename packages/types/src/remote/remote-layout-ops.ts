/**
 * Pure edits of a remote layout that involve groups and components (D973).
 * Shared by the template editor, the built-in presets and the server so an
 * accepted edit is always a payload `RemoteLayoutPayloadSchema` accepts.
 * Every function returns a NEW layout or a typed refusal; none mutates.
 */
import type { RemoteLayoutComponent } from './remote-components.js'
import {
  type LayoutRect,
  MAX_LAYOUT_GROUPS,
  MAX_REMOTE_BINDINGS,
  type RemoteLayoutButton,
  type RemoteLayoutGroup,
  type RemoteLayoutPayload,
  rectsOverlap,
} from './remote-config.js'

export const LAYOUT_EDIT_REFUSALS = ['outside', 'overlap', 'unknown-group', 'too-many'] as const
export type LayoutEditRefusal = (typeof LAYOUT_EDIT_REFUSALS)[number]

export type LayoutEditResult =
  | { readonly ok: true; readonly layout: RemoteLayoutPayload }
  | { readonly ok: false; readonly reason: LayoutEditRefusal }

export interface InsertedComponent {
  readonly ok: true
  readonly layout: RemoteLayoutPayload
  /** The group created for the component, or null for a component of loose buttons. */
  readonly groupId: string | null
  readonly buttonIds: readonly string[]
}

export type InsertComponentResult =
  | InsertedComponent
  | { readonly ok: false; readonly reason: LayoutEditRefusal }

/** A button of a component, positioned relative to it. */
export type ComponentButtonSpec = RemoteLayoutComponent['buttons'][number]

export interface InsertOptions {
  /** Multiply the component's rows / columns (and every button's span), e.g. a D-pad on a 12-column grid. */
  readonly scale?: { readonly rows?: number; readonly cols?: number }
  /** Extra relative buttons joined to this instance (the keypad's bottom-corner keys). */
  readonly extras?: readonly ComponentButtonSpec[]
  /** Replaces the component's own frame title ("Section" -> "Volume"). */
  readonly title?: string
}

const refuse = (reason: LayoutEditRefusal): { ok: false; reason: LayoutEditRefusal } => ({
  ok: false,
  reason,
})

function withGroups(
  layout: RemoteLayoutPayload,
  groups: readonly RemoteLayoutGroup[],
): RemoteLayoutPayload {
  const { groups: _previous, ...rest } = layout
  return groups.length === 0 ? rest : { ...rest, groups: [...groups] }
}

function fitsGrid(layout: RemoteLayoutPayload, rect: LayoutRect): boolean {
  return (
    rect.row >= 0 &&
    rect.col >= 0 &&
    rect.row + rect.rowSpan <= layout.rows &&
    rect.col + rect.colSpan <= layout.columns
  )
}

/** The columns a component must be scaled by to span the whole grid width, or null when it does not divide. */
export function fillWidthScale(
  layout: RemoteLayoutPayload,
  component: RemoteLayoutComponent,
): number | null {
  const factor = layout.columns / component.size.cols
  return Number.isInteger(factor) && factor >= 1 ? factor : null
}

function titleOf(title: string | undefined): { title?: string } {
  return title === undefined ? {} : { title }
}

function slug(value: string): string {
  const name = value.includes(':') ? value.slice(value.indexOf(':') + 1) : value
  return name.replace(/[^a-z0-9_-]/g, '-').slice(0, 16)
}

function uniqueId(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base
  for (let n = 2; ; n += 1) {
    const candidate = `${base}-${n}`
    if (!taken.has(candidate)) return candidate
  }
}

function freePrefix(
  base: string,
  placed: readonly { readonly spec: ComponentButtonSpec }[],
  taken: ReadonlySet<string>,
): string {
  for (let n = 1; ; n += 1) {
    const candidate = n === 1 ? base : `${base}-${n}`
    if (!placed.some((p) => taken.has(`${candidate}-${p.spec.idSuffix}`))) return candidate
  }
}

/**
 * Put `component` on the layout with its top-left cell at `at`. A component
 * with a group becomes one group whose rectangle is the whole component and
 * whose members are its buttons; one without is a set of loose buttons. The
 * grid does not grow: a component that does not fit is refused `outside`, one
 * that would sit on an existing key or group `overlap`.
 */
export function insertComponent(
  layout: RemoteLayoutPayload,
  component: RemoteLayoutComponent,
  at: { readonly row: number; readonly col: number },
  options: InsertOptions = {},
): InsertComponentResult {
  const rowScale = options.scale?.rows ?? 1
  const colScale = options.scale?.cols ?? 1
  const bounds: LayoutRect = {
    row: at.row,
    col: at.col,
    rowSpan: component.size.rows * rowScale,
    colSpan: component.size.cols * colScale,
  }
  if (!fitsGrid(layout, bounds)) return refuse('outside')

  const specs = [...component.buttons, ...(options.extras ?? [])]
  const placed = specs.map((spec) => ({
    spec,
    rect: {
      row: at.row + spec.row * rowScale,
      col: at.col + spec.col * colScale,
      rowSpan: spec.rowSpan * rowScale,
      colSpan: spec.colSpan * colScale,
    },
  }))
  const groups = layout.groups ?? []
  const claimed: readonly LayoutRect[] =
    component.group === null ? placed.map((p) => p.rect) : [bounds]
  const blocked = claimed.some(
    (rect) =>
      layout.buttons.some((b) => rectsOverlap(b, rect)) ||
      groups.some((g) => rectsOverlap(g, rect)),
  )
  if (blocked) return refuse('overlap')
  if (
    layout.buttons.length + specs.length > MAX_REMOTE_BINDINGS ||
    groups.length + (component.group === null ? 0 : 1) > MAX_LAYOUT_GROUPS
  ) {
    return refuse('too-many')
  }

  const base = slug(component.id)
  const takenButtons = new Set(layout.buttons.map((b) => b.id))
  const takenGroups = new Set(groups.map((g) => g.id))
  const groupId = component.group === null ? null : uniqueId(base, takenGroups)
  // Loose buttons carry an instance prefix too, so two inserts never collide.
  const prefix = groupId ?? freePrefix(base, placed, takenButtons)
  const buttons: RemoteLayoutButton[] = placed.map(({ spec, rect }) => ({
    id: `${prefix}-${spec.idSuffix}`,
    ...rect,
    role: spec.role,
    ...(spec.icon === undefined ? {} : { icon: spec.icon }),
    ...(spec.label === undefined ? {} : { label: spec.label }),
    ...(spec.shape === undefined ? {} : { shape: spec.shape }),
    ...(spec.tone === undefined ? {} : { tone: spec.tone }),
    ...(groupId === null ? {} : { groupId }),
  }))
  const group: RemoteLayoutGroup[] =
    component.group === null || groupId === null
      ? []
      : [
          {
            id: groupId,
            componentId: component.id,
            frame: component.group.frame,
            ...bounds,
            ...titleOf(options.title ?? component.group.title),
          },
        ]
  return {
    ok: true,
    layout: withGroups({ ...layout, buttons: [...layout.buttons, ...buttons] }, [
      ...groups,
      ...group,
    ]),
    groupId,
    buttonIds: buttons.map((b) => b.id),
  }
}

/** Move a group and every member by the same offset, atomically. */
export function moveGroup(
  layout: RemoteLayoutPayload,
  groupId: string,
  to: { readonly row: number; readonly col: number },
): LayoutEditResult {
  const groups = layout.groups ?? []
  const group = groups.find((g) => g.id === groupId)
  if (group === undefined) return refuse('unknown-group')
  const moved: RemoteLayoutGroup = { ...group, row: to.row, col: to.col }
  if (!fitsGrid(layout, moved)) return refuse('outside')
  const dRow = to.row - group.row
  const dCol = to.col - group.col
  const isMember = (b: RemoteLayoutButton): boolean => b.groupId === groupId
  const blocked =
    groups.some((g) => g.id !== groupId && rectsOverlap(g, moved)) ||
    layout.buttons.some((b) => !isMember(b) && rectsOverlap(b, moved))
  if (blocked) return refuse('overlap')
  return {
    ok: true,
    layout: {
      ...layout,
      buttons: layout.buttons.map((b) =>
        isMember(b) ? { ...b, row: b.row + dRow, col: b.col + dCol } : b,
      ),
      groups: groups.map((g) => (g.id === groupId ? moved : g)),
    },
  }
}

/**
 * Delete a group. With `keepButtons` its members stay where they are as loose
 * keys; without, they go with it.
 */
export function removeGroup(
  layout: RemoteLayoutPayload,
  groupId: string,
  options: { readonly keepButtons: boolean },
): LayoutEditResult {
  const groups = layout.groups ?? []
  if (!groups.some((g) => g.id === groupId)) return refuse('unknown-group')
  const buttons = options.keepButtons
    ? layout.buttons.map((b) => {
        if (b.groupId !== groupId) return b
        const { groupId: _gone, ...rest } = b
        return rest
      })
    : layout.buttons.filter((b) => b.groupId !== groupId)
  return {
    ok: true,
    layout: withGroups(
      { ...layout, buttons },
      groups.filter((g) => g.id !== groupId),
    ),
  }
}

/** Dissolve a group, keeping its buttons in place. */
export function ungroup(layout: RemoteLayoutPayload, groupId: string): LayoutEditResult {
  return removeGroup(layout, groupId, { keepButtons: true })
}
