import type { OsdConfig, OsdPatch } from '@apocaliss92/nodelink-js'
import { isOsdCorner, OSD_CORNERS, readOsdPosition } from '@apocaliss92/nodelink-js'
import type { OsdOverlay, OsdPosition, OsdStatus } from '@camstack/types'
import type { OsdSnapshot } from './osd-settings-section.js'

/** Reolink channel-name overlay — short firmware limit, but usable as OSD text. */
export const REOLINK_OSD_CHANNEL_MAX_CHARS = 31

/** Overlay ids published on the `osd` device cap. */
export const REOLINK_OSD_OVERLAY_IDS = {
  channel: 'channel',
  time: 'time',
  watermark: 'watermark',
} as const

/** Firmware corners the form / osd cap offer — same vocabulary as settings. */
const CORNER_POSITIONS: readonly OsdPosition[] = OSD_CORNERS as readonly OsdPosition[]

/**
 * The CamStack ↔ camera boundary for the OSD overlay: the library's
 * `getOsd` reply → the persisted snapshot, and the settings-form keys →
 * the library's `setOsd` patch. Pure, so both directions are testable
 * without a `ReolinkCamera`.
 *
 * `getOsd` / `setOsd` (cmd_id 44/45) are the OSD commands. They were a
 * placeholder until `@apocaliss92/nodelink-js` 0.7.0 — `getOsd` issued
 * cmd_id 26 (GetImage, the ISP block) and text-grepped that reply for OSD
 * tags it does not carry, so every camera answered with the same fabricated
 * tuple, and `setOsd` posted an `<Osd>` body to cmd_id 25 (SetImage), which
 * the firmware ignores. The library now speaks 44/45 and owns the anchor
 * codec, so nothing here reimplements either (D374).
 *
 * Note where the watermark lives: inside the channel-name overlay
 * (`enWatermark`), not at the top level. `setOsd` read-modify-writes the
 * camera's own XML, so a patch that names one field preserves every other
 * field verbatim — which is why {@link buildOsdPatch} emits ONLY the
 * touched keys.
 */

/** The OSD keys as they arrive from the settings form (untyped by nature). */
export interface OsdSettingsPatchInput {
  readonly osdChannelEnabled?: unknown
  readonly osdChannelName?: unknown
  readonly osdChannelPosition?: unknown
  readonly osdTimeEnabled?: unknown
  readonly osdTimePosition?: unknown
  readonly osdWatermark?: unknown
}

/**
 * Project a `getOsd` reply into the persisted snapshot. A field the camera
 * did not report arrives as `null` from the library and stays `null` here —
 * unknown must survive to the UI (D337), so nothing may substitute a default.
 */
export function projectOsdSnapshot(config: OsdConfig, now: number): OsdSnapshot {
  const name = config.channelName
  const time = config.datetime
  return {
    channelEnabled: name.enable,
    ...(typeof name.name === 'string' ? { channelName: name.name } : {}),
    channelX: name.topLeftX,
    channelY: name.topLeftY,
    timeEnabled: time.enable,
    timeX: time.topLeftX,
    timeY: time.topLeftY,
    // The watermark flag is a member of the channel-name overlay on the wire.
    watermark: name.enWatermark,
    fetchedAt: now,
  }
}

/**
 * Build the `setOsd` patch for a settings save. Returns `null` when the save
 * touched no OSD field the camera can take.
 *
 * A position of `'custom'` is the "leave it where the operator dragged it"
 * option: it names no corner, so none is written. Any other unrecognised
 * value is dropped rather than forwarded — the camera is never sent a value
 * outside the vocabulary the form offered.
 */
export function buildOsdPatch(input: OsdSettingsPatchInput): OsdPatch | null {
  const datetime: NonNullable<OsdPatch['datetime']> = {}
  const channelName: NonNullable<OsdPatch['channelName']> = {}

  if (typeof input.osdTimeEnabled === 'boolean') datetime.enable = input.osdTimeEnabled
  if (isOsdCorner(input.osdTimePosition)) datetime.position = input.osdTimePosition

  if (typeof input.osdChannelEnabled === 'boolean') channelName.enable = input.osdChannelEnabled
  if (typeof input.osdChannelName === 'string') channelName.name = input.osdChannelName
  if (isOsdCorner(input.osdChannelPosition)) channelName.position = input.osdChannelPosition
  if (typeof input.osdWatermark === 'boolean') channelName.enWatermark = input.osdWatermark

  const hasDatetime = Object.keys(datetime).length > 0
  const hasChannelName = Object.keys(channelName).length > 0
  if (!hasDatetime && !hasChannelName) return null
  return {
    ...(hasDatetime ? { datetime } : {}),
    ...(hasChannelName ? { channelName } : {}),
  }
}

function cornerFromSnapshot(
  x: number | null | undefined,
  y: number | null | undefined,
): OsdPosition | undefined {
  const reading = readOsdPosition(x, y)
  if (reading.kind !== 'corner') return undefined
  const corner = reading.corner
  return CORNER_POSITIONS.includes(corner) ? corner : undefined
}

/**
 * Snapshot → `osd` cap overlays. The channel-name slot is WRITABLE (short
 * firmware limit) so the OSD manager can drive it like any other text overlay.
 * Time and watermark stay firmware-owned (`readOnly`).
 */
export function overlaysFromOsdSnapshot(snapshot: OsdSnapshot | undefined): readonly OsdOverlay[] {
  if (snapshot === undefined) return []
  const channelPosition = cornerFromSnapshot(snapshot.channelX, snapshot.channelY)
  const timePosition = cornerFromSnapshot(snapshot.timeX, snapshot.timeY)
  return [
    {
      id: REOLINK_OSD_OVERLAY_IDS.channel,
      kind: 'text',
      enabled: snapshot.channelEnabled === true,
      text: snapshot.channelName ?? '',
      availablePositions: CORNER_POSITIONS,
      maxCharacters: REOLINK_OSD_CHANNEL_MAX_CHARS,
      ...(channelPosition !== undefined ? { position: channelPosition } : {}),
    },
    {
      id: REOLINK_OSD_OVERLAY_IDS.time,
      kind: 'timestamp',
      enabled: snapshot.timeEnabled === true,
      availablePositions: CORNER_POSITIONS,
      readOnly: true,
      ...(timePosition !== undefined ? { position: timePosition } : {}),
    },
    {
      id: REOLINK_OSD_OVERLAY_IDS.watermark,
      kind: 'watermark',
      enabled: snapshot.watermark === true,
      availablePositions: [],
      readOnly: true,
    },
  ]
}

export function osdStatusFromSnapshot(snapshot: OsdSnapshot | undefined): OsdStatus {
  return { overlays: overlaysFromOsdSnapshot(snapshot) }
}

/** Cap `setOverlay` patch → library `setOsd` patch (or null when nothing to write). */
export function buildOsdCapOverlayPatch(
  overlayId: string,
  patch: {
    readonly enabled?: boolean
    readonly text?: string
    readonly position?: string
  },
): OsdPatch | null {
  if (overlayId === REOLINK_OSD_OVERLAY_IDS.channel) {
    const channelName: NonNullable<OsdPatch['channelName']> = {}
    if (typeof patch.enabled === 'boolean') channelName.enable = patch.enabled
    if (typeof patch.text === 'string') {
      channelName.name = patch.text.slice(0, REOLINK_OSD_CHANNEL_MAX_CHARS)
    }
    if (isOsdCorner(patch.position)) channelName.position = patch.position
    if (Object.keys(channelName).length === 0) return null
    return { channelName }
  }
  if (overlayId === REOLINK_OSD_OVERLAY_IDS.time) {
    const datetime: NonNullable<OsdPatch['datetime']> = {}
    if (typeof patch.enabled === 'boolean') datetime.enable = patch.enabled
    if (isOsdCorner(patch.position)) datetime.position = patch.position
    if (Object.keys(datetime).length === 0) return null
    return { datetime }
  }
  if (overlayId === REOLINK_OSD_OVERLAY_IDS.watermark) {
    if (typeof patch.enabled !== 'boolean') return null
    return { channelName: { enWatermark: patch.enabled } }
  }
  return null
}
