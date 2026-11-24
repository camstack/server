import type { DiscoveredChildDevice } from '@camstack/types'

/** One live port child of an adopted infra device: its CamStack id and the port it follows. */
export interface LivePortChild {
  readonly id: number
  readonly portIdx: number
}

/** The port index a port candidate (`infra:<id>:port-<n>`) names, or null for another child. */
function portIdxOfCandidate(childNativeId: string): number | null {
  const match = /:port-(\d+)$/.exec(childNativeId)
  return match?.[1] === undefined ? null : Number(match[1])
}

/** The port a persisted child config describes, or null when the child is not a port. */
export function livePortChildOf(
  id: number,
  config: Record<string, unknown> | null,
): LivePortChild | null {
  if (config === null || config['kind'] !== 'port') return null
  const portIdx = config['portIdx']
  return typeof portIdx === 'number' ? { id, portIdx } : null
}

/**
 * Fill `alreadyAdopted` + `adoptedDeviceId` on the port children of each adopted infra
 * candidate from the LIVE child devices. A port counts as adopted only while its device exists,
 * so a removed port stays not adopted. A candidate that is not adopted keeps its children as
 * they are. Pure.
 */
export function markPortChildren(
  candidates: readonly DiscoveredChildDevice[],
  liveChildren: ReadonlyMap<number, readonly LivePortChild[]>,
): readonly DiscoveredChildDevice[] {
  return candidates.map((candidate) => {
    const { adoptedDeviceId, children } = candidate
    if (adoptedDeviceId === null || adoptedDeviceId === undefined || children === undefined) {
      return candidate
    }
    const live = liveChildren.get(adoptedDeviceId) ?? []
    return {
      ...candidate,
      children: children.map((child) => {
        const portIdx = portIdxOfCandidate(child.childNativeId)
        const device = live.find((l) => l.portIdx === portIdx)
        return device === undefined
          ? { ...child, alreadyAdopted: false, adoptedDeviceId: null }
          : { ...child, alreadyAdopted: true, adoptedDeviceId: device.id }
      }),
    }
  })
}
