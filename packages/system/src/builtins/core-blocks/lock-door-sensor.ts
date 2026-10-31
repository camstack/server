/**
 * Which door sensor a lock's Customize links (D984): the source the stored
 * `lock-control.state` override reads as its `x` binding. Read from the STORED
 * composition, never kept as a second copy (D676); asked only when a refusal
 * has to name the sensor.
 */
import { type CompositionSourceRef, type CoreBlock, coreBlockComposition } from '@camstack/types'

export interface LockDoorLink {
  /** The lock the customization is on. */
  readonly lock: CompositionSourceRef
  /** The door sensor it reads. */
  readonly sensor: CompositionSourceRef
}

export function lockDoorLinkOf(block: Pick<CoreBlock, 'source'>): LockDoorLink | null {
  const composition = coreBlockComposition(block)
  if (composition === null || composition.target.kind !== 'existing') return null
  const feature = composition.features.find((f) => f.cap === 'lock-control')
  if (feature === undefined || feature.kind !== 'fields') return null
  const state = feature.fields['state']
  if (state === undefined || state.kind !== 'expression') return null
  const x = state.bindings['x']
  if (x === undefined || x.kind !== 'from') return null
  return { lock: composition.target.device, sensor: x.source }
}

export interface DeviceNames {
  /** The device's id and name for a source ref, or null when it cannot be found. */
  readonly find: (ref: CompositionSourceRef) => Promise<{ id: number; name: string } | null>
}

/** The linked sensor's name for the lock `deviceId`, or null when none is linked or it cannot be read. */
export async function doorSensorOf(
  blocks: readonly Pick<CoreBlock, 'source'>[],
  deviceId: number,
  names: DeviceNames,
): Promise<string | null> {
  for (const block of blocks) {
    const link = lockDoorLinkOf(block)
    if (link === null) continue
    const lock = await names.find(link.lock)
    if (lock === null || lock.id !== deviceId) continue
    const sensor = await names.find(link.sensor)
    return sensor?.name ?? `${link.sensor.stableId}`
  }
  return null
}
