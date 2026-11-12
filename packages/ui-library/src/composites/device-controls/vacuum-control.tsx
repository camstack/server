/**
 * Robot-vacuum controls for a `DeviceType.Vacuum` device.
 *
 * VacuumInlineControl (device-list row): compact Start / Pause /
 * Return-to-base buttons with state-aware highlight + a battery % badge,
 * gated on `available`. The device-detail hero is the device card
 * (`composites/device-card`, `ConnectedVacuumCard`).
 */
import { useUiText } from '../../contexts/ui-text'
import type { ReactNode } from 'react'
import { Play, Pause, Home, BatteryMedium } from 'lucide-react'
import type { VacuumControlStatus } from '@camstack/types'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { cn } from '../../lib/cn'
import type { DeviceControlProps } from './control-registry'

/** The mutations the `vacuum-control` cap exposes (deviceId injected by the proxy). */
interface VacuumCap {
  readonly start: (input: Record<string, never>) => Promise<void>
  readonly pause: (input: Record<string, never>) => Promise<void>
  readonly stop: (input: Record<string, never>) => Promise<void>
  readonly returnToBase: (input: Record<string, never>) => Promise<void>
  readonly locate: (input: Record<string, never>) => Promise<void>
  readonly setFanSpeed: (input: { speed: string }) => Promise<void>
}

function useVacuum(trpc: DeviceControlProps['trpc'], deviceId: number) {
  return useDeviceCapability<VacuumCap, VacuumControlStatus>({
    trpc,
    deviceId,
    cap: (d) => d.vacuumControl as VacuumCap | undefined,
    slice: (d) => d.state.vacuumControl,
  })
}

// ── Inline button ─────────────────────────────────────────────────────────────

interface VacuumIconButtonProps {
  readonly label: string
  readonly busy: boolean
  readonly active: boolean
  readonly onClick: () => void
  readonly children: ReactNode
}

function VacuumIconButton({
  label,
  busy,
  active,
  onClick,
  children,
}: VacuumIconButtonProps): ReactNode {
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

/** Battery % badge. */
function BatteryBadge({ level }: { readonly level: number }): ReactNode {
  return (
    <span className="inline-flex items-center gap-0.5 tabular-nums text-xs text-foreground-subtle">
      <BatteryMedium className="h-3.5 w-3.5" />
      {level}%
    </span>
  )
}

/**
 * VacuumInlineControl — compact, state-aware vacuum controls for a
 * device-list row. Start / Pause / Return-to-base + battery badge.
 */
export function VacuumInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice, available } = useVacuum(trpc, deviceId)
  if (cap === undefined) return null

  const busy = !available
  const state = slice?.state
  const cleaning = state === 'cleaning'

  const press = (fn?: (input: Record<string, never>) => Promise<void>): void => {
    if (busy || fn === undefined) return
    void fn({})
  }

  return (
    <div className="inline-flex items-center gap-1">
      <VacuumIconButton
        label={t('uiLibrary.vacuum.start', 'Start')}
        busy={busy}
        active={cleaning}
        onClick={() => press(cap.start)}
      >
        <Play className="h-3 w-3" />
      </VacuumIconButton>
      <VacuumIconButton
        label={t('uiLibrary.vacuum.pause', 'Pause')}
        busy={busy}
        active={state === 'paused'}
        onClick={() => press(cap.pause)}
      >
        <Pause className="h-3 w-3" />
      </VacuumIconButton>
      <VacuumIconButton
        label={t('uiLibrary.vacuum.returnToBase', 'Return to base')}
        busy={busy}
        active={state === 'returning' || state === 'docked'}
        onClick={() => press(cap.returnToBase)}
      >
        <Home className="h-3.5 w-3.5" />
      </VacuumIconButton>
      {slice?.batteryLevel != null && (
        <span className="ml-1">
          <BatteryBadge level={slice.batteryLevel} />
        </span>
      )}
    </div>
  )
}
