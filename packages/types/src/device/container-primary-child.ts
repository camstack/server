/**
 * WHICH child a container stands for — one definition, for every consumer.
 *
 * A CONTAINER device has no controllable surface of its own: it groups entity
 * children (a Gree air-conditioner grouping a climate child plus light, x-fan
 * and health switches). Everything that has to show or act on a container has
 * to answer the same question — which child IS the container — and until now
 * three places answered it separately:
 *
 *   - `ui-library/device-controls/primary-child.ts`   (admin-ui rendering)
 *   - `addon-provider-homeassistant` PARENT_TYPE_PRIORITY (adoption)
 *   - the viewer's own `container-primary.ts`         (linked-devices panel)
 *
 * Each carried the same list and a comment asking the others to stay in sync.
 * This is that list, in the one package all of them already depend on.
 *
 * `ui-library` and the server's linked-devices expansion IMPORT it. Two
 * consumers cannot, and keep a checked copy instead: the viewer resolves
 * `@camstack/types` from its own `node_modules` (an installed release, where a
 * newly added export simply is not there), and the Home Assistant provider
 * expresses the same precedence over the `DeviceType` enum because it answers
 * a different question from the same ordering. `scripts/check-container-
 * priority-in-sync.ts` fails the build when either drifts — the comment that
 * used to ask for this could not.
 *
 * The rule has two halves and the ORDER matters: an operator's explicit pick
 * wins outright, and only in its absence does type priority decide. The pick is
 * keyed on the child's re-sync-stable `entityId`, not its numeric id, so it
 * survives a re-sync that reallocates ids.
 */

/**
 * Type priority, most→least "primary". An actuator (climate / lock / cover / …)
 * outranks a bare `switch` so a container's defining child wins over its
 * auxiliary switches. Unknown or absent types sort after every entry.
 *
 * NB: `siren` deliberately sits BELOW `switch` — it is a switch-family
 * actuator, and a camera's siren must not out-rank the thing the container is.
 *
 * These strings are matched against a child's `DeviceType` VALUE, so they must
 * equal the enum's string values.
 */
export const CONTAINER_CHILD_PRIORITY: readonly string[] = [
  'media-player',
  'alarm-panel',
  'thermostat',
  'climate',
  'humidifier',
  'water-heater',
  'lock',
  'cover',
  'valve',
  'fan',
  'vacuum',
  'lawn-mower',
  'dishwasher',
  'light',
  'switch',
  'siren',
  'button',
  'control',
  'notifier',
  'script',
  'automation',
  'update',
  'presence',
  'weather',
  'image',
  'sensor',
]

/** The slice of a child this resolution needs. */
export interface ContainerChildRef {
  readonly id: number
  /**
   * The CANONICAL key an operator's pick is matched on.
   *
   * `stableId` and not `sourceInfo.id`, because `sourceInfo` is rebuilt from
   * the device's config blob and the projection that linked-devices must use
   * (`slim`) does not read it — measured on the live hub, 677 of 925 container
   * children have a `sourceInfo.id` that differs from their `stableId`, so a
   * resolver keyed on it would have missed the operator's pick for three
   * children in four and fallen back to priority WHILE LOOKING LIKE IT WORKED.
   *
   * `stableId` costs nothing to have: it is a NOT NULL column, and
   * `(addonId, stableId)` is the very index the row store re-identifies a
   * device by across a re-sync — which is exactly the durability the pick
   * needs.
   */
  readonly stableId: string
  /**
   * The integration's own entity id, when the caller has it. Accepted ONLY so
   * a pick stored under the previous key still resolves; new picks are written
   * as `stableId`. Absent is normal.
   */
  readonly entityId?: string
  readonly type: string
  /**
   * The child's `DeviceRole`, when the provider stamped one. Ranked BEFORE
   * `type` — see {@link CONTAINER_CHILD_ROLE_PRIORITY}. Absent is normal and
   * simply defers to type priority.
   */
  readonly role?: string
  /** The child's operator-facing name, used only for the namesake tiebreak. */
  readonly name?: string
}

/**
 * Roles that say what a container IS, most→least defining. Consulted BEFORE
 * type priority, because `DeviceType` cannot tell them apart: Home Assistant
 * maps a door contact, a battery level, a temperature reading and a "last seen"
 * timestamp all to `DeviceType.Sensor`. Measured on container 4127 — children
 * `battery-sensor`, `temperature-sensor`, `datetime-sensor`, `contact-sensor`
 * and a role-less `button` — the type list ranked `button` above `sensor` and
 * the container stood for its "Identifica" button instead of the door contact
 * it is named after.
 *
 * Only STATE-DEFINING roles belong here. A diagnostic reading (battery,
 * temperature, humidity, signal, last-seen) is never what a container is, so
 * they are deliberately absent and fall through to type priority.
 */
export const CONTAINER_CHILD_ROLE_PRIORITY: readonly string[] = [
  'contact-sensor',
  'motion-sensor',
  'occupancy-sensor',
  'smoke-sensor',
  'co-sensor',
  'gas-sensor',
  'leak-sensor',
  'vibration-sensor',
  'tamper-sensor',
  'sound-sensor',
]

/**
 * NOT in the list, deliberately: `binary-sensor` and `binary-helper`. They are
 * GENERIC — they say "this reports a boolean", not what the container is — and
 * ranking them above type priority is a live regression, not a hypothetical:
 * container 1837 holds a real `lock` (features `['lock-open']`) alongside a
 * child named "Actuator" whose only role is `binary-sensor`, and the generic
 * role beat the lock. A role earns a place here by naming a SUBJECT (a contact,
 * a leak, smoke), never by naming a datatype.
 */

function roleRank(role: string | undefined): number {
  if (role === undefined) return CONTAINER_CHILD_ROLE_PRIORITY.length
  const i = CONTAINER_CHILD_ROLE_PRIORITY.indexOf(role)
  return i === -1 ? CONTAINER_CHILD_ROLE_PRIORITY.length : i
}

function rank(type: string): number {
  const i = CONTAINER_CHILD_PRIORITY.indexOf(type)
  return i === -1 ? CONTAINER_CHILD_PRIORITY.length : i
}

/**
 * The child a container stands for: the operator's pick when it still exists,
 * else the highest-priority type. `null` for a childless container — a caller
 * must decide what an empty container means for it, rather than being handed a
 * child that is not there.
 */
/**
 * Two names for the same thing, compared the way an integration writes them.
 *
 * An exact case-insensitive match was not enough, and the failure was total
 * rather than marginal. An ESPHome shutter arrives as a container named
 * `Tapparella-Kitchen` whose children include the COVER, named `Tapparella
 * kitchen`, and a device-presence entity carrying the slug verbatim,
 * `tapparella-kitchen`. The slug matched the container exactly and the cover
 * did not, so the namesake tie-break handed the container to a connectivity
 * indicator — and the viewer's accessory panel, which correctly shows only
 * children with an actuating control, then rendered NOTHING. The operator saw
 * no shutters at all on kitchen, studio and both porch cameras (2026-09-22).
 *
 * `Markise` was the control case that proved the mechanism: there the cover
 * really is called exactly like its container, so it won and appeared.
 *
 * Separators are therefore normalised — `-`, `_` and whitespace are the same
 * character for this comparison, and runs of them collapse. The two candidates
 * then tie on the namesake and the decision falls through to `rank(type)`,
 * where `cover` is eighth and a `presence` entity is not listed at all. The
 * criterion keeps doing its job for a container whose child IS the namesake;
 * it stops being decided by which integration used a hyphen.
 */
function sameName(childName: string, containerName: string): boolean {
  const flatten = (v: string): string =>
    v
      .toLowerCase()
      .replace(/[-_\s]+/g, ' ')
      .trim()
  return flatten(childName) === flatten(containerName)
}

export function resolveContainerPrimaryChild(
  children: readonly ContainerChildRef[],
  overrideEntityId: string | null | undefined,
  containerName?: string,
): ContainerChildRef | null {
  if (overrideEntityId !== undefined && overrideEntityId !== null) {
    // Canonical key first, then the legacy one — a pick written before
    // `stableId` became the key must keep resolving rather than silently
    // decaying into the priority default.
    const picked =
      children.find((c) => c.stableId === overrideEntityId) ??
      children.find((c) => c.entityId !== undefined && c.entityId === overrideEntityId)
    // A pick that no longer matches any child falls through to priority rather
    // than yielding nothing: a re-sync that dropped the chosen entity must not
    // leave the container unrepresented.
    if (picked !== undefined) return picked
  }
  // Ordered criteria, most→least decisive. Each only breaks a tie the previous
  // one left: role says what the container IS, the namesake says which child
  // the container was named after, and type is the original fallback.
  const namesake = (c: ContainerChildRef): number =>
    containerName !== undefined &&
    containerName.length > 0 &&
    c.name !== undefined &&
    sameName(c.name, containerName)
      ? 0
      : 1
  return (
    [...children].toSorted(
      (a, b) =>
        roleRank(a.role) - roleRank(b.role) ||
        namesake(a) - namesake(b) ||
        rank(a.type) - rank(b.type),
    )[0] ?? null
  )
}
