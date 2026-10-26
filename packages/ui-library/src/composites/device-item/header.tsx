/**
 * <DeviceItemHeader> — the leftmost segment of the row: chevron
 * (when accordion enabled + has children), lead icon, name + meta-line
 * (`#id · stableId-tail`), parent badge.
 *
 * Two layout modes:
 *   - default (horizontal): `flex: 1; min-w-0` — eats every leftover
 *     horizontal pixel; name truncates with ellipsis when the row gets
 *     narrow. Used by table view + minimal in-panel lists.
 *   - `stacked=true`: name is the visual anchor of a vertical card. No
 *     truncation, two-line clamp so longer names wrap instead of
 *     collapsing into "Camera vera…". Typography is larger /
 *     heavier so the name dominates the secondary metadata that sits
 *     below it.
 *
 * …plus one orthogonal switch, `nameOverflow`. `'truncate'` (default) is the
 * behaviour above — a card is a width-bounded box with nowhere to scroll to.
 * `'scroll'` is passed by the TABLE row: below `md` the name loses its
 * ellipsis, sizes its own (uncapped) column, and the table's
 * `overflow-x-auto` wrapper carries the overflow. See
 * `NAME_COLUMN_TRUNCATE_BREAKPOINT` in device-list/columns.
 */
import { type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Network } from 'lucide-react'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { useDeviceState } from '../../hooks/use-device-proxy'
import { NAME_TEXT_CLASS } from '../device-list/columns'
import { DeviceName, useDeviceLabelById } from '../device-name'
import type { DeviceNameForm } from '../device-name'
import { RunningBadge } from '../running-badge'
import type {
  DeviceItemDevice,
  DeviceItemParent,
  DeviceItemVariant,
  VariantDefaults,
} from './helpers'
import { useIconGlyphsVersion } from '../icon-glyphs'
import { deviceLeadIcon, effectiveIconDevice, shortStableId } from './helpers'
import { useRoleDisplayDefaults } from './role-display-defaults-context'
import { useContainerChildren } from './container-children-context'

/**
 * Fixed-width slot for the expand chevron. Used by BOTH the interactive
 * chevron button AND the empty placeholder rendered when a row has no
 * children, so the lead icon + name start at the SAME x whether or not a
 * row owns a chevron. Two sizes mirror the two layouts (horizontal vs.
 * stacked card). Defined once so the button and placeholder can never
 * drift apart in width — that drift is exactly the misalignment bug.
 */
const CHEVRON_SLOT_CLASS: Readonly<Record<'horizontal' | 'stacked', string>> = {
  horizontal: 'h-3.5 w-3.5',
  stacked: 'h-4 w-4 mt-0.5',
}

/**
 * How the name behaves when it does not fit.
 *   - `truncate` — one line, ellipsis, the header shrinks with its container.
 *   - `scroll`   — one line, FULL text below `md`; the enclosing column is
 *                  uncapped there, so the name widens it and the table scrolls.
 */
export type DeviceNameOverflow = 'truncate' | 'scroll'

export interface DeviceItemHeaderProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly variant: DeviceItemVariant
  readonly flags: VariantDefaults
  readonly parent: DeviceItemParent | null
  readonly integrationIcon: ReactNode | null
  readonly hasChildren: boolean
  readonly expanded: boolean
  readonly onToggleExpand: () => void
  readonly onNavigateToParent: (id: number) => void
  /**
   * Vertical-card layout. When true, the name is rendered as the card's
   * primary anchor: bigger font, heavier weight, line-clamp-2 instead of
   * single-line truncation, and the inline integrationIcon flips above
   * the name as a small lead-line so the name's full width is name-only.
   */
  readonly stacked?: boolean
  /**
   * Overflow policy for the name (and the two secondary lines under it).
   * Defaults to `'truncate'` — the card layouts are width-bounded boxes and
   * have nowhere to scroll to. The table row passes `'scroll'`.
   */
  readonly nameOverflow?: DeviceNameOverflow
  /**
   * `nested` when this row is already drawn under its parent. Otherwise
   * `compact`: a child shown on its own names the container.
   */
  readonly nameForm?: DeviceNameForm
}

export function DeviceItemHeader({
  trpc,
  device,
  variant,
  flags,
  parent,
  integrationIcon,
  hasChildren,
  expanded,
  onToggleExpand,
  onNavigateToParent,
  stacked = false,
  nameOverflow = 'truncate',
  nameForm = 'compact',
}: DeviceItemHeaderProps): ReactNode {
  const t = useUiText()
  // A Container shows its primary child's icon; resolve that child set from the
  // list-level context rather than a threaded prop.
  const containerChildren = useContainerChildren(device.id)
  const roleDefaults = useRoleDisplayDefaults()
  // Re-render when the lazy glyph table arrives: the override's glyph may not be loaded yet.
  useIconGlyphsVersion()
  const Icon = deviceLeadIcon(effectiveIconDevice(device, containerChildren), roleDefaults)
  const runningSlice = useDeviceState(trpc, device.id, (s) => s.runningState)
  const runningBadge =
    runningSlice === undefined || runningSlice.running === null ? null : runningSlice.running
  const slotClass = stacked ? CHEVRON_SLOT_CLASS.stacked : CHEVRON_SLOT_CLASS.horizontal
  const iconClass = cn(
    'text-foreground-subtle flex-shrink-0',
    stacked ? 'h-4 w-4 mt-0.5' : variant === 'minimal' ? 'h-3 w-3' : 'h-3.5 w-3.5',
  )
  // The name text + the two secondary lines below it (`#id · stableId`,
  // "Under: <parent>"). They live in the same cell and are governed by the
  // same policy — a full name over an ellipsised parent badge reads as broken.
  const lineClass = nameOverflow === 'scroll' ? NAME_TEXT_CLASS : 'truncate'
  const nameParent =
    nameForm === 'nested' && parent !== null
      ? { id: parent.id, name: parent.name, type: parent.type ?? 'unknown', stableId: '' }
      : undefined
  const parentLabel = useDeviceLabelById(parent?.id ?? 0, 'compact', parent?.name)
  return (
    <div
      className={cn(
        stacked
          ? 'flex items-start gap-2 w-full min-w-0'
          : 'flex items-center gap-2 flex-1 min-w-0',
      )}
    >
      {flags.showChildrenAccordion && hasChildren ? (
        <button
          type="button"
          data-testid="chevron-slot"
          onClick={(e) => {
            e.stopPropagation()
            onToggleExpand()
          }}
          className={cn(
            'flex items-center justify-center text-foreground-subtle hover:text-foreground transition-colors flex-shrink-0',
            slotClass,
          )}
          aria-label={
            expanded
              ? t('uiLibrary.deviceItemHeader.collapseChildren', 'Collapse children')
              : t('uiLibrary.deviceItemHeader.expandChildren', 'Expand children')
          }
          aria-expanded={expanded}
        >
          {expanded ? <ChevronDown className="h-3 w-3" /> : <ChevronRight className="h-3 w-3" />}
        </button>
      ) : flags.showChildrenAccordion ? (
        // No children: KEEP the slot's empty space so the lead icon + name
        // line up with rows that DO own a chevron (same width via slotClass).
        <span data-testid="chevron-slot" className={cn('flex-shrink-0', slotClass)} />
      ) : null}

      <RunningBadge running={runningBadge}>
        <Icon className={iconClass} />
      </RunningBadge>

      <div className="flex-1 min-w-0">
        <div
          className={cn('min-w-0', stacked ? 'flex flex-col gap-1' : 'flex items-center gap-1.5')}
        >
          {flags.showIntegrationIcon && integrationIcon && (
            <span className="flex-shrink-0">{integrationIcon}</span>
          )}
          <DeviceName
            device={device}
            form={nameForm}
            {...(nameParent !== undefined ? { parent: nameParent } : {})}
            testId="device-name"
            className={cn(
              'font-semibold text-foreground',
              stacked
                ? 'text-[13px] leading-snug line-clamp-2 break-words'
                : cn(lineClass, variant === 'minimal' ? 'text-[10.5px]' : 'text-[11px]'),
            )}
          />
        </div>

        {(flags.showId || flags.showStableId) && (
          <div
            className={cn(
              'mt-0.5 flex items-center gap-1 text-[9px] text-foreground-subtle font-mono',
              lineClass,
            )}
            // i18n-ignore: `stableId` is the literal field name, shown with its value
            title={flags.showStableId ? `stableId: ${device.stableId}` : undefined}
          >
            {flags.showId && (
              <span className="flex-shrink-0 tabular-nums">#{String(device.id)}</span>
            )}
            {flags.showId && flags.showStableId && (
              <span className="flex-shrink-0 opacity-50">·</span>
            )}
            {flags.showStableId && (
              <span className={lineClass}>{shortStableId(device.stableId)}</span>
            )}
          </div>
        )}

        {flags.showParentBadge && parent && (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation()
              onNavigateToParent(parent.id)
            }}
            className={cn(
              'mt-0.5 inline-flex items-center gap-1 text-[9px] text-foreground-subtle hover:text-primary transition-colors',
              // A `max-w-full` here caps the badge at the cell width, so a full
              // parent name would overflow it invisibly instead of widening the
              // column. Desktop keeps the cap (it pairs with the ellipsis).
              nameOverflow === 'scroll' ? 'md:max-w-full' : 'max-w-full',
            )}
            title={t('uiLibrary.deviceItemHeader.openParent', 'Open parent: {{name}} (#{{id}})', {
              name: parentLabel,
              id: parent.id,
            })}
          >
            <Network className="h-2.5 w-2.5 shrink-0" />
            <span className={lineClass}>
              {t('uiLibrary.deviceItemHeader.under', 'Under: {{name}}', { name: parentLabel })}
            </span>
          </button>
        )}
      </div>
    </div>
  )
}
