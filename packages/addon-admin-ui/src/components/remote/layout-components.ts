/**
 * The palette side of the template editor (D973): merge the components the
 * `remote-layout-components` cap serves, and put one on the grid. Placement is
 * `insertComponent` from `@camstack/types`; this adds the search for the first
 * free spot and the "stretch to the grid's width" scale.
 */
import {
  fillWidthScale,
  type InsertComponentResult,
  insertComponent,
  type RemoteLayoutComponent,
  type RemoteLayoutPayload,
} from '@camstack/types'

export interface PlaceOptions {
  /** Stretch the component to the whole grid width when the columns divide. */
  readonly fillWidth?: boolean
  /** Drop it here instead of at the first free spot. */
  readonly at?: { readonly row: number; readonly col: number }
}

/** Every list merged, one entry per id (the first wins), `core:` components first. */
export function mergeComponents(
  lists: readonly (readonly RemoteLayoutComponent[])[],
): RemoteLayoutComponent[] {
  const seen = new Map<string, RemoteLayoutComponent>()
  for (const list of lists) {
    for (const component of list) if (!seen.has(component.id)) seen.set(component.id, component)
  }
  const all = [...seen.values()]
  return [
    ...all.filter((c) => c.id.startsWith('core:')),
    ...all.filter((c) => !c.id.startsWith('core:')),
  ]
}

export function componentName(component: RemoteLayoutComponent, language: string): string {
  const localized = component.nameI18n
  if (localized === undefined) return component.name
  return language.startsWith('it') ? localized.it : localized.en
}

/** The component alone on a grid of its own size — the palette's thumbnail; null when it is malformed. */
export function componentPreview(component: RemoteLayoutComponent): RemoteLayoutPayload | null {
  const empty: RemoteLayoutPayload = {
    columns: component.size.cols,
    rows: component.size.rows,
    buttons: [],
  }
  const placed = insertComponent(empty, component, { row: 0, col: 0 })
  return placed.ok ? placed.layout : null
}

/** The components whose name or category contains `query` (case-insensitive); all of them when it is blank. */
export function filterComponents(
  components: readonly RemoteLayoutComponent[],
  query: string,
  language: string,
  categoryLabel: (category: string) => string,
): RemoteLayoutComponent[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return [...components]
  return components.filter(
    (c) =>
      componentName(c, language).toLowerCase().includes(needle) ||
      categoryLabel(c.category).toLowerCase().includes(needle),
  )
}

/** Whether "stretch to full width" does something for this component on this grid. */
export function canFillWidth(grid: RemoteLayoutPayload, component: RemoteLayoutComponent): boolean {
  const factor = fillWidthScale(grid, component)
  return factor !== null && factor > 1
}

/**
 * Put `component` on the grid at `options.at`, or at the first free spot
 * (rows top to bottom, columns left to right). When nothing fits, the refusal
 * is `outside` if the component is larger than the grid and `overlap` if the
 * grid is merely too full.
 */
export function placeComponent(
  grid: RemoteLayoutPayload,
  component: RemoteLayoutComponent,
  options: PlaceOptions = {},
): InsertComponentResult {
  const factor = options.fillWidth === true ? fillWidthScale(grid, component) : null
  const insertOptions = factor === null || factor < 2 ? {} : { scale: { cols: factor } }
  if (options.at !== undefined) return insertComponent(grid, component, options.at, insertOptions)
  const first = insertComponent(grid, component, { row: 0, col: 0 }, insertOptions)
  if (first.ok || first.reason === 'outside' || first.reason === 'too-many') return first
  for (let row = 0; row < grid.rows; row += 1) {
    for (let col = 0; col < grid.columns; col += 1) {
      const attempt = insertComponent(grid, component, { row, col }, insertOptions)
      if (attempt.ok) return attempt
    }
  }
  return first
}
