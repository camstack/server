/**
 * Carrying an exposed-device entry across a re-expose.
 *
 * `exposeDevice` rebuilds its entry from scratch — display name, mapper kind,
 * timestamp — and then REPLACES the stored one. Anything the rebuilt object
 * does not mention is therefore destroyed, and two things it never mentioned
 * were the per-camera settings and the capability list.
 *
 * The visible cost: the operator's "Source stream (HomeKit)" selector writes
 * `low`, the addon logs `streamPreference changed — refreshing accessory
 * {from=auto to=low}`, and the accessory that comes back derives its
 * advertisement from DEFAULTS — `streamPreference=auto` — because the settings
 * were dropped between the write and the rebuild. The selector only ever took
 * effect after a full addon restart, when the settings were loaded first. A
 * second write after the re-expose hid this: the store ended up correct, so
 * nothing looked wrong except the stream nobody could explain.
 */

/**
 * Fill `base` from `existing` for the given keys, letting `base` win wherever
 * it actually says something.
 *
 * That asymmetry is the point: a caller who passes `capabilities` is stating a
 * new truth and must not be overruled by the stored copy, while a caller who
 * says nothing about `settings` is not asking for them to be erased.
 */
export function carryForward<T extends object>(
  base: T,
  existing: Readonly<Partial<T>> | undefined,
  keys: readonly (keyof T)[],
): T {
  if (existing === undefined) return base
  const out = { ...base }
  for (const key of keys) {
    if (out[key] !== undefined) continue
    const carried = existing[key]
    if (carried !== undefined) out[key] = carried
  }
  return out
}
