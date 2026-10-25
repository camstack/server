/**
 * A device's CONTAINER name, resolved from a fleet listing.
 *
 * Every picker in this app lists devices by name, and on this fleet that is not
 * enough to pick with: 1096 devices, nine of them called "Temperatura", four
 * called "Blocco bambini". The container is what tells them apart, and
 * `parentDeviceId` already rides the slim projection those pickers fetch — so
 * this costs no query and no round-trip, only the lookup nobody was doing.
 *
 * ONE level, deliberately: the operator's question is "which thing is this
 * attached to", not "what is the full ancestry", and a path grows a row past
 * the width a picker has.
 *
 * The DevicePicker in `@camstack/ui-library` resolves the same fact into its
 * second-line `detail` (`in <parent>`) via `withResolvedParentDetail` — keep
 * the one-level rule identical there.
 */

/** The fields this needs. Any listing row satisfies it. */
export interface ParentResolvable {
  readonly id: number
  readonly name: string
  readonly parentDeviceId: number | null
}

/**
 * Map of `deviceId → container label`, absent for a top-level device.
 *
 * A parent that is NOT in the listing resolves to `#<id>` rather than to
 * nothing: the listing can be filtered or partial, and rendering nothing would
 * say "this is top-level", which is a different claim and a wrong one.
 */
export function resolveParentNames(
  devices: readonly ParentResolvable[],
): ReadonlyMap<number, string> {
  const byId = new Map<number, string>()
  for (const d of devices) byId.set(d.id, d.name)

  const out = new Map<number, string>()
  for (const d of devices) {
    const parent = d.parentDeviceId
    if (parent === null) continue
    // A row that is its own parent is corrupt data, not a container. Naming
    // itself as its own container reads as a real answer.
    if (parent === d.id) continue
    out.set(d.id, byId.get(parent) ?? `#${String(parent)}`)
  }
  return out
}
