/**
 * The rows of a room card's `DataTable`: its members, and — only for a member
 * the operator OPENED — that member's accessories, directly under it.
 *
 * `DataTable` knows nothing about nesting; it renders the rows it is given, in
 * order. So the nesting is decided here, once, as a flat list with a `kind`
 * on each row, and the table draws an accessory row indented. Pure, so the
 * collapse rule (`LocationCard.collapse.spec`) is testable without a mount.
 *
 * Column sort is deliberately NOT offered on the card: an accessory row sorted
 * away from its parent would read as a member of the room.
 */
import { linkedChildren, type SiteDevice } from './site-locations'

export interface LocationCardMemberRow {
  readonly kind: 'member'
  readonly device: SiteDevice
  /** The member's companions — drawn as rows only while `open`. */
  readonly accessories: readonly SiteDevice[]
  readonly open: boolean
}

export interface LocationCardAccessoryRow {
  readonly kind: 'accessory'
  readonly device: SiteDevice
  readonly parent: SiteDevice
}

export type LocationCardRow = LocationCardMemberRow | LocationCardAccessoryRow

export function locationCardRowKey(row: LocationCardRow): string {
  return `${row.kind}:${String(row.device.id)}`
}

/**
 * Members in their incoming order, each followed by its accessories when its
 * id is in `openMembers`.
 *
 * `devices` is the fleet the accessories are read from — not `members`: an
 * accessory is never a member row itself (see `topLevelAtLocation`).
 */
export function buildLocationCardRows(
  members: readonly SiteDevice[],
  devices: readonly SiteDevice[],
  openMembers: ReadonlySet<number>,
): readonly LocationCardRow[] {
  return members.flatMap((member): readonly LocationCardRow[] => {
    const accessories = linkedChildren(devices, member.id)
    const open = openMembers.has(member.id)
    const head: LocationCardMemberRow = { kind: 'member', device: member, accessories, open }
    if (!open || accessories.length === 0) return [head]
    return [
      head,
      ...accessories.map(
        (child): LocationCardAccessoryRow => ({ kind: 'accessory', device: child, parent: member }),
      ),
    ]
  })
}
