/**
 * Which door sensor a lock's Customize links (D984): the source the stored
 * `lock-control.state` override reads as its `x` binding. Read from the STORED
 * composition, never kept as a second copy (D676). Shared by the hub (which
 * names the sensor in a refusal) and the admin UI (which shows its state).
 */
import type { Composition } from './composition.js'
import type { CompositionSourceRef } from './source-ref.js'

export interface LockDoorLink {
  /** The lock the customization is on. */
  readonly lock: CompositionSourceRef
  /** The door sensor it reads. */
  readonly sensor: CompositionSourceRef
}

export function lockDoorLinkOfComposition(composition: Composition | null): LockDoorLink | null {
  if (composition === null || composition.target.kind !== 'existing') return null
  const feature = composition.features.find((f) => f.cap === 'lock-control')
  if (feature === undefined || feature.kind !== 'fields') return null
  const state = feature.fields['state']
  if (state === undefined || state.kind !== 'expression') return null
  const x = state.bindings['x']
  if (x === undefined || x.kind !== 'from') return null
  return { lock: composition.target.device, sensor: x.source }
}
