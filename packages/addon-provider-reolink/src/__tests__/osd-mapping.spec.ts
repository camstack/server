import type { OsdConfig } from '@apocaliss92/nodelink-js'
import { describe, expect, it } from 'vitest'
import { buildOsdPatch, projectOsdSnapshot } from '../osd-mapping.js'

/**
 * `getOsd` / `setOsd` (cmd_id 44/45) are the commands that actually carry
 * the OSD. Before `@apocaliss92/nodelink-js` 0.7.0 they were a placeholder:
 * the read issued cmd_id 26 (**GetImage** — the ISP settings) and then
 * text-grepped the reply for `enable` / `name` / `pos` / `timeEnable` /
 * `watermark`, tags that reply does not contain. Every camera in the fleet
 * therefore reported the same fabricated tuple —
 *
 *   { osdChannel: { enable: 1, name: '', pos: '' },
 *     osdTime:    { enable: 0, pos: '' },
 *     watermark:  0 }
 *
 * — while device 3825 really held `name: 'Magicam'` ON at bottom-right, the
 * timestamp ON at top-right and the watermark ON. Three of the four flags the
 * form showed were wrong, and none of them were ever read from an OSD command.
 *
 * The fixtures below are the replies captured from live cameras through the
 * raw-read debug surface, in the shape `getOsd` now returns them. The 16.16
 * ↔ corner encoding itself is the library's, and is pinned by the library's
 * own tests against these same cameras — this file pins the CamStack half:
 * the projection into the snapshot, and "only what was touched" on the write.
 */

const NOW = 1_788_720_043_961

/** Device 3825 — hub child on channel 3. Operator: name bottom-right ON,
 *  timestamp top-right ON, watermark ON. */
const OSD_3825: OsdConfig = {
  channel: 3,
  channelName: {
    enable: true,
    name: 'Magicam',
    topLeftX: 65_536,
    topLeftY: 65_536,
    position: { kind: 'corner', corner: 'bottom-right' },
    enWatermark: true,
    enBgcolor: false,
  },
  datetime: {
    enable: true,
    topLeftX: 65_536,
    topLeftY: 1,
    position: { kind: 'corner', corner: 'top-right' },
    language: 'English',
  },
}

/** Device 108 — mains camera on channel 0, channel-name overlay OFF. */
const OSD_618: OsdConfig = {
  channel: 0,
  channelName: {
    enable: false,
    name: 'Bedroom',
    topLeftX: 0,
    topLeftY: 0,
    position: { kind: 'corner', corner: 'top-left' },
    enWatermark: false,
    enBgcolor: false,
  },
  datetime: {
    enable: true,
    topLeftX: 1,
    topLeftY: 1,
    position: { kind: 'corner', corner: 'top-left' },
    language: 'English',
  },
}

/** What the library returns when the camera answered with no OSD blocks:
 *  every fact `null`, never a default. */
const OSD_UNREPORTED: OsdConfig = {
  channel: 0,
  channelName: {
    enable: null,
    name: null,
    topLeftX: null,
    topLeftY: null,
    position: { kind: 'unknown' },
    enWatermark: null,
    enBgcolor: null,
  },
  datetime: {
    enable: null,
    topLeftX: null,
    topLeftY: null,
    position: { kind: 'unknown' },
    language: null,
  },
}

describe('projectOsdSnapshot — the flags come from the OSD command, and they match the camera', () => {
  it('device 3825 projects exactly what the operator configured', () => {
    expect(projectOsdSnapshot(OSD_3825, NOW)).toEqual({
      channelEnabled: true,
      channelName: 'Magicam',
      channelX: 65_536,
      channelY: 65_536,
      timeEnabled: true,
      timeX: 65_536,
      timeY: 1,
      watermark: true,
      fetchedAt: NOW,
    })
  })

  it('device 108 projects a channel-name overlay that is OFF', () => {
    const snapshot = projectOsdSnapshot(OSD_618, NOW)
    expect(snapshot.channelEnabled).toBe(false)
    expect(snapshot.channelName).toBe('Bedroom')
    expect(snapshot.timeEnabled).toBe(true)
    expect(snapshot.watermark).toBe(false)
  })

  it('an unreported overlay leaves every fact UNKNOWN (null), never a default (D337)', () => {
    expect(projectOsdSnapshot(OSD_UNREPORTED, NOW)).toEqual({
      channelEnabled: null,
      channelX: null,
      channelY: null,
      timeEnabled: null,
      timeX: null,
      timeY: null,
      watermark: null,
      fetchedAt: NOW,
    })
  })

  it('a reply that omits a single field leaves THAT fact null and keeps the others', () => {
    const snapshot = projectOsdSnapshot(
      {
        ...OSD_UNREPORTED,
        channelName: { ...OSD_UNREPORTED.channelName, name: 'Front door', enable: true },
      },
      NOW,
    )
    expect(snapshot.channelEnabled).toBe(true)
    expect(snapshot.channelName).toBe('Front door')
    expect(snapshot.channelX).toBeNull()
    expect(snapshot.watermark).toBeNull()
    expect(snapshot.timeEnabled).toBeNull()
  })
})

describe('buildOsdPatch — a save writes only what was touched', () => {
  it('no OSD keys in the patch → nothing to write', () => {
    expect(buildOsdPatch({})).toBeNull()
    expect(buildOsdPatch({ osdChannelEnabled: undefined })).toBeNull()
  })

  it('a toggle-only save carries that one field and nothing else — the round-trip cannot lose the rest', () => {
    // `setOsd` read-modify-writes the camera's own XML, so every field we
    // omit is preserved verbatim. Adding fields we were not asked to change
    // is what would overwrite an operator's hand placement.
    expect(buildOsdPatch({ osdTimeEnabled: false })).toEqual({
      datetime: { enable: false },
    })
    expect(buildOsdPatch({ osdChannelName: 'Boiler room' })).toEqual({
      channelName: { name: 'Boiler room' },
    })
  })

  it('the watermark rides the channel-name block (that is where the camera keeps it)', () => {
    expect(buildOsdPatch({ osdWatermark: true })).toEqual({
      channelName: { enWatermark: true },
    })
  })

  it("a corner is forwarded as a corner — the 16.16 encoding is the library's job", () => {
    expect(buildOsdPatch({ osdChannelPosition: 'bottom-right' })).toEqual({
      channelName: { position: 'bottom-right' },
    })
    expect(buildOsdPatch({ osdTimePosition: 'top-right' })).toEqual({
      datetime: { position: 'top-right' },
    })
  })

  it('the "custom" option keeps the camera placement — it writes no position', () => {
    expect(buildOsdPatch({ osdChannelPosition: 'custom' })).toBeNull()
    expect(buildOsdPatch({ osdTimePosition: 'custom', osdTimeEnabled: true })).toEqual({
      datetime: { enable: true },
    })
  })

  it('a value outside the offered vocabulary is never sent to the camera', () => {
    expect(buildOsdPatch({ osdChannelPosition: 'Lower-Right' })).toBeNull()
    expect(buildOsdPatch({ osdTimePosition: 42 })).toBeNull()
  })

  it('a full save carries both blocks', () => {
    expect(
      buildOsdPatch({
        osdChannelEnabled: true,
        osdChannelName: 'Magicam',
        osdChannelPosition: 'bottom-right',
        osdWatermark: true,
        osdTimeEnabled: true,
        osdTimePosition: 'top-right',
      }),
    ).toEqual({
      datetime: { enable: true, position: 'top-right' },
      channelName: {
        enable: true,
        name: 'Magicam',
        position: 'bottom-right',
        enWatermark: true,
      },
    })
  })
})
