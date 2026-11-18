/**
 * The device-list row of a `DeviceType.Workload` device: the hero's state dot,
 * its state word and, when known, how long it has been in it. An unknown state
 * reads "State unknown", never "Stopped" (D315). The device-detail hero is the
 * workload card (`WorkloadCardHero` in panel-controls.tsx).
 */
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { StateDot } from '../device-card/parts/StateDot'
import { ValueChip } from '../device-card/parts/ValueChip'
import {
  WORKLOAD_STATE_TONE,
  workloadStateLabel,
  workloadUptime,
} from '../device-card/scenes/workload/model'
import type { DeviceControlProps } from './control-registry'

/** Natural width; a crash is the danger tone, a pause the warning one. */
export function WorkloadInlineControl({ trpc, deviceId }: DeviceControlProps): ReactNode {
  const t = useUiText()
  const { cap, slice } = useDeviceCapability({
    trpc,
    deviceId,
    cap: (d) => d.workload,
    slice: (d) => d.state.workload,
  })
  if (cap === undefined || slice === undefined) return null
  const state = slice.state
  const uptime = workloadUptime(slice.since, Date.now(), t)
  return (
    <ValueChip
      data-testid="workload-inline"
      tone={state === 'crashed' ? 'danger' : state === 'paused' ? 'warning' : 'default'}
    >
      <span className="inline-flex items-center gap-1.5">
        <StateDot
          testId="workload-inline-dot"
          state={state ?? 'unknown'}
          tone={state === null ? null : WORKLOAD_STATE_TONE[state]}
        />
        {/* The row has no role: the neutral wording ("Running", "Stopped"). */}
        {workloadStateLabel(state, 'app', t)}
        {uptime === null ? null : <span className="tabular-nums">· {uptime}</span>}
      </span>
    </ValueChip>
  )
}
