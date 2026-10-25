/**
 * <DeviceItem> — orchestrator that composes Header / Preview /
 * Features / Actions / StatusDot in a flex row (`view='card'`) or a
 * `<tr>` with one `<td>` per logical column (`view='table'`).
 *
 * Public API contract: identical to the predecessor `device-item.tsx`
 * file so the 5 existing call sites compile unchanged. The new
 * `view` prop defaults to `'card'`.
 */
import { useUiText } from '../../contexts/ui-text'
import { type KeyboardEvent, type ReactNode, useState } from 'react'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import {
  COLUMN_BREAKPOINT_CLASS,
  NAME_COLUMN_PIN_CLASS,
  NAME_COLUMN_WIDTH_CLASS,
} from '../device-list/columns'
import { HardwareCell } from '../device-list/hardware-cell'
import { DeviceItemActions } from './actions'
import { ChildrenAccordion } from './children-accordion'
import { useContainerChildren } from './container-children-context'
import { DeviceDeleteAction } from './device-delete-action'
import { DeviceItemFeatures } from './features'
import { DeviceItemHeader } from './header'
import {
  type DeviceItemDevice,
  type DeviceItemParent,
  type DeviceItemProps,
  type DeviceItemVariant,
  effectiveOnline,
  effectiveType,
  isAccessoryChild,
  resolveFlags,
  type VariantDefaults,
} from './helpers'
import { DeviceItemPreview } from './preview'
import { DeviceQuickDetailAction } from './quick-detail-action'
import { StatusDot } from './status-dot'

export type { ChildLayoutSection, GroupedChildren } from './child-layout'
export { groupChildrenByLayout } from './child-layout'
export { ChildSectionAccordion } from './child-section-accordion'
export { ContainerChildrenProvider, useContainerChildren } from './container-children-context'
export {
  RoleDisplayDefaultsFromServer,
  RoleDisplayDefaultsProvider,
  useRoleDisplayDefaults,
  type RoleDisplayDefaults,
} from './role-display-defaults-context'
export type {
  DeviceItemDevice,
  DeviceItemKind,
  DeviceItemParent,
  DeviceItemProps,
  DeviceItemVariant,
  DeviceItemView,
} from './helpers'
export { childListName, deriveDeviceKind, stripParentNamePrefix } from './helpers'

export function DeviceItem(props: DeviceItemProps): ReactNode {
  const t = useUiText()
  const {
    trpc,
    device,
    parent,
    integrationIcon,
    onNavigate,
    className,
    renderRowAction,
    onDelete,
    selection,
  } = props
  const flags = resolveFlags(props)
  const variant = props.variant ?? 'compact'
  const view = props.view ?? 'card'

  const enabled = !device.disabled
  const isCamera = device.isCamera ?? device.type.toLowerCase() === 'camera'

  const childrenList = props.children ?? []
  const accessoryChildren = childrenList.filter(isAccessoryChild)
  const adoptedChildren = childrenList.filter((c) => !isAccessoryChild(c))
  const hasChildren = childrenList.length > 0

  const [localExpanded, setLocalExpanded] = useState(false)
  const expanded = props.expanded ?? localExpanded
  const onToggleExpand = props.onToggleExpand ?? ((): void => setLocalExpanded((v) => !v))
  const navigate = (id: number): void => {
    onNavigate?.(id)
  }

  // Batch-mode interaction (spec §6): when `rowClickSelects` is on AND a
  // `selection` is present, a click on the row's primary body toggles the
  // selection instead of navigating. Otherwise the row navigates as usual.
  // The leading checkbox keeps its own `stopPropagation`, so it toggles
  // exactly once via either path.
  const rowSelects = props.rowClickSelects === true && selection !== undefined
  const onRowClick = (): void => {
    if (rowSelects && selection !== undefined) {
      selection.onToggle()
      return
    }
    navigate(device.id)
  }

  // Indent: caller may force a specific level; otherwise infer 2 from
  // the legacy `isAccessoryRow` flag for backwards compatibility, else
  // 0 (top-level).
  const indentLevel: 0 | 1 | 2 = props.indentLevel ?? (props.isAccessoryRow ? 2 : 0)

  // A CONTAINER row renders AS its primary child, so its reachability dot
  // follows that primary child's `online` (resolved via the SAME helper the
  // row control uses, so dot + control agree). Non-containers / no resolvable
  // primary child fall back to `device.online`. Applies to BOTH card + table
  // (this `displayStatus` is threaded into the table-row branch below).
  const online = effectiveOnline(device, childrenList)
  // The generic device row stays fetch-free (it renders in many contexts +
  // tests without a tRPC provider), so it resolves only reachability states.
  // The StatusDot atom additionally supports recording-continuous / -events for
  // callers that resolve a recording mode (viewer parity); the recording-aware
  // wiring for admin rows is a page-level follow-up (batched recording modes).
  const displayStatus: 'online' | 'offline' | 'disabled' = !enabled
    ? 'disabled'
    : online
      ? 'online'
      : 'offline'

  if (view === 'table') {
    return (
      <DeviceItemTableRow
        trpc={trpc}
        device={device}
        variant={variant}
        flags={flags}
        parent={parent ?? null}
        integrationIcon={integrationIcon ?? null}
        accessoryCount={accessoryChildren.length}
        adoptedCount={adoptedChildren.length}
        hasChildren={hasChildren}
        expanded={expanded}
        onToggleExpand={onToggleExpand}
        onRowClick={onRowClick}
        rowSelects={rowSelects}
        rowSelected={selection?.selected ?? false}
        onNavigate={navigate}
        displayStatus={displayStatus}
        isCamera={isCamera}
        showSnapshot={flags.showSnapshot && isCamera}
        isAccessoryRow={props.isAccessoryRow ?? false}
        indentLevel={indentLevel}
        className={className}
        renderRowAction={renderRowAction ?? null}
        onDelete={onDelete ?? null}
        selection={selection}
        showTypeCell={props.showTypeCell ?? true}
        showManufacturerCell={props.showManufacturerCell ?? true}
        showFeaturesCell={props.showFeaturesCell ?? true}
      />
    )
  }

  // Two card layouts share the same orchestrator branch:
  //
  //   - `minimal` keeps the legacy horizontal row (used by
  //     `<ChildrenList>` inside the device-detail panel — it's already a
  //     vertical stack of dense in-panel rows and would visually break
  //     if each row grew into a square card).
  //
  //   - everything else (compact / expanded, the default for
  //     `<DeviceList view='cards'>`) renders the new vertical-stacked
  //     card so the name has room to breathe and wrap to 2 lines instead
  //     of being clipped to "Camera vera…" in a 1-row pill.
  if (variant === 'minimal') {
    return (
      <div
        className={cn(
          'rounded-lg border border-border bg-surface transition-colors',
          !enabled && 'opacity-60',
          className,
        )}
      >
        <div
          data-testid="device-card-body"
          onClick={onRowClick}
          {...(rowSelects
            ? {
                role: 'button' as const,
                'aria-pressed': selection?.selected ?? false,
                tabIndex: 0,
                onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault()
                    onRowClick()
                  }
                },
              }
            : {})}
          className={cn(
            'flex items-center gap-2 cursor-pointer hover:border-foreground-subtle/30 w-full px-2.5 py-1.5',
            // Batch-mode selected highlight — mirrors the table row's token so
            // the selected state reads identically across views.
            selection?.selected && 'bg-primary/10',
          )}
        >
          {selection && (
            <input
              type="checkbox"
              checked={selection.selected}
              onChange={selection.onToggle}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('uiLibrary.deviceItem.select', 'Select {{name}}', {
                name: device.name,
              })}
              className="flex-shrink-0"
            />
          )}
          <DeviceItemHeader
            trpc={trpc}
            device={device}
            variant={variant}
            flags={flags}
            parent={parent ?? null}
            integrationIcon={integrationIcon ?? null}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onNavigateToParent={navigate}
          />

          <DeviceItemFeatures
            trpc={trpc}
            device={device}
            flags={flags}
            accessoryCount={accessoryChildren.length}
            adoptedCount={adoptedChildren.length}
            showFeatureRow={false}
          />

          <DeviceItemPreview
            trpc={trpc}
            device={device}
            status={displayStatus}
            enabled={flags.showSnapshot && isCamera}
            showStatusPills
          />

          <DeviceItemActions trpc={trpc} device={device} flags={flags} controlPlacement="right" />
          <DeviceQuickDetailAction deviceId={device.id} />

          {renderRowAction && (
            <span onClick={(e) => e.stopPropagation()}>{renderRowAction(device)}</span>
          )}

          <StatusDot status={displayStatus} />
        </div>

        {expanded && hasChildren && (
          <ChildrenAccordion
            trpc={trpc}
            accessoryChildren={accessoryChildren}
            adoptedChildren={adoptedChildren}
            onNavigate={navigate}
            parentName={device.name}
          />
        )}
      </div>
    )
  }

  // Vertical-stacked card. Layout:
  //
  //   ┌─────────────────────────────────────────┐
  //   │ [icon] Camera della         •      │  ← name, 2-line clamp
  //   │        porch (long)                   │     primary anchor
  //   │ [provider-icon]                         │     (lead lines)
  //   │                                         │
  //   │ [features ··· ··· ···]                  │  ← secondary chips
  //   │                                         │
  //   │ Under: NVR-12          [preview][···]   │  ← parent + actions
  //   └─────────────────────────────────────────┘
  //
  // No `min-h` and no `mt-auto`: card height follows content. Same-row
  // bottom alignment is delegated to the parent grid's `items-stretch`
  // (the tallest card in the row dictates the row height), so shorter
  // cards keep a compact body instead of a hollow middle band.
  return (
    <div
      className={cn(
        'group rounded-xl border border-border bg-surface transition-colors',
        'hover:border-foreground-subtle/30',
        !enabled && 'opacity-60',
        className,
      )}
    >
      <div
        data-testid="device-card-body"
        onClick={onRowClick}
        {...(rowSelects
          ? {
              role: 'button' as const,
              'aria-pressed': selection?.selected ?? false,
              tabIndex: 0,
              onKeyDown: (e: KeyboardEvent<HTMLDivElement>) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault()
                  onRowClick()
                }
              },
            }
          : {})}
        className={cn(
          'flex flex-col gap-2 cursor-pointer w-full p-3 rounded-xl',
          // Batch-mode selected highlight — mirrors the table row's token so
          // the selected state reads identically across views.
          selection?.selected && 'bg-primary/10',
        )}
      >
        <div className="flex items-start justify-between gap-2">
          {selection && (
            <input
              type="checkbox"
              checked={selection.selected}
              onChange={selection.onToggle}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('uiLibrary.deviceItem.select', 'Select {{name}}', {
                name: device.name,
              })}
              className="flex-shrink-0 mt-0.5"
            />
          )}
          <DeviceItemHeader
            trpc={trpc}
            device={device}
            variant={variant}
            flags={flags}
            parent={parent ?? null}
            integrationIcon={integrationIcon ?? null}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onNavigateToParent={navigate}
            stacked
          />
          <StatusDot status={displayStatus} />
        </div>

        <DeviceItemFeatures
          trpc={trpc}
          device={device}
          flags={flags}
          accessoryCount={accessoryChildren.length}
          adoptedCount={adoptedChildren.length}
          showFeatureRow={false}
        />

        <div className="flex items-center justify-end gap-1.5">
          <DeviceItemPreview
            trpc={trpc}
            device={device}
            status={displayStatus}
            enabled={flags.showSnapshot && isCamera}
            showStatusPills
          />
          <DeviceItemActions trpc={trpc} device={device} flags={flags} controlPlacement="right" />
          <DeviceQuickDetailAction deviceId={device.id} />
          {renderRowAction && (
            <span onClick={(e) => e.stopPropagation()}>{renderRowAction(device)}</span>
          )}
        </div>
      </div>

      {expanded && hasChildren && (
        <ChildrenAccordion
          trpc={trpc}
          accessoryChildren={accessoryChildren}
          adoptedChildren={adoptedChildren}
          onNavigate={navigate}
          parentName={device.name}
        />
      )}
    </div>
  )
}

// ── view='table' branch ─────────────────────────────────────────────
//
// Placeholder until Task 10 lands the full table implementation. We
// keep the orchestrator export self-consistent by stubbing here so
// `npx tsc --noEmit` stays green between tasks.

interface DeviceItemTableRowProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly variant: DeviceItemVariant
  readonly flags: VariantDefaults
  readonly parent: DeviceItemParent | null
  readonly integrationIcon: ReactNode | null
  readonly accessoryCount: number
  readonly adoptedCount: number
  readonly hasChildren: boolean
  readonly expanded: boolean
  readonly onToggleExpand: () => void
  readonly onNavigate: (id: number) => void
  /**
   * Primary row-click handler. In batch mode (`rowSelects`) it toggles
   * the row's selection; otherwise it navigates. Pre-resolved by the
   * orchestrator so this row stays presentational.
   */
  readonly onRowClick: () => void
  /** Batch mode is active for this row — row click selects, not navigates. */
  readonly rowSelects: boolean
  /** Current selected state — drives `aria-pressed` when `rowSelects`. */
  readonly rowSelected: boolean
  readonly displayStatus: 'online' | 'offline' | 'disabled'
  readonly isCamera: boolean
  readonly showSnapshot: boolean
  readonly isAccessoryRow: boolean
  readonly indentLevel: 0 | 1 | 2
  readonly className: string | undefined
  readonly renderRowAction: ((device: DeviceItemDevice) => ReactNode) | null
  /** Built-in confirmed delete handler — when non-null, the merged cell
   *  renders a red trash button that confirms before invoking it. */
  readonly onDelete: ((device: DeviceItemDevice) => void) | null
  readonly selection?: {
    readonly selected: boolean
    readonly onToggle: () => void
  }
  /** Render the Type cell (context-gated, defaults true at the orchestrator). */
  readonly showTypeCell: boolean
  /** Render the Hardware (manufacturer/model) cell (context-gated, defaults true). */
  readonly showManufacturerCell: boolean
  /** Render the Features cell (context-gated, defaults true at the orchestrator). */
  readonly showFeaturesCell: boolean
}

const INDENT_CLASS: Readonly<Record<0 | 1 | 2, string>> = {
  0: 'pl-2',
  1: 'pl-6',
  2: 'pl-8',
}

function DeviceItemTableRow(props: DeviceItemTableRowProps): ReactNode {
  const t = useUiText()
  const {
    trpc,
    device,
    variant,
    flags,
    parent,
    integrationIcon,
    accessoryCount,
    adoptedCount,
    hasChildren,
    expanded,
    onToggleExpand,
    onNavigate,
    onRowClick,
    rowSelects,
    rowSelected,
    displayStatus,
    isCamera,
    showSnapshot,
    isAccessoryRow,
    indentLevel,
    className,
    renderRowAction,
    onDelete,
    selection,
    showTypeCell,
    showManufacturerCell,
    showFeaturesCell,
  } = props

  // Container rows render AS their primary child (the effective type badge +
  // the inline control). Resolve the child set from the list-level context
  // rather than receiving it as a threaded prop.
  const containerChildren = useContainerChildren(device.id)

  return (
    <tr
      onClick={onRowClick}
      {...(rowSelects
        ? {
            role: 'button' as const,
            'aria-pressed': rowSelected,
            tabIndex: 0,
            onKeyDown: (e: KeyboardEvent<HTMLTableRowElement>) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                onRowClick()
              }
            },
          }
        : {})}
      className={cn(
        // `group` lets the sticky NAME cell mirror the row's hover bg via
        // `group-hover:*` — without it the opaque sticky cell paints OVER the
        // row hover, leaving the NAME area as a plain stripe (visible gap).
        'group cursor-pointer hover:bg-surface-hover transition-colors',
        // Leaf rows (no children) carry the subtle separator; an expandable
        // parent omits it because its child rows provide the visual break.
        // Keyed on `hasChildren` (not the accordion-column flag) so reserving
        // the chevron slot for alignment doesn't strip a simple row's border.
        !hasChildren && 'border-b border-border-subtle/40',
        isAccessoryRow && 'bg-foreground-subtle/[0.03]',
        // Batch-mode selected state — a clear, visible highlight so an
        // operator can see at a glance which rows are in the batch. Sits on
        // the `<tr>`; the sticky NAME cell mirrors the same token below so the
        // pinned column doesn't show a plain stripe over the highlighted row.
        rowSelected && 'bg-primary/10',
        className,
      )}
    >
      {/* Header cell collapses to icon + name + meta + parent into
          one wide name column. The chevron, when applicable, sits
          beside the lead icon as in the card layout. Indent level is
          derived from `indentLevel` so adopted-under-hub rows render
          at pl-6 without the accessory tint. */}
      {/* NAME pins to the left edge FROM `md` UP so it stays anchored while
          the table body x-scrolls under it. The pin + an opaque `bg-surface`
          keep the scrolled cells from bleeding through; the indent padding
          (`INDENT_CLASS`) sits ON the same cell, so the hierarchy indent and
          the pin coexist. The `md:z-[1]` keeps it above the scrolling
          siblings. Below `md` the pin is OFF and the column scrolls with
          everything else — see `NAME_COLUMN_PIN_CLASS`. */}
      <td
        className={cn(
          // Opaque default bg keeps scrolled cells from bleeding through the pin.
          // `group-hover:bg-surface-hover` makes the sticky cell follow the row's
          // hover so the NAME area highlights WITH the rest of the row (no gap).
          // For accessory sub-rows the cell mirrors the row's faint tint instead
          // of the plain surface, so the pin matches the tinted row.
          // `transition-colors` MUST match the <tr>'s transition — without it the
          // pinned cell snaps to the hover colour instantly while the rest of the
          // row fades, so the row reads as TWO distinct highlights during the
          // transition instead of one continuous one.
          NAME_COLUMN_PIN_CLASS,
          'py-1.5 align-middle pr-2 transition-colors',
          // Mirror the row's selected/accessory/default background so the pinned
          // cell never paints a plain stripe OVER a highlighted (selected) or
          // tinted (accessory) row. Selected wins over the accessory tint so a
          // selected accessory still reads as selected. `group-hover:*` keeps the
          // cell following the row's hover in every state.
          rowSelected
            ? 'bg-primary/10 group-hover:bg-surface-hover'
            : isAccessoryRow
              ? 'bg-surface-subtle group-hover:bg-surface-hover'
              : 'bg-surface group-hover:bg-surface-hover',
          // FROM `md` UP: bound the merged NAME column so it can't claim the
          // whole table. In an auto-layout table a lone `max-w` on a <td> is
          // unreliable — pair it with an explicit width (matching the <th>,
          // hence the SHARED `NAME_COLUMN_WIDTH_CLASS`) so the column sizes to
          // a sane fixed width, and `overflow-hidden` + `min-w-0` let the name
          // span truncate with an ellipsis instead of forcing the column wider.
          //
          // BELOW `md` the width cap is OFF, so the full device name sizes the
          // column and the table grows past the viewport — the wrapper's
          // `overflow-x-auto` is what the operator then scrolls. See
          // `NAME_COLUMN_TRUNCATE_BREAKPOINT`. `min-w-0 overflow-hidden` stays
          // unconditional: it is inert while the column is uncapped, and it is
          // what keeps an unexpected squeeze CLIPPING instead of overlapping
          // the Preview column.
          NAME_COLUMN_WIDTH_CLASS,
          'min-w-0 overflow-hidden',
          INDENT_CLASS[indentLevel],
        )}
      >
        <div className="flex items-center gap-1.5">
          {selection && (
            <input
              type="checkbox"
              checked={selection.selected}
              onChange={selection.onToggle}
              onClick={(e) => e.stopPropagation()}
              aria-label={t('uiLibrary.deviceItem.select', 'Select {{name}}', {
                name: device.name,
              })}
              className="flex-shrink-0"
            />
          )}
          <DeviceItemHeader
            trpc={trpc}
            device={device}
            variant={variant}
            flags={flags}
            parent={parent}
            integrationIcon={integrationIcon}
            hasChildren={hasChildren}
            expanded={expanded}
            onToggleExpand={onToggleExpand}
            onNavigateToParent={onNavigate}
            // The table is the one layout with somewhere to scroll TO, so it is
            // the one layout where the name never has to be cut.
            nameOverflow="scroll"
          />
        </div>
      </td>

      {/* Responsive column visibility — the breakpoint class is DERIVED from
          `COLUMN_BREAKPOINT_CLASS` (priority-ordered) and is the SAME class the
          matching <th> in device-list TableLayout uses, so header + cell fold in
          lock-step. Drop order follows priority: Type (below lg) folds first,
          then Features (below md). */}
      {showTypeCell && (
        <td
          className={cn(
            COLUMN_BREAKPOINT_CLASS.type,
            'px-2 py-1.5 align-middle text-[10px] text-foreground-subtle whitespace-nowrap',
          )}
        >
          {/* A container reads as its primary child's type (e.g. `vacuum`), so the
              badge matches what the row renders + what the type filter selects. */}
          {effectiveType(device, containerChildren)}
        </td>
      )}

      {/* Hardware (manufacturer · model) — wide-screen-only column. The cell
          truncates and exposes the full metadata identity blob in a tooltip.
          Gated by the same `manufacturer` breakpoint class the matching <th>
          uses, so header + cell fold in lock-step. */}
      {showManufacturerCell && (
        <td
          className={cn(
            COLUMN_BREAKPOINT_CLASS.manufacturer,
            'px-2 py-1.5 align-middle w-40 max-w-[10rem] min-w-0 overflow-hidden',
          )}
        >
          <HardwareCell device={device} />
        </td>
      )}

      {showFeaturesCell && (
        <td className={cn(COLUMN_BREAKPOINT_CLASS.features, 'px-2 py-1.5 align-middle')}>
          <DeviceItemFeatures
            trpc={trpc}
            device={device}
            flags={flags}
            accessoryCount={accessoryCount}
            adoptedCount={adoptedCount}
            showFeatureRow
          />
        </td>
      )}

      {/* Merged previewActions cell (Phase 2): ONE trailing column composing
          the PASSIVE preview (battery/charging pills + snapshot eye) with the
          INTERACTIVE cluster (live per-type control + quick-actions +
          renderRowAction) and the status dot.

          Per-element online gate: the passive `DeviceItemPreview` and the
          `StatusDot` render regardless of online/disabled, so an offline or
          disabled row still shows its battery/snapshot context and reachability
          dot. The interactive `DeviceItemActions` self-suppresses when disabled
          (returns null) and its inline controls self-gate on the live cap
          binding when offline — so only the interactive affordance is withheld,
          never the passive part.

          `controlPlacement="table"` keeps the control at content width so a wide
          control (climate stepper + mode select, cover triad + %) lays out in
          sequence with the trailing affordances instead of overflowing a fixed
          box; `justify-end` flushes the cluster right. */}
      <td className="px-2 py-1.5 align-middle text-right whitespace-nowrap">
        <span className="inline-flex items-center justify-end gap-1.5">
          <DeviceItemActions trpc={trpc} device={device} flags={flags} controlPlacement="table" />
          <DeviceItemPreview
            trpc={trpc}
            device={device}
            status={displayStatus}
            enabled={showSnapshot && isCamera}
            showStatusPills
          />
          <DeviceQuickDetailAction deviceId={device.id} />
          {renderRowAction && (
            <span onClick={(e) => e.stopPropagation()}>{renderRowAction(device)}</span>
          )}
          {onDelete && <DeviceDeleteAction device={device} onDelete={onDelete} />}
          <StatusDot status={displayStatus} />
        </span>
      </td>
    </tr>
  )
}
