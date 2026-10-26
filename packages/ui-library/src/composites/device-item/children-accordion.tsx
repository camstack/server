/**
 * <ChildrenAccordion> — accessory + adopted children rows shown when
 * the parent's chevron is expanded. The accessory/adopted split is
 * driven by `isAccessoryChild` (role-or-type-based, see helpers.ts).
 *
 * Each ChildRow surfaces the same quick-action toggles the parent's
 * actions slot exposes: switch toggle (when the device has a `switch`
 * cap) and on-motion toggle (when the device advertises `motion-trigger`).
 * Both gate via `useDeviceCapability` so they self-hide when the cap
 * isn't bound.
 */

import { Activity } from 'lucide-react'
import { type CSSProperties, type MouseEvent, type ReactNode, useState } from 'react'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import type { UseDeviceProxyTrpc } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import { useUiText } from '../../contexts/ui-text'
import type { DeviceItemDevice } from './helpers'
import { useIconGlyphsVersion } from '../icon-glyphs'
import { RunningBadge } from '../running-badge'
import { useDeviceState } from '../../hooks/use-device-proxy'
import { deviceLeadIcon, hasMotionTriggerFeature, maySupportSwitch } from './helpers'
import { DeviceName } from '../device-name'
import { useRoleDisplayDefaults } from './role-display-defaults-context'

interface ChildrenAccordionProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly accessoryChildren: readonly DeviceItemDevice[]
  readonly adoptedChildren: readonly DeviceItemDevice[]
  readonly onNavigate: (id: number) => void
  /** Parent row's name — used to strip the redundant baked-in prefix from each
   *  child's DISPLAY name (the underlying `child.name` is untouched). */
  readonly parentName: string
}

export function ChildrenAccordion({
  trpc,
  accessoryChildren,
  adoptedChildren,
  onNavigate,
  parentName,
}: ChildrenAccordionProps): ReactNode {
  const t = useUiText()
  return (
    <div className="border-t border-border-subtle/50">
      {adoptedChildren.length > 0 && (
        <ChildrenSection
          trpc={trpc}
          label={t('uiLibrary.childrenAccordion.adoptedDevices', 'Adopted devices')}
          rows={adoptedChildren}
          onNavigate={onNavigate}
          parentName={parentName}
        />
      )}
      {accessoryChildren.length > 0 && (
        <ChildrenSection
          trpc={trpc}
          label={t('uiLibrary.childrenAccordion.accessories', 'Accessories')}
          rows={accessoryChildren}
          onNavigate={onNavigate}
          parentName={parentName}
        />
      )}
    </div>
  )
}

interface ChildrenSectionProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly label: string
  readonly rows: readonly DeviceItemDevice[]
  readonly onNavigate: (id: number) => void
  readonly parentName: string
}

function ChildrenSection({
  trpc,
  label,
  rows,
  onNavigate,
  parentName,
}: ChildrenSectionProps): ReactNode {
  return (
    <div>
      <div className="px-3 pt-1.5 pb-1 text-[9px] font-semibold uppercase tracking-wide text-foreground-subtle">
        {label}
      </div>
      <ul>
        {rows.map((child) => (
          <ChildRow
            key={child.id}
            trpc={trpc}
            child={child}
            onNavigate={onNavigate}
            parentName={parentName}
          />
        ))}
      </ul>
    </div>
  )
}

interface ChildRowProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly child: DeviceItemDevice
  readonly onNavigate: (id: number) => void
  readonly parentName: string
}

function ChildRow({ trpc, child, onNavigate, parentName }: ChildRowProps): ReactNode {
  const t = useUiText()
  const enabled = !child.disabled
  const showSwitch = enabled && maySupportSwitch(child)
  const showMotionTrigger = enabled && hasMotionTriggerFeature(child)
  const roleDefaults = useRoleDisplayDefaults()
  // Re-render when the lazy glyph table arrives: the override's glyph may not be loaded yet.
  useIconGlyphsVersion()
  const ChildIcon = deviceLeadIcon(child, roleDefaults)
  const runningSlice = useDeviceState(trpc, child.id, (s) => s.runningState)
  const runningBadge =
    runningSlice === undefined || runningSlice.running === null ? null : runningSlice.running
  return (
    <li>
      <div
        onClick={(e) => {
          e.stopPropagation()
          onNavigate(child.id)
        }}
        className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-surface-hover transition-colors cursor-pointer"
      >
        <RunningBadge running={runningBadge}>
          <ChildIcon className="h-3 w-3 text-foreground-subtle flex-shrink-0" />
        </RunningBadge>
        <DeviceName
          device={child}
          form="nested"
          parent={{
            id: child.parentDeviceId ?? 0,
            name: parentName,
            type: 'unknown',
            stableId: '',
          }}
          className="text-[10.5px] text-foreground flex-1 truncate"
        />
        {showMotionTrigger && (
          <ChildMotionTriggerToggle trpc={trpc} deviceId={child.id} features={child.features} />
        )}
        {showSwitch && <ChildSwitchToggle trpc={trpc} deviceId={child.id} />}
        <span
          className={cn(
            'h-1.5 w-1.5 rounded-full flex-shrink-0',
            child.online ? 'bg-success' : 'bg-foreground-subtle/40',
          )}
          title={
            child.online
              ? t('uiLibrary.childrenAccordion.online', 'Online')
              : t('uiLibrary.childrenAccordion.offline', 'Offline')
          }
        />
      </div>
    </li>
  )
}

// ── Toggles (file-internal — actions.tsx has the public version) ────

interface ChildSwitchToggleProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
}

function ChildSwitchToggle({ trpc, deviceId }: ChildSwitchToggleProps): ReactNode {
  const t = useUiText()
  const { dev, cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.switch,
    slice: (d) => d.state.switch,
  })
  const [pending, setPending] = useState(false)

  if (dev !== null && !cap) return null

  const on = slice?.on === true
  const knobStyle: CSSProperties = {
    transform: on ? 'translateX(14px)' : 'translateX(2px)',
  }

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (pending || !available || !cap) return
    setPending(true)
    try {
      await cap.setState({ on: !on })
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        void handleClick(e)
      }}
      disabled={pending || !available}
      className={cn(
        'relative inline-flex h-4 w-7 items-center rounded-full border transition-colors flex-shrink-0',
        on ? 'bg-success/30 border-success/50' : 'bg-surface-hover border-border',
        pending && 'opacity-60',
        !available && 'opacity-40 cursor-not-allowed',
      )}
      title={
        !available
          ? t('uiLibrary.childrenAccordion.awaitingState', 'Awaiting state…')
          : on
            ? t('uiLibrary.childrenAccordion.turnOff', 'Turn off')
            : t('uiLibrary.childrenAccordion.turnOn', 'Turn on')
      }
      aria-pressed={on}
    >
      <span
        className={cn(
          'absolute h-3 w-3 rounded-full transition-all',
          on ? 'bg-success' : 'bg-foreground-subtle',
        )}
        style={knobStyle}
      />
    </button>
  )
}

interface ChildMotionTriggerToggleProps {
  readonly trpc: UseDeviceProxyTrpc
  readonly deviceId: number
  readonly features: readonly string[] | undefined
}

function ChildMotionTriggerToggle({
  trpc,
  deviceId,
  features,
}: ChildMotionTriggerToggleProps): ReactNode {
  const t = useUiText()
  const { dev, cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.motionTrigger,
    slice: (d) => d.state.motionTrigger,
    requireFeature: 'motion-trigger',
    deviceFeatures: features,
  })
  const [pending, setPending] = useState(false)

  if (dev !== null && !cap) return null

  const on = slice?.enabled === true

  const handleClick = async (e: MouseEvent): Promise<void> => {
    e.stopPropagation()
    if (pending || !available || !cap) return
    setPending(true)
    try {
      await cap.setMotionTrigger({ enabled: !on })
    } finally {
      setPending(false)
    }
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        void handleClick(e)
      }}
      disabled={pending || !available}
      className={cn(
        'inline-flex h-4 w-4 items-center justify-center rounded transition-colors flex-shrink-0',
        on
          ? 'text-primary bg-primary/10'
          : 'text-foreground-subtle hover:text-foreground hover:bg-surface-hover',
        (pending || !available) && 'opacity-50',
      )}
      title={
        !available
          ? t('uiLibrary.childrenAccordion.awaitingState', 'Awaiting state…')
          : on
            ? t(
                'uiLibrary.childrenAccordion.motionTriggerOn',
                'Motion-trigger: on (click to disable)',
              )
            : t(
                'uiLibrary.childrenAccordion.motionTriggerOff',
                'Motion-trigger: off (click to enable)',
              )
      }
      aria-pressed={on}
    >
      <Activity className="h-2.5 w-2.5" />
    </button>
  )
}
