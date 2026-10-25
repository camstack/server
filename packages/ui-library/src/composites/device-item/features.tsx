/**
 * <DeviceItemFeatures> — children-count badge + optional feature-icon
 * row with hover popover.
 *
 * Battery / charging / sleeping pills moved to <DeviceItemPreview> in
 * Phase 2 (status pills belong with the preview/snapshot, not features).
 *
 * What this renders is now driven by `useDeviceFeatures` — the row
 * shows ONLY features whose corresponding cap is actually registered
 * on the device (or pure informational markers like `battery-operated`
 * / `doorbell-button` that have no cap to interrogate). The popover
 * labels each row `native` / `enhanced` / `marker` based on the live
 * `getBindings` entry's `kind` field. The previous conservative
 * advertised/no-slice/bound trio is gone — it under-reported wired
 * features (only 2 of 8 had a slice mapping) and gave operators
 * misleading "advertised" gray pills on Reolink cameras that fully
 * implement snapshot/reboot/ptz/intercom natively.
 */
import { useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import type { LucideIcon } from 'lucide-react'
import { useDeviceFeatures, type ResolvedFeature } from '../../hooks/use-device-features'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import {
  FEATURE_ICON_MAP,
  FEATURE_LABEL_MAP,
  type DeviceItemDevice,
  type VariantDefaults,
} from './helpers'

export interface DeviceItemFeaturesProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly device: DeviceItemDevice
  readonly flags: VariantDefaults
  readonly accessoryCount: number
  readonly adoptedCount: number
  /**
   * When true, render the feature-icon row + popover (table view's
   * "Features" column). Off in card view — only battery + +N badge
   * to save horizontal space.
   */
  readonly showFeatureRow?: boolean
}

const EMPTY_FEATURES: readonly string[] = []

export function DeviceItemFeatures({
  trpc,
  device,
  flags,
  accessoryCount,
  adoptedCount,
  showFeatureRow = false,
}: DeviceItemFeaturesProps): ReactNode {
  const total = accessoryCount + adoptedCount
  const showChildrenBadge = flags.showChildrenAccordion && total > 0
  const rawFeatures = device.features ?? EMPTY_FEATURES
  const showFeaturesGate = showFeatureRow && rawFeatures.length > 0
  const { resolved } = useDeviceFeatures(trpc, showFeaturesGate ? device.id : null, rawFeatures)
  const showFeatures = showFeaturesGate && resolved.length > 0
  if (!showChildrenBadge && !showFeatures) return null

  return (
    <div className="flex items-center gap-1.5 flex-nowrap whitespace-nowrap min-w-0">
      {showChildrenBadge && (
        <ChildrenCountBadge accessoryCount={accessoryCount} adoptedCount={adoptedCount} />
      )}
      {showFeatures && <FeatureRow resolved={resolved} />}
    </div>
  )
}

// ── ChildrenCountBadge (inline) ─────────────────────────────────────

interface ChildrenCountBadgeProps {
  readonly accessoryCount: number
  readonly adoptedCount: number
}

function ChildrenCountBadge({ accessoryCount, adoptedCount }: ChildrenCountBadgeProps): ReactNode {
  const t = useUiText()
  const total = accessoryCount + adoptedCount
  if (total === 0) return null
  const title =
    adoptedCount > 0 && accessoryCount > 0
      ? t(
          'uiLibrary.deviceItemFeatures.adoptedAndAccessories',
          {
            one: '{{adopted}} adopted · {{count}} accessory',
            other: '{{adopted}} adopted · {{count}} accessories',
          },
          { adopted: adoptedCount, count: accessoryCount },
        )
      : adoptedCount > 0
        ? t('uiLibrary.deviceItemFeatures.adopted', '{{count}} adopted', { count: adoptedCount })
        : t(
            'uiLibrary.deviceItemFeatures.accessories',
            { one: '{{count}} accessory', other: '{{count}} accessories' },
            { count: accessoryCount },
          )
  return (
    <span
      className="text-[9px] font-medium text-foreground-subtle bg-surface-elevated/60 rounded px-1.5 py-0.5 flex-shrink-0"
      title={title}
    >
      +{total}
    </span>
  )
}

// ── FeatureRow + FeatureRowPopover (inline) ─────────────────────────

interface FeatureRowProps {
  readonly resolved: readonly ResolvedFeature[]
}

interface PopoverPosition {
  readonly top: number
  readonly left: number
}

const POPOVER_WIDTH = 240
const POPOVER_MIN_HEIGHT = 200

function FeatureRow({ resolved }: FeatureRowProps): ReactNode {
  const triggerRef = useRef<HTMLSpanElement | null>(null)
  const [position, setPosition] = useState<PopoverPosition | null>(null)

  const open = (): void => {
    const el = triggerRef.current
    if (!el) return
    const rect = el.getBoundingClientRect()
    const spaceBelow = window.innerHeight - rect.bottom
    const placeBelow = spaceBelow >= POPOVER_MIN_HEIGHT
    const top = placeBelow ? rect.bottom + 4 : rect.top - POPOVER_MIN_HEIGHT - 4
    const left = Math.max(8, Math.min(rect.left, window.innerWidth - POPOVER_WIDTH - 8))
    setPosition({ top, left })
  }
  const close = (): void => setPosition(null)

  return (
    <span
      ref={triggerRef}
      className="relative inline-flex items-center gap-1 cursor-help"
      onMouseEnter={open}
      onMouseLeave={close}
    >
      {resolved.map((entry) => {
        const Icon = FEATURE_ICON_MAP[entry.feature]
        if (!Icon) return null
        return (
          <span
            key={entry.feature}
            className="inline-flex items-center justify-center h-4 w-4 rounded bg-surface-elevated/60 text-foreground-subtle"
            title={FEATURE_LABEL_MAP[entry.feature] ?? entry.feature}
          >
            <Icon className="h-2.5 w-2.5" />
          </span>
        )
      })}
      {position &&
        createPortal(<FeatureRowPopover resolved={resolved} position={position} />, document.body)}
    </span>
  )
}

interface FeatureRowPopoverProps {
  readonly resolved: readonly ResolvedFeature[]
  readonly position: PopoverPosition
}

function FeatureRowPopover({ resolved, position }: FeatureRowPopoverProps): ReactNode {
  const t = useUiText()
  return (
    <div
      style={{
        position: 'fixed',
        top: position.top,
        left: position.left,
        width: POPOVER_WIDTH,
        pointerEvents: 'none',
      }}
      className="z-[9999] rounded-md border border-border bg-surface shadow-lg shadow-black/30 p-2"
    >
      <h5 className="text-[9px] font-semibold uppercase tracking-wider text-foreground-subtle mb-1.5">
        {t('uiLibrary.deviceItemFeatures.features', 'Features')}
      </h5>
      <ul className="space-y-0.5">
        {resolved.map((entry) => (
          <FeaturePopoverRow key={entry.feature} entry={entry} />
        ))}
      </ul>
    </div>
  )
}

interface FeaturePopoverRowProps {
  readonly entry: ResolvedFeature
}

function FeaturePopoverRow({ entry }: FeaturePopoverRowProps): ReactNode {
  const Icon: LucideIcon | undefined = FEATURE_ICON_MAP[entry.feature]
  const label = FEATURE_LABEL_MAP[entry.feature] ?? entry.feature
  return (
    <li className="flex items-center justify-between gap-2 text-[10px]">
      <span className="flex items-center gap-1.5 text-foreground">
        {Icon && <Icon className="h-3 w-3 text-foreground-subtle" />}
        <span>{label}</span>
      </span>
      <FeatureKindPill kind={entry.kind} />
    </li>
  )
}

interface FeatureKindPillProps {
  readonly kind: ResolvedFeature['kind']
}

function FeatureKindPill({ kind }: FeatureKindPillProps): ReactNode {
  const t = useUiText()
  if (kind === 'marker') {
    // Pure markers (battery-operated, doorbell-button) are
    // informational only — no cap to bind. A subtle title-tooltip
    // explains while keeping the row visually quiet.
    return (
      <span
        className="text-[8.5px] px-1 rounded text-foreground-subtle"
        title={t(
          'uiLibrary.deviceItemFeatures.markerTitle',
          'Informational marker (no cap registered)',
        )}
      >
        {t('uiLibrary.deviceItemFeatures.marker', 'marker')}
      </span>
    )
  }
  return (
    <span
      className={cn(
        'text-[8.5px] px-1 rounded',
        kind === 'native' ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary',
      )}
    >
      {kind}
    </span>
  )
}
