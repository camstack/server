/**
 * Export membership — which device reaches which Home Assistant instance.
 *
 * A composite key (broker × device), because the operator chose per-broker
 * membership over one global list: two HA instances must be able to see
 * different sets of cameras.
 *
 * **The `ha-export-links` records are the AUTHORITY, and the only one** (`link-records.ts`):
 * this module holds the pure operations over the membership they carry. The per-device
 * Export panel renders N switches over it — one per broker — and each of
 * them reads and writes exactly that store. There is deliberately no
 * second per-device HA opt-in anywhere: two switches that can disagree
 * are worse than one (D62), and this repo has already shipped two knobs
 * that wrote a store nobody read.
 *
 * Pure and immutable: every operation returns a new record.
 */

/** brokerId → the camstack device ids exported to it (as strings). */
export type ExportMembership = Readonly<Record<string, readonly string[]>>

export function devicesForBroker(
  membership: ExportMembership,
  brokerId: string,
): readonly string[] {
  return membership[brokerId] ?? []
}

export function isExposed(
  membership: ExportMembership,
  brokerId: string,
  deviceId: string,
): boolean {
  return devicesForBroker(membership, brokerId).includes(deviceId)
}

/** Every broker a device reaches. Drives the N switches in the panel. */
export function brokersExposing(membership: ExportMembership, deviceId: string): readonly string[] {
  return Object.keys(membership)
    .filter((brokerId) => isExposed(membership, brokerId, deviceId))
    .sort()
}

/** Every device exported to at least one of the given brokers. */
export function exposedDeviceIds(
  membership: ExportMembership,
  brokerIds: readonly string[],
): readonly string[] {
  const ids = new Set<string>()
  for (const brokerId of brokerIds) {
    for (const deviceId of devicesForBroker(membership, brokerId)) ids.add(deviceId)
  }
  return [...ids].sort()
}

export function setExposed(
  membership: ExportMembership,
  brokerId: string,
  deviceId: string,
  exposed: boolean,
): ExportMembership {
  const current = devicesForBroker(membership, brokerId)
  if (exposed === current.includes(deviceId)) return membership
  const next = exposed ? [...current, deviceId].sort() : current.filter((id) => id !== deviceId)
  return { ...membership, [brokerId]: next }
}

/** A broker the operator can tick. Cached so the settings form can render. */
export interface KnownBroker {
  readonly id: string
  readonly name: string
}

/** Same brokers, same order, same names — nothing for the form to re-render. */
export function sameBrokers(a: readonly KnownBroker[], b: readonly KnownBroker[]): boolean {
  if (a.length !== b.length) return false
  return a.every((broker, index) => {
    const other = b[index]
    return other !== undefined && other.id === broker.id && other.name === broker.name
  })
}
