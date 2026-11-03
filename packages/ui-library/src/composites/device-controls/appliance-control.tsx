/**
 * Appliance card for a `DeviceType.Washer` / `DeviceType.Dryer` device.
 *
 * These appliances have no program surface: what is worth showing is whether
 * the cycle is running (the `running-state` cap) and for how long. The draw
 * is NOT drawn here: the `power-meter` cap's hero widget shows it under every
 * hero card (D1004).
 *   - ApplianceInlineControl (device-list row): the running badge round the
 *     drum icon.
 *   - ApplianceHeroCard (device-detail hero): the drum (turning only while a
 *     cycle runs), the state, the phase and the dwell.
 *
 * UNKNOWN IS NOT OFF (D393). `running: null` is drawn as "Unknown" and the
 * drum stays still and unbadged.
 */
import { WashingMachine } from 'lucide-react'
import type { ReactNode } from 'react'
import type { RunningStateStatus } from '@camstack/types'
import { useUiText, type UiTextFn } from '../../contexts/ui-text'
import { useDeviceState } from '../../hooks/use-device-proxy'
import { cn } from '../../lib/cn'
import { RunningBadge } from '../running-badge'
import { runningStatusParts } from '../running-status'
import type { DeviceControlProps } from './control-registry'

// Scoped keyframes — transform only (compositor-cheap).
const KEYFRAMES = `
@keyframes apl-tumble { to { transform: rotate(360deg) } }
.apl-drum-run { animation: apl-tumble 3s linear infinite; }
@media (prefers-reduced-motion: reduce) {
  .apl-drum-run { animation: none !important; }
}
`

interface StateLabel {
  readonly label: string
  readonly tone: string
}

/** The state to a person: running / idle, or why there is none (unknown). */
export function applianceStateLabel(running: boolean | null, t: UiTextFn): StateLabel {
  if (running === true) {
    return { label: t('uiLibrary.appliance.running', 'Running'), tone: 'text-primary' }
  }
  if (running === false) {
    return { label: t('uiLibrary.appliance.idle', 'Idle'), tone: 'text-foreground' }
  }
  return { label: t('uiLibrary.appliance.unknown', 'Unknown'), tone: 'text-foreground-subtle' }
}

function dwellText(running: boolean | null, since: number | null, now: number, t: UiTextFn) {
  if (running !== true) return null
  const { duration } = runningStatusParts(running, since, null, now)
  if (duration === undefined) return null
  return 'minutes' in duration
    ? t('uiLibrary.appliance.forMinutes', 'for {{count}} min', { count: duration.minutes })
    : t('uiLibrary.appliance.forHours', 'for {{count}} h', { count: duration.hours })
}

function useApplianceState(props: DeviceControlProps): {
  readonly running: RunningStateStatus | undefined
} {
  const running = useDeviceState<RunningStateStatus>(
    props.trpc,
    props.deviceId,
    (s) => s.runningState,
  )
  return { running }
}

/** The drum: a ring with a few items in it, turning only while a cycle runs. */
function Drum({ running }: { readonly running: boolean | null }): ReactNode {
  return (
    <div
      aria-hidden="true"
      data-testid="appliance-drum"
      data-running={running === true ? 'running' : running === false ? 'idle' : 'unknown'}
      className="relative flex h-28 w-28 shrink-0 items-center justify-center rounded-full border-2 border-border bg-surface-hover"
    >
      <div
        className={cn(
          'relative h-20 w-20 rounded-full border-2',
          running === true ? 'apl-drum-run border-primary' : 'border-border',
        )}
        data-testid="appliance-drum-ring"
      >
        <span className="absolute left-2 top-4 h-3 w-3 rounded-full bg-primary/40" />
        <span className="absolute bottom-3 right-3 h-4 w-4 rounded-full bg-info/40" />
        <span className="absolute bottom-4 left-4 h-2.5 w-2.5 rounded-full bg-foreground-subtle/40" />
      </div>
    </div>
  )
}

export function ApplianceHeroCard(props: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { running } = useApplianceState(props)
  const state = running?.running ?? null
  const meta = applianceStateLabel(state, t)
  const phase = running?.phase?.trim() ?? ''
  const dwell = running === undefined ? null : dwellText(state, running.since, Date.now(), t)

  return (
    <div className="flex items-center gap-4 rounded-lg border border-border bg-surface p-4">
      <style>{KEYFRAMES}</style>
      <Drum running={state} />
      <div className="flex min-w-0 flex-1 flex-col gap-2">
        <div className="flex flex-wrap items-baseline gap-x-2">
          <span data-testid="appliance-state" className={cn('text-3xl font-semibold', meta.tone)}>
            {meta.label}
          </span>
          {dwell !== null && (
            <span className="text-sm tabular-nums text-foreground-subtle">{dwell}</span>
          )}
        </div>
        {phase !== '' && state !== null && (
          <span className="text-sm text-foreground-subtle">{phase}</span>
        )}
      </div>
    </div>
  )
}

export function ApplianceInlineControl(props: DeviceControlProps): ReactNode {
  const { running } = useApplianceState(props)
  const state = running?.running ?? null
  return (
    <div className="inline-flex items-center gap-1.5 max-w-full">
      <RunningBadge running={state}>
        <WashingMachine className="h-4 w-4 text-foreground-muted" aria-hidden />
      </RunningBadge>
    </div>
  )
}
