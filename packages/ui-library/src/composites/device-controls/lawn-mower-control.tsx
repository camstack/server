/**
 * Robotic lawn-mower controls for a `DeviceType.LawnMower` device.
 *
 * LawnMowerInlineControl (device-list row): compact Mow / Pause / Dock
 * buttons with activity-aware highlight + a battery % badge, gated on
 * `available`. The device-detail hero is the device card
 * (`composites/device-card`, `ConnectedMowerCard`).
 */
import type { ReactNode } from 'react'
import { Play, Pause, Home, BatteryMedium } from 'lucide-react'
import type { LawnMowerControlStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useUiText } from '../../contexts/ui-text'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `lawn-mower-control` cap exposes (deviceId injected by the proxy). */
interface LawnMowerCap {
  readonly startMowing: (input: Record<string, never>) => Promise<void>
  readonly pause: (input: Record<string, never>) => Promise<void>
  readonly dock: (input: Record<string, never>) => Promise<void>
}

function useLawnMower(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<LawnMowerCap, LawnMowerControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.lawnMowerControl as LawnMowerCap | undefined,
    slice: (d) => d.state.lawnMowerControl,
  })
}

/** Battery % badge. */
function BatteryBadge({ level }: { readonly level: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums text-xs text-foreground-subtle">
      <BatteryMedium className="h-3.5 w-3.5" />
      {level}%
    </span>
  )
}

// ── Inline button ─────────────────────────────────────────────────────────────

interface LawnMowerIconButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function LawnMowerIconButton({
  label,
  busy,
  active,
  onClick,
  children,
}: LawnMowerIconButtonProps): ReactNode {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(e) => {
        e.stopPropagation()
        onClick()
      }}
      className={cn(
        'inline-flex h-5 w-5 items-center justify-center rounded text-foreground-subtle hover:text-foreground hover:bg-surface-hover transition-colors',
        active && 'bg-primary text-primary-foreground',
        busy && 'opacity-40 cursor-not-allowed',
      )}
    >
      {children}
    </button>
  )
}

/**
 * LawnMowerInlineControl — compact, activity-aware mower controls for a
 * device-list row. Mow / Pause / Dock + battery badge.
 */
export function LawnMowerInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useLawnMower(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const activity = slice?.activity

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.mow', 'Mow')}
        busy={busy}
        active={activity === 'mowing'}
        onClick={() => press(cap.startMowing)}
      >
        <Play className="h-3 w-3" />
      </LawnMowerIconButton>
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.pause', 'Pause')}
        busy={busy}
        active={activity === 'paused'}
        onClick={() => press(cap.pause)}
      >
        <Pause className="h-3 w-3" />
      </LawnMowerIconButton>
      <LawnMowerIconButton
        label={t('uiLibrary.lawnMowerControl.dock', 'Dock')}
        busy={busy}
        active={activity === 'docked'}
        onClick={() => press(cap.dock)}
      >
        <Home className="h-3.5 w-3.5" />
      </LawnMowerIconButton>
      {slice?.batteryLevel != null && (
        <span className="ml-1">
          <BatteryBadge level={slice.batteryLevel} />
        </span>
      )}
    </div>
  )
}
