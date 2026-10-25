/**
 * The GROUPED payload (D692 §6.1) — what one grouped outbox row freezes about its
 * window, and the one reader every consumer (dispatcher, hydration, cooldown reseed)
 * goes through.
 *
 * Two shapes exist on disk:
 *
 *  - **v2** (`version: 2`), written by a grouped window's close: the window key (the
 *    row's `dedupRef`), when it opened and closed and why, and the members in the order
 *    the sentence names them and the mosaic tiles them;
 *  - **legacy** — a D143 burst revision still PENDING at deploy (D692 §9). It is read,
 *    never written: its members are kept, `revision`, `anchorTrackId` and the per-member
 *    `bbox` are ignored, and it has no window time (its footage keeps the subject anchor).
 *    The outbox prune window (7 days) retires them; this reader's legacy half is removed
 *    one release later.
 *
 * No push `tag` is ever derived from either (D686, D692).
 */
import { z } from 'zod'
import type { NcGroupedCloseReason } from './grouped-window-buffer.js'

/** The bound on {@link NcOutboxGroupMemberV2.absorbedIds} (review T10 MEDIUM-1). */
export const NC_OUTBOX_GROUP_ABSORBED_MAX = 16

/**
 * The ids a member's survivor ABSORBED inside its window (D683 fusions), frozen at close.
 * Bounded: a row read from disk is validated against it, and a value that does not parse
 * is read as "none" — never trusted, never thrown.
 */
const NcOutboxGroupAbsorbedIdsSchema = z
  .array(z.string().min(1))
  .max(NC_OUTBOX_GROUP_ABSORBED_MAX)
  .readonly()
export type NcOutboxGroupAbsorbedIds = z.infer<typeof NcOutboxGroupAbsorbedIdsSchema>

/**
 * One subject of a grouped message. The order in `members` IS the order the sentence
 * names them and the mosaic tiles them (§6.2 item 1).
 */
export interface NcOutboxGroupMemberV2 {
  /** The SURVIVOR id — the tile's track-owned media. */
  readonly trackId: string
  readonly className: string
  readonly label?: string
  readonly labelKind?: 'identity' | 'plate'
  /**
   * D694: the member's qualifying OBJECT event and its GENERATION — an event id is a
   * reusable rowid, so a tile's `object` media read is scoped by exactly this camera and
   * this event's STORED timestamp (`eventMediaScopeOf` on the tile's derived entry).
   * Absent on a legacy member: its tile reads track-owned media only.
   */
  readonly eventId?: string
  readonly eventDeviceId?: number
  readonly eventAt?: number
  /** The member's own qualifying instant (its first match) — its still's MOMENT gate. */
  readonly triggerAt: number
  /** The rule's zone ids frozen for this member (D223 narrowing on its own trail). */
  readonly triggerZoneIds?: readonly string[]
  /** Its full-match `matchedOn` — `best-matching` picks the face/plate crop per tile. */
  readonly matchedOn?: readonly string[]
  /**
   * The ids the survivor absorbed in the window (review T10 MEDIUM-1). The boot hydration
   * adds them to the notified set, so a replayed event under an absorbed id the alias store
   * cannot resolve is still refused. Absent on a row written before it, and on a member
   * that absorbed nothing.
   */
  readonly absorbedIds?: NcOutboxGroupAbsorbedIds
}

export interface NcOutboxGroupV2 {
  readonly version: 2
  /** The window key — the row's `dedupRef`; never a push tag. */
  readonly key: string
  /** The first event's timestamp — the footage anchor (§6.3). */
  readonly openedAt: number
  readonly closedAt: number
  readonly closeReason: NcGroupedCloseReason
  readonly members: readonly NcOutboxGroupMemberV2[]
}

/** One member of a legacy D143 burst row. */
export interface NcOutboxGroupLegacyMember {
  readonly trackId: string
  readonly className: string
  readonly label?: string
  readonly labelKind?: 'identity' | 'plate'
  readonly bbox?: NcOutboxGroupLegacyBox
  readonly at: number
}

/** A legacy member's normalized 0..1 box (ignored by the reader). */
export interface NcOutboxGroupLegacyBox {
  readonly x: number
  readonly y: number
  readonly w: number
  readonly h: number
}

/** A D143 burst revision still pending at deploy (§9) — read, never written. */
export interface NcOutboxGroupLegacy {
  readonly key: string
  readonly revision: number
  readonly anchorTrackId: string
  readonly members: readonly NcOutboxGroupLegacyMember[]
}

export type NcOutboxGroup = NcOutboxGroupV2 | NcOutboxGroupLegacy

/** What every reader sees — one shape for both versions. */
export interface NcGroupView {
  readonly key: string
  /** v2 only; a legacy row has no window, so its footage keeps the subject anchor. */
  readonly openedAt?: number
  readonly members: readonly NcOutboxGroupMemberV2[]
  readonly legacy: boolean
}

export function isGroupV2(group: NcOutboxGroup): group is NcOutboxGroupV2 {
  return 'version' in group && group.version === 2
}

function legacyMember(m: NcOutboxGroupLegacyMember): NcOutboxGroupMemberV2 {
  return {
    trackId: m.trackId,
    className: m.className,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.labelKind !== undefined ? { labelKind: m.labelKind } : {}),
    triggerAt: m.at,
  }
}

export function readOutboxGroup(group: NcOutboxGroup | undefined): NcGroupView | undefined {
  if (group === undefined) return undefined
  if (isGroupV2(group)) {
    return { key: group.key, openedAt: group.openedAt, members: group.members, legacy: false }
  }
  return { key: group.key, members: group.members.map(legacyMember), legacy: true }
}

/** A member's absorbed ids as stored: absent or malformed reads as none. */
export function memberAbsorbedIds(member: NcOutboxGroupMemberV2): NcOutboxGroupAbsorbedIds {
  const parsed = NcOutboxGroupAbsorbedIdsSchema.safeParse(member.absorbedIds ?? [])
  return parsed.success ? parsed.data : []
}

/** What the close writes for a member's absorbed ids, and what the bound left out. */
export interface NcBoundedAbsorbedIds {
  readonly kept: NcOutboxGroupAbsorbedIds
  readonly dropped: readonly string[]
}

/**
 * The absorbed ids a close freezes: the LATEST {@link NC_OUTBOX_GROUP_ABSORBED_MAX} (the
 * fusions nearest the crash the hydration guards against). The caller says what was left out.
 */
export function boundAbsorbedIds(ids: readonly string[]): NcBoundedAbsorbedIds {
  const unique = [...new Set(ids)]
  const cut = Math.max(0, unique.length - NC_OUTBOX_GROUP_ABSORBED_MAX)
  return { kept: unique.slice(cut), dropped: unique.slice(0, cut) }
}

/** What a window member knows at close, for the ordering. */
export interface NcGroupOrderInput extends NcOutboxGroupMemberV2 {
  readonly firstSeenAt: number
}

function isRecognised(m: NcOutboxGroupMemberV2): boolean {
  return m.labelKind === 'identity' || m.labelKind === 'plate'
}

/**
 * §6.2 item 1: recognised members (identity or plate) first, then the rest; each group
 * by first-seen. The sentence names them in this order and the mosaic tiles them in it.
 */
export function orderGroupMembers(
  members: readonly NcGroupOrderInput[],
): readonly NcOutboxGroupMemberV2[] {
  const bySeen = (a: NcGroupOrderInput, b: NcGroupOrderInput): number =>
    a.firstSeenAt - b.firstSeenAt
  const recognised = members.filter(isRecognised).sort(bySeen)
  const rest = members.filter((m) => !isRecognised(m)).sort(bySeen)
  return [...recognised, ...rest].map(({ firstSeenAt: _seen, ...member }) => member)
}
