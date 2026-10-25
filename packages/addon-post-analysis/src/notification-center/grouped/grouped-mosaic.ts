/**
 * The grouped MOSAIC (D692 §6.2) — the pure half of how a grouped message's picture is
 * built at SEND. The dispatcher owns the I/O (the shared still wait, the renderer call);
 * this module decides WHICH members get a tile and WHAT each tile's media read asks for.
 *
 *  - one member is a plain immediate row, byte for byte: no mosaic ({@link groupedTileMembers}
 *    answers null and the caller takes the ordinary single-still path, zone crop included);
 *  - two or more → one tile per member, in the sentence's order, at most
 *    {@link NC_GROUPED_MOSAIC_MAX_TILES}; the sentence still counts every member;
 *  - each tile is resolved through the rule's own ladder on a DERIVED entry
 *    ({@link groupedTileEntry}) that carries the member's own subject, zones and
 *    `matchedOn`, rendered as `crop` (N full scenes would be the same picture N times)
 *    and never with a zone drawn.
 *  - a member whose owner is a PHOTOGRAPH held in RAM (a sensor's linked-camera still or a
 *    still-shelf capture — an alarm incident's sensor member, D705) owns no subject crop:
 *    its tile is the whole photograph (`clean`), or it would never land;
 *  - a tile is about its member ALONE: the row's system event (an alarm's `alarmSource`)
 *    is dropped, or the member's object read would be scoped to the source's generation.
 *
 * The mosaic is BYTES only: it never enters the media store (§6.2 item 7).
 */
import { isLinkedStillId } from '../linked-stills.js'
import type { NcOutboxEntry, NcOutboxPayload } from '../outbox.js'
import { isStillShelfId } from '../still-shelf.js'
import type { NcGroupView, NcOutboxGroupMemberV2 } from './grouped-payload.js'

/** At 1920 px, `mosaicRowCounts(6)` is 3 + 3: about 640 px a tile, a face still reads. */
export const NC_GROUPED_MOSAIC_MAX_TILES = 6

/** One member's resolved still — a tile's source, and the picture the AI and the gate judge. */
export interface NcGroupedTileStill {
  readonly trackId: string
  /** The member's own class: the question a tile is asked is about ITS subject. */
  readonly className: string
  readonly bytes: Uint8Array<ArrayBuffer>
  readonly mime: string
  /** The ladder's file name (`thumbnail.jpg`, `crop.jpg`, …) — kept for the fallback. */
  readonly name: string
}

/** Why a member has no tile: nothing landed within the bound. */
export type NcGroupedTileMissReason = 'no-still'

export interface NcGroupedTileMiss {
  readonly trackId: string
  readonly reason: NcGroupedTileMissReason
}

/**
 * A grouped row's tiles, resolved ONCE per delivery and shared by the mosaic, the confirm
 * gate and the AI analyst (§6.2 item 9): the crop judged is the crop shipped (D52), and a
 * composite is never a model input (D154). Present on every row of a group of two or more —
 * `stills` empty when nothing landed or the rule ships no media — and `null` on any other row.
 */
export interface NcGroupedTileSet {
  /** The window key, for the lines that name the message. */
  readonly windowKey: string
  /** Every member the sentence counts (the tiles are capped, the members are not). */
  readonly members: number
  /** The members' stills that LANDED, in the sentence's order. */
  readonly stills: readonly NcGroupedTileStill[]
}

/** What a composed mosaic reports on its INFO line. */
export interface NcGroupedMosaicResult {
  readonly jpeg: Buffer
  readonly tiles: number
  readonly omitted: number
  readonly capped: boolean
}

/**
 * The members that get a tile, in order — or null when the row is not a mosaic at all
 * (no group, or a group of one: §6.2 item 2, the caller ships the single still).
 */
export function groupedTileMembers(
  view: NcGroupView | undefined,
): readonly NcOutboxGroupMemberV2[] | null {
  if (view === undefined || view.members.length <= 1) return null
  return view.members.slice(0, NC_GROUPED_MOSAIC_MAX_TILES)
}

type NcOutboxSubject = NcOutboxPayload['subject']

/** The member's own subject: its track, label, qualifying instant, its event GENERATION. */
function memberSubject(
  subject: NcOutboxSubject,
  m: NcOutboxGroupMemberV2,
  deviceId: number,
): NcOutboxSubject {
  // The primary's event, label, label kind, confidence and zones describe ITS subject: a
  // tile inherits none of them — only the member's own label, where it carries one.
  const {
    eventId: _primaryEvent,
    label: _primaryLabel,
    labelKind: _primaryLabelKind,
    confidence: _primaryConfidence,
    // D705: an alarm row's system event names the SOURCE's event generation
    // (`eventMediaScopeOf`); a tile reads its own member's, so it carries none.
    systemEvent: _rowSystemEvent,
    ...rest
  } = subject
  return {
    ...rest,
    zones: [],
    trackId: m.trackId,
    className: m.className,
    ...(m.label !== undefined ? { label: m.label } : {}),
    ...(m.labelKind !== undefined ? { labelKind: m.labelKind } : {}),
    // D694: the `object` read is scoped by (deviceId, timestamp) — THIS member's
    // generation of a reusable rowid, never the primary's.
    deviceId: m.eventDeviceId ?? deviceId,
    timestamp: m.eventAt ?? m.triggerAt,
    ...(m.eventId !== undefined ? { eventId: m.eventId } : {}),
  }
}

/**
 * False for an owner the RAM shelves minted — a photograph of a scene, never a subject
 * crop (`stillShelfMedia` holds scene kinds only), so a `cropped` ladder finds nothing.
 */
function ownsSubjectCrop(ownerId: string): boolean {
  return !isLinkedStillId(ownerId) && !isStillShelfId(ownerId)
}

/**
 * A NEW entry whose media read is about ONE member. Never mutates `entry`.
 *
 * Drops the primary's zone overlay (no zone on a tile — `mediaShowTriggerZone`, and a
 * legacy row's `mediaZoneIds`), its `triggerZoneIds` and `matchedOn` (the member's own
 * replace them, or none), and renders the tile as `crop` (`clean` for a RAM photograph —
 * see the header) through the same image stage as every still (D897).
 */
export function groupedTileEntry(entry: NcOutboxEntry, m: NcOutboxGroupMemberV2): NcOutboxEntry {
  const {
    mediaZoneIds: _zoneCrop,
    mediaShowTriggerZone: _zoneOverlay,
    mediaFrame: _legacyFrame,
    triggerZoneIds: _primaryZones,
    matchedOn: _primaryMatch,
    ...payload
  } = entry.payload
  return {
    ...entry,
    payload: {
      ...payload,
      mediaImage: ownsSubjectCrop(m.trackId) ? 'crop' : 'clean',
      subject: memberSubject(entry.payload.subject, m, entry.deviceId),
      ...(m.triggerZoneIds !== undefined ? { triggerZoneIds: m.triggerZoneIds } : {}),
      ...(m.matchedOn !== undefined ? { matchedOn: m.matchedOn } : {}),
    },
  }
}
