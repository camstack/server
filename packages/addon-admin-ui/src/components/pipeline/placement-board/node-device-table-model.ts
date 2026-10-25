/**
 * The rows of one node's accelerator table on Pipeline → Cluster → Load
 * balancing: each device the node reports (or once had — D919) joined with the
 * share placement holds for it (`getEffectiveShares`) and the sessions it runs
 * now (`getPlacementStats`). Pure, so the state vocabulary is tested once.
 */
import type { EffectiveNodeShare, NodeInferenceDevice, PlacementNodeStats } from '@camstack/types'

/**
 * What a row says about its device, first-reason-wins:
 *  - `absent` — the node's probe answered without it: only its stored
 *    settings remain (unplugged, moved to another node); forgettable;
 *  - `unknown` — the probe did not answer, nothing is claimed;
 *  - `active` — a camera-root candidate;
 *  - `disabled` — switched off;
 *  - `unavailable` — on the node but the probe reports it unusable;
 *  - `backoff` — reported usable, but its pool is dead or backing off;
 *  - `root-incapable` — cannot run the camera root detector;
 *  - `standby` — the CPU fallback while an accelerator serves (D215).
 */
export type DeviceRowState =
  | 'absent'
  | 'unknown'
  | 'active'
  | 'disabled'
  | 'unavailable'
  | 'backoff'
  | 'root-incapable'
  | 'standby'

/** The share the source assigns and the share actually used (%). */
export interface DeviceShare {
  readonly configuredPct: number
  readonly effectivePct: number
}

export interface DeviceTableRow {
  readonly device: NodeInferenceDevice
  readonly state: DeviceRowState
  /** The share the source assigns / the share actually used (%), when the device has one. */
  readonly share: DeviceShare | null
  /** Sessions on the device now; null when placement has not reported this node. */
  readonly sessionsNow: number | null
  /** Known to be at its concurrent-session cap. */
  readonly atCap: boolean
}

export function deviceRowState(device: NodeInferenceDevice): DeviceRowState {
  if (device.presence === 'absent') return 'absent'
  if (device.presence === 'unknown') return 'unknown'
  switch (device.exclusion) {
    case null:
      return 'active'
    case 'disabled':
      return 'disabled'
    case 'unavailable':
      return device.available ? 'backoff' : 'unavailable'
    case 'cannot-host-camera-root':
      return 'root-incapable'
    case 'accelerator-preferred':
      return 'standby'
  }
}

export function buildDeviceTableRows(
  devices: readonly NodeInferenceDevice[],
  share: EffectiveNodeShare | undefined,
  placed: PlacementNodeStats | undefined,
): readonly DeviceTableRow[] {
  const shareByKey = new Map((share?.devices ?? []).map((d) => [d.deviceKey, d]))
  const sessionsByKey = new Map((placed?.devices ?? []).map((d) => [d.deviceKey, d.sessionsNow]))
  return devices.map((device) => {
    const s = shareByKey.get(device.key)
    // Placement lists only devices that ran a session: a reported node that
    // does not name a device runs nothing on it. An unreported node is unknown.
    const sessionsNow = placed === undefined ? null : (sessionsByKey.get(device.key) ?? 0)
    return {
      device,
      state: deviceRowState(device),
      share:
        s === undefined ? null : { configuredPct: s.configuredPct, effectivePct: s.effectivePct },
      sessionsNow,
      atCap:
        sessionsNow !== null && device.maxSessions !== null && sessionsNow >= device.maxSessions,
    }
  })
}

/** The Badge variant each state reads as. */
export const DEVICE_STATE_VARIANT: Readonly<
  Record<DeviceRowState, 'success' | 'warning' | 'danger' | 'neutral' | 'info'>
> = {
  active: 'success',
  disabled: 'neutral',
  absent: 'danger',
  unknown: 'neutral',
  unavailable: 'warning',
  backoff: 'warning',
  'root-incapable': 'info',
  standby: 'neutral',
}
