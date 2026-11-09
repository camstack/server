/**
 * Heater controls for a `DeviceType.Heater` device (a dumb plug-in stove).
 *
 * A heater is a switch that heats while it is on, and the hub can switch it off
 * again after a chosen time (`timed-run`, D993):
 *   - HeaterInlineControl (device-list row): the on/off switch. The timed run
 *     beside it is the row control (`TimedRunRowControl`), shared by every
 *     device that binds the cap.
 *   - HeaterHeroCard (device-detail hero): the glowing heat backdrop (the same
 *     rising streaks a heating air conditioner draws) while it is on, the
 *     on/off switch and the timed
 *     run (number, unit, Run, countdown, Cancel).
 *
 * Every reading may be unknown (`null`) and is drawn as a dash, never as zero.
 */
import { Flame } from 'lucide-react'
import type { ReactNode } from 'react'
import { TIMED_RUN_LIMITS, type SwitchStatus, DeviceType } from '@camstack/types'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { useOptimisticSlice } from '../../hooks/use-optimistic-slice'
import { cn } from '../../lib/cn'
import { Switch } from '../../primitives/switch'
import { AirflowViz, KEYFRAMES } from './ac-panel'
import type { DeviceControlProps } from './control-registry'
import { TimedRunControl } from './timed-run-control'

const HEATER_LIMIT = TIMED_RUN_LIMITS[DeviceType.Heater]
const HEAT_ACCENT = 'var(--color-warning)'
const HEAT_PERIOD_SEC = 1.8

function useHeaterSwitch({ trpc, deviceId, optimistic }: DeviceControlProps) {
  const { cap, slice, available } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.switch,
    slice: (d) => d.state.switch,
  })
  const { display, applyOptimisticAction } = useOptimisticSlice<SwitchStatus>(slice, {
    enabled: optimistic ?? true,
  })
  return { cap, display, available, applyOptimisticAction }
}

function useHeater(props: DeviceControlProps) {
  const sw = useHeaterSwitch(props)
  const { trpc, deviceId } = props
  const running = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.runningState,
    slice: (d) => d.state.runningState,
  })
  const timer = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.timedRun,
    slice: (d) => d.state.timedRun,
  })
  return {
    ...sw,
    running: running.slice,
    timer,
  }
}

export function HeaterInlineControl(props: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, display, available, applyOptimisticAction } = useHeaterSwitch(props)
  if (cap === undefined || display === undefined) return null
  const on = display.on === true
  return (
    <div className="inline-flex items-center gap-2">
      {/* The row is clickable: a toggle must not also open the device. */}
      <span onClick={(e) => e.stopPropagation()}>
        <Switch
          checked={on}
          disabled={!available}
          aria-label={t('uiLibrary.heater.power', 'Heater')}
          onCheckedChange={(next) => {
            applyOptimisticAction({ on: next }, () => cap.setState({ on: next }))
          }}
        />
      </span>
    </div>
  )
}

export function HeaterHeroCard(props: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, display, available, applyOptimisticAction, running, timer } = useHeater(props)
  if (cap === undefined || display === undefined) return null
  const on = display.on === true
  const heating = running?.running ?? on
  return (
    <div className="relative flex flex-col items-stretch gap-3 overflow-hidden rounded-lg border border-border bg-surface p-4">
      <style>{KEYFRAMES}</style>
      <div className="relative flex h-32 items-center justify-center overflow-hidden rounded-lg border border-border-subtle bg-background-elevated">
        <div
          className={cn(
            'pointer-events-none absolute inset-0',
            heating ? 'opacity-60' : 'opacity-20',
          )}
        >
          <AirflowViz
            mode={heating ? 'heat' : 'off'}
            accent={HEAT_ACCENT}
            periodSec={HEAT_PERIOD_SEC}
            swaying={false}
            forceRising
          />
        </div>
        <div className="relative z-10 flex flex-col items-center gap-1">
          <Flame
            className={cn('h-8 w-8', heating ? 'text-warning' : 'text-foreground-subtle')}
            aria-hidden
          />
          <span className="text-sm font-medium text-foreground">
            {heating ? t('uiLibrary.heater.heating', 'Heating') : t('uiLibrary.heater.off', 'Off')}
          </span>
        </div>
      </div>
      <label className="flex items-center justify-between gap-3 text-sm text-foreground">
        {t('uiLibrary.heater.power', 'Heater')}
        <Switch
          checked={on}
          disabled={!available}
          onCheckedChange={(next) => {
            applyOptimisticAction({ on: next }, () => cap.setState({ on: next }))
          }}
        />
      </label>
      {timer.cap !== undefined && HEATER_LIMIT !== undefined && (
        <TimedRunControl trpc={props.trpc} deviceId={props.deviceId} limit={HEATER_LIMIT} />
      )}
    </div>
  )
}
