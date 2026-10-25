/**
 * Device id → the name the operator uses.
 *
 * ## Why this is not on the contribution
 *
 * `load-contribution` reports `deviceId` and nothing else about the camera,
 * deliberately: the contributor is a recorder or a decode coordinator, and a
 * name is a fact about the fleet that would go stale in every addon that
 * cached a copy (D224). So the name is looked up where the fleet already
 * lives, on the shared `deviceManager.listAll` window the query client
 * registers for every observer (D274) — subscribing costs no round trip, and
 * the call site declares no window of its own.
 *
 * ## Why the id never disappears
 *
 * Every log line in this system is tagged with the numeric `deviceId`, and the
 * operator's questions are shaped like "why is 102 worse than 101?". A card
 * that shows only a name cannot be matched against a log, so the id stays as a
 * subdued suffix. The name is what he reads; the id is what he greps.
 */

/** The minimum a fleet row needs to name a camera. */
export interface FleetDeviceName {
  readonly id: number
  readonly name?: string | null
}

/**
 * Index the fleet by id, keeping only rows that actually carry a name.
 *
 * A blank or whitespace-only name is treated as ABSENT rather than as a title:
 * rendering an empty heading over a chart leaves the card with nothing that
 * identifies it, which is worse than the id it replaced.
 */
export function cameraNamesById(devices: readonly FleetDeviceName[]): ReadonlyMap<number, string> {
  const byId = new Map<number, string>()
  for (const device of devices) {
    const name = device.name?.trim()
    if (name === undefined || name === '') continue
    byId.set(device.id, name)
  }
  return byId
}
