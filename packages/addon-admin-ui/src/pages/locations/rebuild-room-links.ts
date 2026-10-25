/**
 * Rebuild one room's camera→device links from what the room CONTAINS.
 *
 * The operator's ask, in their words: a button on the room that refreshes the
 * cameras assigned to it and rebuilds their linked-devices list, overwriting
 * what is there.
 *
 * ## Why a button and not a rule
 *
 * D356 retired the `auto` link mode because a rule reached one of two equal
 * spotlights and gave another camera a dozen rows for three appliances. This
 * is not that rule coming back: nothing runs on its own, the operator presses
 * it for one room, and what it writes is the same manual list they can then
 * prune in the picker. The answer comes from `legacyAutoLinkIds` — the SAME
 * function the hub's boot backfill uses, which is why it moved into
 * `@camstack/types` instead of being copied here.
 *
 * ## What it costs
 *
 * Measured on the live fleet 2026-09-24: of 17 cameras, NOT ONE links a device
 * from another room on purpose. The single cross-room case was a camera whose
 * own `location` was never set. So the overwrite the operator asked for
 * destroys nothing today — but it is still an overwrite, and the plan says per
 * camera what it would change so the confirmation is not a leap.
 *
 * ## The camera with no room
 *
 * It is never touched, and that is STRUCTURAL rather than a guard: a camera
 * whose `location` is null matches no room name, so no room's plan can reach
 * it. There was a `refusal: 'no-location'` branch here and it was dead code —
 * unreachable after the room filter — with a test that asserted over an empty
 * list and therefore pinned nothing. A guard that cannot fire is worse than
 * none: it reads as protection. The protection is the filter above it.
 */
import {
  EXTENSION_SLOT_REF_SEPARATOR,
  legacyAutoLinkIds,
  type ExtensionSetSlotInput,
  type LinkCandidate,
} from '@camstack/types'
import type { SiteDevice } from './site-locations'

/** What the rebuild would write to ONE camera. */
export interface RoomLinkPlanEntry {
  readonly deviceId: number
  readonly name: string
  /** The ids the rebuild would write, in resolver order. */
  readonly ids: readonly number[]
}

export interface RoomLinkPlan {
  readonly entries: readonly RoomLinkPlanEntry[]
}

/** A `SiteDevice` as the pure resolver wants it. A row missing `stableId`
 *  cannot take part in a container's primary-child match, so it is passed
 *  through with an empty one rather than dropped — dropping it would silently
 *  shrink the room. */
function toCandidate(d: SiteDevice): LinkCandidate {
  return {
    id: d.id,
    parentDeviceId: d.parentDeviceId,
    location: d.location,
    // `LinkCandidate.type` is the canonical `DeviceType`; the page carries it
    // as a string, which is the same value.
    type: d.type as LinkCandidate['type'],
    stableId: d.stableId ?? '',
    ...(d.primaryChildEntityId !== undefined
      ? { primaryChildEntityId: d.primaryChildEntityId }
      : {}),
    ...(d.role !== undefined && d.role !== null ? { role: d.role } : {}),
    name: d.name,
  }
}

/**
 * What the rebuild would write, per camera in `room`.
 *
 * Pure: the caller decides whether to show it, confirm it, or write it.
 */
export function planRoomLinkRebuild(room: string, fleet: readonly SiteDevice[]): RoomLinkPlan {
  const candidates = fleet.map(toCandidate)
  const entries: RoomLinkPlanEntry[] = []
  for (const d of fleet) {
    if (!d.isCamera) continue
    // A null `location` matches no room name — that, and not a guard below,
    // is what keeps a roomless camera out of every plan.
    if (d.location !== room) continue
    entries.push({
      deviceId: d.id,
      name: d.name,
      ids: legacyAutoLinkIds({ selfId: d.id, selfLocation: d.location, candidates }),
    })
  }
  return { entries }
}

/**
 * The `linked-devices` slot's ref: the device manager's source prefix and the
 * slot id, joined by the D554 separator the dispatcher routes on.
 */
export const LINKED_DEVICES_SLOT_REF = `device-manager${EXTENSION_SLOT_REF_SEPARATOR}linked-devices`

/**
 * The write that rebuilds ONE camera's list — through the `linked-devices`
 * extension slot, the only writer of the list since D655. The slot validates
 * a new pick (never the camera, a container or an unknown id) and refuses by
 * name, where the retired settings path took anything. The tracked-event
 * opt-in is left out on purpose: absent means untouched, exactly what the
 * old settings patch did.
 */
export function linkedDevicesSlotWrite(entry: RoomLinkPlanEntry): ExtensionSetSlotInput {
  return {
    deviceId: entry.deviceId,
    slotRef: LINKED_DEVICES_SLOT_REF,
    value: { slot: 'linked-devices', deviceIds: [...entry.ids] },
  }
}
