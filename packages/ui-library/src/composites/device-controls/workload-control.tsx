/**
 * The device-list row of a `DeviceType.Workload` device: its state as one
 * chip. An unknown state reads "State unknown", never "Stopped" (D315). The
 * device-detail hero is the workload card (`WorkloadCardHero` in
 * panel-controls.tsx).
 */
import type { ReactNode } from 'react'
import { useUiText } from '../../contexts/ui-text'
import { useDeviceCapability } from '../../hooks/use-device-capability'
import { ValueChip } from '../device-card/parts/ValueChip'
import { workloadStateLabel } from '../device-card/scenes/workload/model'
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
  return (
    <ValueChip
      data-testid="workload-inline"
      tone={state === 'crashed' ? 'danger' : state === 'paused' ? 'warning' : 'default'}
    >
      {/* The row has no role: the neutral wording ("Running", "Stopped"). */}
      {workloadStateLabel(state, 'app', t)}
    </ValueChip>
  )
}
