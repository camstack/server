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
 *                          `NAME_COLUMN_PIN_CLASS`), flexible and shown in
 *                          full below it
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
 * fit BESIDE it. Below `md` every optional column is folded away, the table is
 * NAME + the controls cell and it does not scroll sideways at all (see below),
 * so there is nothing to pin against. The pin starts at `md`, the width at
 * which `features` returns and a column exists to scroll under it.
 */
export const NAME_COLUMN_PIN_BREAKPOINT = 'md' as const

/** Pin classes for the NAME `<th>`/`<td>` — never unconditional. */
export const NAME_COLUMN_PIN_CLASS = 'md:sticky md:left-0 md:z-[1]' as const

/**
 * ── Below `md`: a row is its name, its main control and its dot ───────────
 *
 * On a phone the table is NAME + the controls cell and NEVER scrolls sideways.
 * NAME is the flexible column (`w-full`): it takes what the controls leave and
 * shows the device name in FULL, wrapping to a second line when it must — a
 * name is never cut (`DeviceItemHeader fullNameBelowMd`). The controls cell is
 * one nowrap line holding the row's ONE main control and the status dot; the
 * row's other actions live in its swipe tray (`DeviceRowSwipeTray`), so the
 * cell stays narrow enough for the name to keep a readable width
 * (`min-w-[6.5rem]` is the floor).
 *
 * From `md` up the fixed `w-64` width, the one-line truncated name, the pin
 * and the inline actions return.
 */
export const NAME_COLUMN_TRUNCATE_BREAKPOINT = 'md' as const

/**
 * NAME column width: flexible below `md` (see above), a fixed capped width from
 * `md` up ([D43]). One constant for the `<th>` and the `<td>`, so they cannot drift.
 */
export const NAME_COLUMN_WIDTH_CLASS = 'w-full min-w-[6.5rem] md:w-64 md:max-w-[16rem]' as const

/**
 * The controls cell is one line at every width. It must never wrap: a wrapping
 * cluster stacks its controls one per line and the row grows to several times
 * its height on a phone.
 */
export const PREVIEW_CELL_CLASS = 'whitespace-nowrap' as const
