/**
 * PackageCollectorMirror — who took the parcel, and how close in time the
 * frame that proves it is. See adr-0404.
 */
import { describe, expect, it } from 'vitest'
import {
  PACKAGE_COLLECTOR_MAX_SKEW_MS,
  PACKAGE_COLLECTOR_RETENTION_MS,
  PackageCollectorMirror,
} from '../package-collector-mirror.js'

const DEVICE = 102

function mirror(): PackageCollectorMirror {
  return new PackageCollectorMirror()
}

/** Deterministic media ROW id (D482) for a fixture LABEL — not a real
 *  rowid, just a stable, non-zero number a test can assert back against for
 *  the same label. */
function mediaIdFor(label: string): number {
  let hash = 0
  for (const ch of label) hash = (hash * 31 + ch.charCodeAt(0)) % 100_000
  return hash + 1000
}

describe('PackageCollectorMirror — picking the collector', () => {
  it('answers null when nobody was ever noted for the camera', () => {
    expect(mirror().pickCollector({ deviceId: DEVICE, pickupAt: 10_000 })).toBeNull()
  })

  it('names the track that was PRESENT at the pick-up instant, skew 0', () => {
    const m = mirror()
    m.note({ deviceId: DEVICE, trackId: 't-person', className: 'person', at: 9_000 })
    m.note({ deviceId: DEVICE, trackId: 't-person', className: 'person', at: 11_000 })
    const picked = m.pickCollector({ deviceId: DEVICE, pickupAt: 10_000 })
    expect(picked?.trackId).toBe('t-person')
    expect(picked?.skewMs).toBe(0)
    expect(picked?.observedAt).toBe(10_000)
  })

  it('prefers the NEAREST presence over an earlier one, even a longer-lived one', () => {
    const m = mirror()
    // A courier who lingered for a minute, twenty seconds before the pick-up…
    m.note({ deviceId: DEVICE, trackId: 't-early', className: 'person', at: 0 })
    m.note({ deviceId: DEVICE, trackId: 't-early', className: 'person', at: 60_000 })
    // …and the person who was there when the parcel stopped being seen.
    m.note({ deviceId: DEVICE, trackId: 't-taker', className: 'person', at: 79_000 })
    const picked = m.pickCollector({ deviceId: DEVICE, pickupAt: 80_000 })
    expect(picked?.trackId).toBe('t-taker')
    expect(picked?.skewMs).toBe(1_000)
  })

  it('breaks an exact tie toward the LATER presence — the one still there', () => {
    const m = mirror()
    m.note({ deviceId: DEVICE, trackId: 't-before', className: 'person', at: 9_000 })
    m.note({ deviceId: DEVICE, trackId: 't-after', className: 'person', at: 11_000 })
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 10_000 })?.trackId).toBe('t-after')
  })

  it('refuses a presence further from the pick-up than the skew bound', () => {
    const m = mirror()
    m.note({
      deviceId: DEVICE,
      trackId: 't-far',
      className: 'person',
      at: 100_000 - PACKAGE_COLLECTOR_MAX_SKEW_MS - 1,
    })
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 100_000 })).toBeNull()
  })

  it('carries the track key-frame handle, never pixels', () => {
    const m = mirror()
    m.note({
      deviceId: DEVICE,
      trackId: 't-person',
      className: 'person',
      at: 10_000,
      keyFrameMediaId: mediaIdFor('kf-1'),
    })
    // A later note re-shot a better key frame — the mirror keeps the newest.
    m.note({
      deviceId: DEVICE,
      trackId: 't-person',
      className: 'person',
      at: 10_400,
      keyFrameMediaId: mediaIdFor('kf-2'),
    })
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 10_200 })?.keyFrameMediaId).toBe(
      mediaIdFor('kf-2'),
    )
  })

  it('never answers with another camera track', () => {
    const m = mirror()
    m.note({ deviceId: 101, trackId: 't-other', className: 'person', at: 10_000 })
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 10_000 })).toBeNull()
  })
})

describe('PackageCollectorMirror — noteFrame (the PRODUCTION reader)', () => {
  const PKG = new Set(['package'])
  const ZONES = new Set(['porch'])

  it('notes only a non-package track inside a drop-off zone, with its key frame', () => {
    const m = mirror()
    const noted = m.noteFrame({
      deviceId: DEVICE,
      tracked: [
        { trackId: 't-parcel', className: 'package', zones: ['porch'] },
        { trackId: 't-walker', className: 'person', zones: ['gate'] },
        { trackId: 't-taker', className: 'person', zones: ['gate', 'porch'] },
      ],
      packageClasses: PKG,
      packageZoneIds: ZONES,
      timestamp: 50_000,
      keyFrameMediaIdFor: (id) => (id === 't-taker' ? mediaIdFor('kf-taker') : undefined),
    })
    expect(noted).toBe(1)
    const picked = m.pickCollector({ deviceId: DEVICE, pickupAt: 50_000 })
    expect(picked?.trackId).toBe('t-taker')
    expect(picked?.keyFrameMediaId).toBe(mediaIdFor('kf-taker'))
  })

  it('notes nothing when the camera has no drop-off zone', () => {
    const m = mirror()
    const noted = m.noteFrame({
      deviceId: DEVICE,
      tracked: [{ trackId: 't-taker', className: 'person', zones: ['porch'] }],
      packageClasses: PKG,
      packageZoneIds: new Set(),
      timestamp: 50_000,
      keyFrameMediaIdFor: () => undefined,
    })
    expect(noted).toBe(0)
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 50_000 })).toBeNull()
  })

  it('notes EVERY qualifying track on the frame, not just the first', () => {
    const m = mirror()
    const noted = m.noteFrame({
      deviceId: DEVICE,
      tracked: [
        { trackId: 't-a', className: 'person', zones: ['porch'] },
        { trackId: 't-b', className: 'person', zones: ['porch'] },
      ],
      packageClasses: PKG,
      packageZoneIds: ZONES,
      timestamp: 50_000,
      keyFrameMediaIdFor: () => undefined,
    })
    expect(noted).toBe(2)
    expect(m.debugPresenceCount(DEVICE)).toBe(2)
  })
})

describe('PackageCollectorMirror — bounds', () => {
  it('forgets a presence older than the retention window', () => {
    const m = mirror()
    m.note({ deviceId: DEVICE, trackId: 't-old', className: 'person', at: 0 })
    const now = PACKAGE_COLLECTOR_RETENTION_MS + 1
    m.note({ deviceId: DEVICE, trackId: 't-new', className: 'person', at: now })
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 0 })).toBeNull()
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: now })?.trackId).toBe('t-new')
  })

  it('keeps the memory bounded per device', () => {
    const m = mirror()
    for (let i = 0; i < 200; i += 1) {
      m.note({ deviceId: DEVICE, trackId: `t-${i}`, className: 'person', at: i * 10 })
    }
    expect(m.debugPresenceCount(DEVICE)).toBeLessThanOrEqual(32)
    // The most recent presence survives the eviction.
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 1_990 })?.trackId).toBe('t-199')
  })

  it('forgets a device outright', () => {
    const m = mirror()
    m.note({ deviceId: DEVICE, trackId: 't-person', className: 'person', at: 10_000 })
    m.forgetDevice(DEVICE)
    expect(m.pickCollector({ deviceId: DEVICE, pickupAt: 10_000 })).toBeNull()
  })
})
