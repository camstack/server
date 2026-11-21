/**
 * Device-mode column model: a fixed catalog, a per-context subset matrix,
 * a responsive priority, and a priority-derived breakpoint mapping. Each
 * consumer declares its `TableContext`; the table renders only the columns
 * that context enables, in catalog order, hiding the optional ones as the
 * viewport narrows.
 *
 * The catalog is intentionally device-mode only. Generic-mode (integration
 * rows) keeps its own `DeviceListColumn[]` defs — reconciled in a later phase.
 *
 * ── Responsive convention (single source of truth) ────────────────────────
 *   LOWER priority number = MORE important = hidden at a NARROWER width (kept
 *   longest). So as the viewport shrinks the HIGHEST-priority-number column
 *   drops first.
 *
 *     name           (0) — never hidden; pinned left from `md` up (see
 *                          `NAME_COLUMN_PIN_CLASS`), scrolls below it
 *     previewActions (1) — never hidden; carries the live control + status dot
 *     icon           (2) — integration badge; rendered INSIDE the name cell,
 *                          not a standalone column, so it has no breakpoint
 *     features       (3) — optional; hidden below `md` (kept longer)
 *     type           (4) — optional; hidden below `lg`
 *     manufacturer   (5) — optional; hidden below `xl` (drops FIRST,
 *                          wide-screen-only hardware/identity column)
 *
 *   `COLUMN_BREAKPOINT_CLASS` derives ONE Tailwind visibility class per id and
 *   is the single source used by BOTH the `<th>` and the `<td>`, so a hidden
 *   column folds header + cell in lock-step. The drop order is therefore:
 *   `manufacturer` first (below `xl`), then `type` (below `lg`), then
 *   `features` (below `md`) — matching the priority numbers above.
 */

/** Fixed device-mode column catalog, in render order. `name` is always first.
 *  `manufacturer` sits after `type` — a wide-screen-only hardware/identity
 *  column (manufacturer · model, full metadata in a tooltip). */
export const DEVICE_COLUMNS = [
  'name',
  'icon',
  'type',
  'manufacturer',
  'features',
  'previewActions',
] as const

export type DeviceColumnId = (typeof DEVICE_COLUMNS)[number]

/**
 * The places a device table is rendered; each declares its column subset.
 *
 * Device-detail CHILDREN are deliberately NOT a table context: they render as
 * a stack of `<DeviceItem variant="minimal">` cards (see `ChildrenList`), not
 * through this table, so no `device-children` context exists.
 */
export type TableContext = 'devices' | 'integration-detail'

/**
 * Per-context column sets — the approved matrix (device mode). `name` always
 * first. `icon` (integration badge) only where devices from multiple
 * integrations mix (the all-devices page); `type` only there too.
 */
const CONTEXT_COLUMNS = {
  devices: ['name', 'icon', 'type', 'manufacturer', 'features', 'previewActions'],
  'integration-detail': ['name', 'manufacturer', 'features', 'previewActions'],
} satisfies Record<TableContext, readonly DeviceColumnId[]>

export function columnsForContext(ctx: TableContext): readonly DeviceColumnId[] {
  return CONTEXT_COLUMNS[ctx]
}

/**
 * Lower number = higher priority (kept longest as width shrinks). `name` = 0
 * (never dropped); `previewActions` = 1 (always visible). The optional
 * columns drop in REVERSE priority order as width shrinks — highest number
 * (`type`) hides first, then `features`. `icon` is a name-cell badge, not a
 * standalone column. See `COLUMN_BREAKPOINT_CLASS` for the derived classes.
 */
export const COLUMN_PRIORITY: Record<DeviceColumnId, number> = {
  name: 0,
  previewActions: 1,
  icon: 2,
  features: 3,
  type: 4,
  // Highest number → drops FIRST as width shrinks. The hardware column is
  // wide-screen-only (visible from `xl` up), so it's the least important and
  // folds away before `type`.
  manufacturer: 5,
}

/**
 * Priority-derived Tailwind visibility class per column. Used by BOTH the
 * `<th>` and the `<td>` (single source → header + cell stay in lock-step).
 *
 *   - `name` / `previewActions`: empty string — never hidden (always visible).
 *   - `icon`: empty string — rendered inside the name cell, no standalone cell.
 *   - `features`: `hidden md:table-cell` — visible from `md` up (kept longer).
 *   - `type`: `hidden lg:table-cell` — visible only from `lg` up.
 *   - `manufacturer`: `hidden xl:table-cell` — visible only from `xl` up (drops
 *     first).
 *
 * Drop order as the viewport narrows therefore follows the priority numbers:
 * `manufacturer` (5) disappears below `xl`, then `type` (4) below `lg`, then
 * `features` (3) below `md`.
 */
export const COLUMN_BREAKPOINT_CLASS: Record<DeviceColumnId, string> = {
  name: '',
  previewActions: '',
  icon: '',
  features: 'hidden md:table-cell',
  type: 'hidden lg:table-cell',
  // Wide-screen-only: visible from `xl` up. Drops earliest (highest priority
  // number), so on narrower viewports the hardware identity column folds away
  // before `type` — it's the widest, least-critical column.
  manufacturer: 'hidden xl:table-cell',
}

/**
 * ── The NAME column pin ───────────────────────────────────────────────────
 *
 * A sticky first column earns its keep only where the remaining columns still
 * fit BESIDE it. Read the drop order above: below `md` every optional column
 * is already folded away, so the table is NAME + Preview and there is nothing
 * left to scroll under the pin — the pinned column simply holds its width
 * permanently and pushes Preview off the right edge. On a phone the viewport
 * is narrower than the pinned column alone, which is the reported defect:
 * "il nome alla sinistra è fixed, dovrebbe scorrere naturalmente." [the name on the left is fixed, it should scroll naturally.]
 *
 * So the pin starts at `md`, the same width at which `features` returns and a
 * column exists to scroll under it. Below `md` the name column scrolls with
 * everything else.
 */
export const NAME_COLUMN_PIN_BREAKPOINT = 'md' as const

/** Pin classes for the NAME `<th>`/`<td>` — never unconditional. */
export const NAME_COLUMN_PIN_CLASS = 'md:sticky md:left-0 md:z-[1]' as const

/**
 * ── The NAME column fills what the controls leave, at every width ─────────
 *
 * Below `md` the table is NAME + the merged controls cell. NAME is the
 * flexible column (`w-full max-w-0`: it takes the remaining width and its text
 * ellipsises on the RIGHT, never clipped on the left), bounded below by
 * `min-w-[8rem]` so a name never collapses to "Ca…" — instead the controls cell
 * wraps (`PREVIEW_CELL_CLASS`) and gives the name its room. The table never
 * scrolls sideways on a phone; the wrapper's `overflow-x-auto` stays only as a
 * safety net for an unbreakable control.
 *
 * From `md` up the fixed `w-64` width and the pin return, as before.
 */
export const NAME_COLUMN_TRUNCATE_BREAKPOINT = 'md' as const

/**
 * NAME column width: flexible below `md` (see above), a fixed capped width from
 * `md` up ([D43]). One constant for the `<th>` and the `<td>`, so they cannot drift.
 */
export const NAME_COLUMN_WIDTH_CLASS =
  'w-full max-w-0 min-w-[8rem] md:w-64 md:max-w-[16rem]' as const

/**
 * The controls cell: below `md` it may wrap its cluster onto a second line so
 * the NAME column keeps its room; from `md` up it is one nowrap line.
 */
export const PREVIEW_CELL_CLASS = 'whitespace-normal md:whitespace-nowrap' as const
