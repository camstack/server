import { useUiText } from '../../contexts/ui-text'
import { ChevronDown, ChevronRight } from 'lucide-react'
import { type ReactNode, useMemo, useState } from 'react'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import { DeviceItem } from '../device-item'
import { groupChildrenByLayout } from '../device-item/child-layout'
import type { DeviceItemDevice, DeviceItemParent } from '../device-item/helpers'
import {
  COLUMN_BREAKPOINT_CLASS,
  NAME_COLUMN_PIN_CLASS,
  NAME_COLUMN_WIDTH_CLASS,
  type DeviceColumnId,
} from './columns'
import type { DeviceSort, SortableColumnId } from './sort'
import { SortableHeaderButton } from './sortable-header'

/** The `aria-sort` value the WAI-ARIA spec scopes to a `<th>`. `'none'` when
 *  this column is not the active sort column (each sortable header carries its
 *  own value so screen readers announce the table's single sorted column). */
type AriaSortValue = 'ascending' | 'descending' | 'none'

/** Derive the `<th>` `aria-sort` for `columnId` from the current sort state. */
function ariaSortFor(sort: DeviceSort | null, columnId: SortableColumnId): AriaSortValue {
  if (sort === null || sort.columnId !== columnId) return 'none'
  return sort.dir === 'asc' ? 'ascending' : 'descending'
}

/**
 * The row-layout contract. It used to live in `cards-layout.tsx` and be
 * EXTENDED here, because two layouts shared it. The cards layout is gone — the
 * device list is a table, always — so the contract lives with its only
 * implementation rather than in a file that exists to be inherited from.
 */
interface DeviceRowsProps {
  readonly rows: readonly DeviceItemDevice[]
  readonly accessoriesByParent: ReadonlyMap<number, readonly DeviceItemDevice[]>
  readonly trpc: UseDeviceProxyTrpc
  /** The badge beside a row's name — already bound to the row's resolved
   *  integration by the device-mode wrapper. */
  readonly resolveIntegrationIcon: ((device: DeviceItemDevice) => ReactNode | null) | null
  readonly resolveParent: ((parentId: number) => DeviceItemParent | null) | null
  readonly onNavigate: ((deviceId: number) => void) | null
  readonly renderRowAction: ((device: DeviceItemDevice) => ReactNode) | null
  readonly selectable: boolean
  /** Batch mode active — a row click toggles selection instead of navigating. */
  readonly rowClickSelects: boolean
  readonly activeSelected: ReadonlySet<number>
  readonly onToggleSelection: (id: number) => void
}

interface TableLayoutProps extends DeviceRowsProps {
  /** Built-in confirmed delete (table feature). Null ⇒ no trash. Only
   *  top-level rows carry it (accessory sub-rows are excluded — same gate
   *  as `renderRowAction`). */
  readonly onDeleteDevice: ((device: DeviceItemDevice) => void) | null
  /** Parent rows the OPERATOR opened. Only the chevron writes it — a search
   *  never does (it narrows the rows; it does not open them). */
  readonly expandedParents: ReadonlySet<number>
  readonly onToggleExpand: (parentId: number) => void
  /** Full unfiltered device list — used to resolve parent.type for the
   *  adopted-row indent. We can't rely on `resolveParent` returning the
   *  parent's type (callers historically only project id+name). */
  readonly devices: readonly DeviceItemDevice[]
  /** Context-selected columns to render (header + cells). `name` always on. */
  readonly visibleColumns: readonly DeviceColumnId[]
  /** Active sort (top-level rows), or `null` for the default incoming order.
   *  Owned by the device-mode wrapper so the sort applies before pagination. */
  readonly sort: DeviceSort | null
  /** Header-click handler — toggles the column's sort (asc→desc→none). */
  readonly onSort: (columnId: SortableColumnId) => void
}

// Indent levels for the table-view first cell:
//   0 → top-level (parentDeviceId null)
//   1 → adopted under a hub/nvr (parent.type ∈ {hub, nvr}) — visual
//       hierarchy hint so operators see the parent-child relationship
//       without relying solely on the "Under: <parent>" badge
//   2 → accessory under any parent (handled by `isAccessoryRow` →
//       index.tsx maps to indentLevel 2)
const HUB_LIKE_PARENT_TYPES: ReadonlySet<string> = new Set(['hub', 'nvr'])

function topLevelIndentLevel(device: DeviceItemDevice, parentType: string | null): 0 | 1 {
  if (device.parentDeviceId === null || parentType === null) return 0
  if (HUB_LIKE_PARENT_TYPES.has(parentType.toLowerCase())) return 1
  return 0
}

export function TableLayout({
  rows,
  accessoriesByParent,
  expandedParents,
  onToggleExpand,
  devices,
  visibleColumns,
  trpc,
  resolveIntegrationIcon,
  resolveParent,
  onNavigate,
  renderRowAction,
  onDeleteDevice,
  selectable,
  rowClickSelects,
  activeSelected,
  onToggleSelection,
  sort,
  onSort,
}: TableLayoutProps): ReactNode {
  const t = useUiText()
  const showType = visibleColumns.includes('type')
  const showFeatures = visibleColumns.includes('features')
  const showManufacturer = visibleColumns.includes('manufacturer')
  // The integration/provider badge in the name cell — gated by the `icon`
  // column. Off ⇒ pass `null` so the row renders only the lead device glyph.
  const showIcon = visibleColumns.includes('icon')
  // Local index for parent.type lookup. The injected `resolveParent`
  // historically only projects {id, name}; cheaper to walk our own
  // `devices` list once than to widen every caller's signature.
  const parentTypeById = useMemo(() => {
    const m = new Map<number, string>()
    for (const d of devices) m.set(d.id, d.type)
    return m
  }, [devices])
  return (
    // ONE horizontal scroll context for the whole table, not one per row: the
    // columns must stay aligned with their headers, and an operator dragging a
    // row sideways expects the header to come with it. Below `md` the NAME
    // column is uncapped (full device names — see
    // `NAME_COLUMN_TRUNCATE_BREAKPOINT`), so the table is routinely wider than
    // the viewport there and this is the element that scrolls.
    <div className="rounded-lg border border-border bg-surface overflow-x-auto">
      <table className="w-full border-collapse">
        <thead>
          {/* Secondary columns fold away as the viewport narrows so the table
              condenses instead of overflowing. The visibility class for each
              optional column is DERIVED from `COLUMN_BREAKPOINT_CLASS` (itself
              ordered by `COLUMN_PRIORITY`) and is the SINGLE source shared with
              the matching `<td>` in DeviceItemTableRow, so header + cell fold in
              lock-step. Drop order = priority order: `type` (below `lg`) drops
              FIRST, then `features` (below `md`). Name + the merged Preview
              column stay at every width.

              Phase 2 collapsed the former Preview + Actions headers into ONE
              `previewActions` column: a single right-aligned header whose cell
              composes the passive preview, the live control, quick-actions and
              the status dot. Header label is "Preview" (the cluster reads as a
              preview/control affordance). */}
          <tr className="border-b border-border">
            {/* NAME pins to the left edge FROM `md` UP: the page itself never
                h-scrolls (the consumer wraps this in `overflow-x-hidden`);
                only the table BODY scrolls, with NAME sticky so the device
                label stays anchored while Type/Features/previewActions scroll
                under it. The opaque `bg-surface` (matching the table surface)
                keeps the scrolled content from bleeding through the pinned
                column.

                Below `md` the pin is OFF — every optional column has already
                folded away there, so a pinned NAME would hold its width
                against nothing and push Preview off-screen. See
                `NAME_COLUMN_PIN_CLASS`. The width cap is off there too
                (`NAME_COLUMN_WIDTH_CLASS`): the column sizes to the longest
                device name and the wrapper above scrolls. */}
            <th
              aria-sort={ariaSortFor(sort, 'name')}
              className={cn(
                NAME_COLUMN_PIN_CLASS,
                NAME_COLUMN_WIDTH_CLASS,
                'bg-surface text-left px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle',
              )}
            >
              <SortableHeaderButton
                columnId="name"
                label={t('uiLibrary.deviceTable.name', 'Name')}
                sort={sort}
                onSort={onSort}
              />
            </th>
            {showType && (
              <th
                aria-sort={ariaSortFor(sort, 'type')}
                className={cn(
                  COLUMN_BREAKPOINT_CLASS.type,
                  'text-left px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle w-24',
                )}
              >
                <SortableHeaderButton
                  columnId="type"
                  label={t('uiLibrary.deviceTable.type', 'Type')}
                  sort={sort}
                  onSort={onSort}
                />
              </th>
            )}
            {showManufacturer && (
              <th
                aria-sort={ariaSortFor(sort, 'manufacturer')}
                className={cn(
                  COLUMN_BREAKPOINT_CLASS.manufacturer,
                  'text-left px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle w-40',
                )}
              >
                <SortableHeaderButton
                  columnId="manufacturer"
                  label={t('uiLibrary.deviceTable.hardware', 'Hardware')}
                  sort={sort}
                  onSort={onSort}
                />
              </th>
            )}
            {showFeatures && (
              <th
                className={cn(
                  COLUMN_BREAKPOINT_CLASS.features,
                  'text-left px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle w-32',
                )}
              >
                {t('uiLibrary.deviceTable.features', 'Features')}
              </th>
            )}
            <th className="text-right px-2 py-2 text-[9.5px] font-medium uppercase tracking-wider text-foreground-subtle w-32">
              {t('uiLibrary.deviceTable.preview', 'Preview')}
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((d) => {
            const accessories = accessoriesByParent.get(d.id) ?? []
            const hasAccessories = accessories.length > 0
            const parentRowParent =
              d.parentDeviceId !== null ? (resolveParent?.(d.parentDeviceId) ?? null) : null
            const parentType =
              d.parentDeviceId !== null ? (parentTypeById.get(d.parentDeviceId) ?? null) : null
            const selection = selectable
              ? { selected: activeSelected.has(d.id), onToggle: () => onToggleSelection(d.id) }
              : undefined
            return (
              <TableRowGroup
                key={d.id}
                parent={d}
                accessories={accessories}
                hasAccessories={hasAccessories}
                expanded={expandedParents.has(d.id)}
                onToggleExpand={() => onToggleExpand(d.id)}
                trpc={trpc}
                integrationIcon={showIcon ? (resolveIntegrationIcon?.(d) ?? null) : null}
                showType={showType}
                showManufacturer={showManufacturer}
                showFeatures={showFeatures}
                parentRowParent={parentRowParent}
                indentLevel={topLevelIndentLevel(d, parentType)}
                onNavigate={onNavigate ?? null}
                renderRowAction={renderRowAction ?? null}
                onDeleteDevice={onDeleteDevice}
                selection={selection}
                rowClickSelects={rowClickSelects}
              />
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Per-row selection state threaded to `<DeviceItem selection>`. */
interface RowSelection {
  readonly selected: boolean
  readonly onToggle: () => void
}

interface TableRowGroupProps {
  readonly parent: DeviceItemDevice
  readonly accessories: readonly DeviceItemDevice[]
  readonly hasAccessories: boolean
  readonly expanded: boolean
  readonly onToggleExpand: () => void
  readonly trpc: UseDeviceProxyTrpc
  readonly integrationIcon: ReactNode | null
  /** Render the Type cell for this row (context-gated). */
  readonly showType: boolean
  /** Render the Hardware (manufacturer/model) cell for this row (context-gated). */
  readonly showManufacturer: boolean
  /** Render the Features cell for this row (context-gated). */
  readonly showFeatures: boolean
  readonly parentRowParent: DeviceItemParent | null
  readonly indentLevel: 0 | 1
  readonly onNavigate: ((id: number) => void) | null
  readonly renderRowAction: ((device: DeviceItemDevice) => ReactNode) | null
  /** Built-in confirmed delete — only the top-level parent row carries it. */
  readonly onDeleteDevice: ((device: DeviceItemDevice) => void) | null
  readonly selection?: RowSelection
  /** Batch mode active — the parent row's click toggles selection. */
  readonly rowClickSelects: boolean
}

function TableRowGroup({
  parent,
  accessories,
  hasAccessories,
  expanded,
  onToggleExpand,
  trpc,
  integrationIcon,
  showType,
  showManufacturer,
  showFeatures,
  parentRowParent,
  indentLevel,
  onNavigate,
  renderRowAction,
  onDeleteDevice,
  selection,
  rowClickSelects,
}: TableRowGroupProps): ReactNode {
  // The open state is the LIST's (`DeviceModeList.openParents`), not this
  // row's: a row that owned it lost it whenever a search or a page change
  // unmounted the row, and a search used to overwrite it. The chevron is the
  // only writer.
  const showAccessoryRows = hasAccessories && expanded

  // Partition the accessories into provider-declared accordion sections +
  // the remaining (ungrouped) ones. When the parent declares no `childLayout`,
  // `sections` is empty and `ungrouped === accessories` → identical flat
  // rendering to before. Shared with the device-detail list via the same
  // pure `groupChildrenByLayout` helper.
  const grouped = useMemo(
    () => groupChildrenByLayout(parent.stableId, accessories, parent.childLayout),
    [parent.stableId, parent.childLayout, accessories],
  )

  // Per-section open state. The table can't host the card <ChildSectionAccordion>
  // (rows must be <tr>), so we track a small open set here + render a
  // collapsible section-header <tr>. Sections are open by default: a title is
  // "closed" only once it appears in this set. The INITIAL set is seeded (lazy
  // initializer) directly from `grouped` (already computed above) — sections
  // whose provider declared them collapsed (`defaultOpen === false`); the
  // user's subsequent manual toggles then own the state and are never reset on
  // re-render.
  const [closedSections, setClosedSections] = useState<ReadonlySet<string>>(() => {
    const closed = grouped.sections.filter((s) => !s.defaultOpen).map((s) => s.title)
    // The synthetic Disabled section is collapsed by default too.
    if (grouped.disabledSection !== undefined && !grouped.disabledSection.defaultOpen) {
      closed.push(grouped.disabledSection.title)
    }
    return new Set(closed)
  })
  const toggleSection = (title: string): void =>
    setClosedSections((prev) => {
      const next = new Set(prev)
      if (next.has(title)) next.delete(title)
      else next.add(title)
      return next
    })

  // colSpan for the full-width section-header row: name + previewActions are
  // always present; type/manufacturer/features are context-gated (must stay in
  // lock-step with the header cells in TableLayout).
  const sectionColSpan =
    2 + (showType ? 1 : 0) + (showManufacturer ? 1 : 0) + (showFeatures ? 1 : 0)

  // Hoisted so the JSX reads it without a non-null assertion.
  const disabledSection = grouped.disabledSection

  return (
    <>
      <DeviceItem
        trpc={trpc}
        device={parent}
        view="table"
        integrationIcon={integrationIcon}
        parent={parentRowParent}
        children={accessories}
        onNavigate={onNavigate ?? undefined}
        // Always reserve the accordion column on top-level rows so a simple
        // device (no children) lines up with the container rows that own a
        // chevron — the header renders an empty placeholder of the same width
        // when this row has no children. The chevron BUTTON + the "+N" badge
        // still appear only when the row actually has accessories.
        showChildrenAccordion
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        indentLevel={indentLevel}
        renderRowAction={renderRowAction ?? undefined}
        onDelete={onDeleteDevice ?? undefined}
        selection={selection}
        rowClickSelects={rowClickSelects}
        showTypeCell={showType}
        showManufacturerCell={showManufacturer}
        showFeaturesCell={showFeatures}
      />
      {/* Ungrouped accessory sub-rows render exactly as before. They
          intentionally omit `renderRowAction` and `selection` — only
          top-level rows carry the caller's per-row affordance. */}
      {showAccessoryRows &&
        grouped.ungrouped.map((a) => (
          <AccessorySubRow
            key={a.id}
            trpc={trpc}
            accessory={a}
            parentName={parent.name}
            showType={showType}
            showManufacturer={showManufacturer}
            showFeatures={showFeatures}
            onNavigate={onNavigate}
          />
        ))}
      {/* Layout-declared sections: a collapsible header <tr> followed by the
          section's accessory sub-rows when open (open by default). */}
      {showAccessoryRows &&
        grouped.sections.map((section) => {
          const open = !closedSections.has(section.title)
          return (
            <SectionRows
              key={section.title}
              title={section.title}
              count={section.children.length}
              open={open}
              colSpan={sectionColSpan}
              onToggle={() => toggleSection(section.title)}
              rows={section.children}
              trpc={trpc}
              parentName={parent.name}
              showType={showType}
              showManufacturer={showManufacturer}
              showFeatures={showFeatures}
              onNavigate={onNavigate}
            />
          )
        })}
      {/* Trailing synthetic "Disabled" section — every child whose CamStack-side
          `disabled` flag is set, rendered LAST + muted. Collapsed by default
          (seeded into `closedSections`). */}
      {showAccessoryRows && disabledSection !== undefined && (
        <SectionRows
          key={disabledSection.title}
          title={disabledSection.title}
          count={disabledSection.children.length}
          open={!closedSections.has(disabledSection.title)}
          colSpan={sectionColSpan}
          onToggle={() => toggleSection(disabledSection.title)}
          rows={disabledSection.children}
          trpc={trpc}
          parentName={parent.name}
          showType={showType}
          showManufacturer={showManufacturer}
          showFeatures={showFeatures}
          onNavigate={onNavigate}
          muted
        />
      )}
    </>
  )
}

interface AccessorySubRowProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly accessory: DeviceItemDevice
  /** Parent row's name — used to strip the redundant baked-in prefix from the
   *  child's DISPLAY name (the underlying `accessory.name` is untouched). */
  readonly parentName: string
  readonly showType: boolean
  readonly showManufacturer: boolean
  readonly showFeatures: boolean
  readonly onNavigate: ((id: number) => void) | null
  /** Render the row visually de-emphasized (the synthetic Disabled section). */
  readonly muted?: boolean
}

/** A single accessory sub-row — the existing flat rendering, factored out so
 *  both the ungrouped pass and the per-section pass share it identically.
 *  `muted` wraps the row in an `opacity-60` group so a disabled child reads as
 *  de-emphasized — matching the `!enabled` idiom in the device-item header. */
function AccessorySubRow({
  trpc,
  accessory,
  parentName,
  showType,
  showManufacturer,
  showFeatures,
  onNavigate,
  muted,
}: AccessorySubRowProps): ReactNode {
  return (
    <DeviceItem
      trpc={trpc}
      device={accessory}
      view="table"
      integrationIcon={null}
      parent={
        accessory.parentDeviceId === null
          ? null
          : { id: accessory.parentDeviceId, name: parentName }
      }
      isAccessoryRow
      showChildrenAccordion={false}
      onNavigate={onNavigate ?? undefined}
      showTypeCell={showType}
      showManufacturerCell={showManufacturer}
      showFeaturesCell={showFeatures}
      className={muted === true ? 'opacity-60' : undefined}
    />
  )
}

interface SectionRowsProps {
  readonly title: string
  readonly count: number
  readonly open: boolean
  readonly colSpan: number
  readonly onToggle: () => void
  readonly rows: readonly DeviceItemDevice[]
  readonly trpc: UseDeviceProxyTrpc
  /** Parent row's name — forwarded to each `AccessorySubRow` for prefix strip. */
  readonly parentName: string
  readonly showType: boolean
  readonly showManufacturer: boolean
  readonly showFeatures: boolean
  readonly onNavigate: ((id: number) => void) | null
  /** Render the section's rows de-emphasized (the synthetic Disabled section). */
  readonly muted?: boolean
}

/** A childLayout section inside an expanded container row: a full-width,
 *  collapsible section-header <tr> (chevron + uppercase title + count) plus the
 *  section's accessory sub-rows when open. Reads as a subtle divider; matches
 *  the accessory sub-row indentation. Open by default. */
function SectionRows({
  title,
  count,
  open,
  colSpan,
  onToggle,
  rows,
  trpc,
  parentName,
  showType,
  showManufacturer,
  showFeatures,
  onNavigate,
  muted,
}: SectionRowsProps): ReactNode {
  return (
    <>
      <tr
        className={cn(
          'border-b border-border-subtle/40 bg-surface',
          muted === true && 'opacity-60',
        )}
      >
        <td colSpan={colSpan} className="p-0">
          <button
            type="button"
            onClick={onToggle}
            className="w-full flex items-center gap-1.5 pl-8 pr-2 py-1 text-left hover:bg-surface-hover transition-colors"
            aria-expanded={open}
          >
            {open ? (
              <ChevronDown className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
            ) : (
              <ChevronRight className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
            )}
            <span className="text-[10px] font-semibold uppercase tracking-wide text-foreground-subtle flex-1 truncate">
              {title}
            </span>
            <span className="text-[10px] font-medium text-foreground-subtle/70 tabular-nums">
              {count}
            </span>
          </button>
        </td>
      </tr>
      {open &&
        rows.map((a) => (
          <AccessorySubRow
            key={a.id}
            trpc={trpc}
            accessory={a}
            parentName={parentName}
            showType={showType}
            showManufacturer={showManufacturer}
            showFeatures={showFeatures}
            onNavigate={onNavigate}
            muted={muted}
          />
        ))}
    </>
  )
}
