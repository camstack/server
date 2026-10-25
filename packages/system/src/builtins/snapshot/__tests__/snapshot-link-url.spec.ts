import { describe, expect, it } from 'vitest'

import {
  SNAPSHOT_LINK_EXP_BUCKET_MS,
  SNAPSHOT_LINK_TTL_MS,
  buildSnapshotLinkUrl,
  parseVerifiedSnapshotLink,
  snapshotLinkExpiry,
} from '../snapshot-link-url.js'

const SECRET = 'install-secret'
const PREFIX = '/addon/snapshot/link'
const NOW = 1_786_000_000_000

function mint(
  deviceId: number,
  width: number | undefined,
  capturedAt: number | null,
  nowMs = NOW,
): string {
  return buildSnapshotLinkUrl({
    routePrefix: PREFIX,
    deviceId,
    width,
    capturedAt,
    secret: SECRET,
    expMs: snapshotLinkExpiry(nowMs),
  })
}

/** The handler sees the path AFTER the plane prefix is stripped. */
function handlerUrl(link: string): string {
  return link.slice(PREFIX.length)
}

describe('snapshot link url', () => {
  it('mints a root-relative path, never an absolute origin', () => {
    // Absolute bases are how the Alexa `hubUrl: localhost` bug shipped. The
    // client already knows where the hub is; handing it a path makes an
    // unreachable link impossible to construct.
    const link = mint(101, 240, NOW - 2_000)
    expect(link.startsWith('/addon/snapshot/link/101.jpg?')).toBe(true)
    expect(link).not.toMatch(/^https?:/)
  })

  it('round-trips a valid link back to its (device, width)', () => {
    const link = mint(101, 240, NOW - 2_000)
    expect(
      parseVerifiedSnapshotLink({ url: handlerUrl(link), secret: SECRET, nowMs: NOW }),
    ).toEqual({ deviceId: 101, width: 240 })
  })

  it('round-trips a full-frame link (no width)', () => {
    const link = mint(101, undefined, NOW - 2_000)
    expect(link).not.toContain('w=')
    expect(
      parseVerifiedSnapshotLink({ url: handlerUrl(link), secret: SECRET, nowMs: NOW }),
    ).toEqual({ deviceId: 101, width: undefined })
  })

  it('REFUSES a tile link escalated to the full frame', () => {
    // The width is inside the signed identity precisely for this. A leaked
    // 240 px thumbnail must not become a 4 K frame of the operator's home.
    const link = mint(101, 240, NOW - 2_000)
    const escalated = handlerUrl(link).replace('w=240&', '')
    expect(parseVerifiedSnapshotLink({ url: escalated, secret: SECRET, nowMs: NOW })).toBeNull()
    const widened = handlerUrl(link).replace('w=240', 'w=960')
    expect(parseVerifiedSnapshotLink({ url: widened, secret: SECRET, nowMs: NOW })).toBeNull()
  })

  it('REFUSES a link replayed against a different camera', () => {
    const link = mint(101, 240, NOW - 2_000)
    const other = handlerUrl(link).replace('/101.jpg', '/102.jpg')
    expect(parseVerifiedSnapshotLink({ url: other, secret: SECRET, nowMs: NOW })).toBeNull()
  })

  it('REFUSES a link once its expiry has passed', () => {
    const link = mint(101, 240, NOW - 2_000)
    const afterExpiry = NOW + SNAPSHOT_LINK_TTL_MS + SNAPSHOT_LINK_EXP_BUCKET_MS + 1
    expect(
      parseVerifiedSnapshotLink({ url: handlerUrl(link), secret: SECRET, nowMs: NOW }),
    ).not.toBeNull()
    expect(
      parseVerifiedSnapshotLink({ url: handlerUrl(link), secret: SECRET, nowMs: afterExpiry }),
    ).toBeNull()
  })

  it('REFUSES a link whose exp was extended by hand', () => {
    const link = handlerUrl(mint(101, 240, NOW - 2_000))
    const exp = new URLSearchParams(link.slice(link.indexOf('?') + 1)).get('exp')
    expect(exp).not.toBeNull()
    const extended = link.replace(`exp=${String(exp)}`, `exp=${String(Number(exp) + 86_400_000)}`)
    expect(parseVerifiedSnapshotLink({ url: extended, secret: SECRET, nowMs: NOW })).toBeNull()
  })

  it('REFUSES a link signed by another install', () => {
    const link = handlerUrl(mint(101, 240, NOW - 2_000))
    expect(parseVerifiedSnapshotLink({ url: link, secret: 'other-secret', nowMs: NOW })).toBeNull()
  })

  it('REFUSES an unsigned request outright', () => {
    expect(
      parseVerifiedSnapshotLink({ url: '/101.jpg?w=240', secret: SECRET, nowMs: NOW }),
    ).toBeNull()
  })

  it('the URL changes when the FRAME changes, and only then', () => {
    // This is the client-cache contract: an unchanged frame must be a
    // byte-identical URL (no bytes on the wire), a new frame must be a new URL
    // (exactly one fetch). Both mints are inside one expiry bucket.
    const a = mint(101, 240, 1_786_000_000_000)
    const aAgain = mint(101, 240, 1_786_000_000_000, NOW + 1_000)
    const b = mint(101, 240, 1_786_000_005_000)
    expect(aAgain).toBe(a)
    expect(b).not.toBe(a)
  })

  it('the expiry is bucketed, so a link is stable between mints', () => {
    // Without bucketing every 5 s poll would mint a different URL and a phone
    // would re-download 16 unchanged tiles a minute.
    const e1 = snapshotLinkExpiry(NOW)
    const e2 = snapshotLinkExpiry(NOW + 1_000)
    expect(e2).toBe(e1)
    expect(e1 % SNAPSHOT_LINK_EXP_BUCKET_MS).toBe(0)
    expect(e1).toBeGreaterThanOrEqual(NOW + SNAPSHOT_LINK_TTL_MS)
  })

  it('a device with NO cached frame still gets a usable link', () => {
    // D94: the request is what triggers the first capture, so "no frame yet" can
    // never be the reason to withhold the URL.
    const link = mint(618, 240, null)
    expect(link).not.toContain('v=')
    expect(
      parseVerifiedSnapshotLink({ url: handlerUrl(link), secret: SECRET, nowMs: NOW }),
    ).toEqual({ deviceId: 618, width: 240 })
  })

  it('refuses malformed paths without reaching the signature check', () => {
    for (const url of ['/', '/abc.jpg', '/101/nested.jpg', '/0.jpg', '/-1.jpg']) {
      expect(parseVerifiedSnapshotLink({ url, secret: SECRET, nowMs: NOW })).toBeNull()
    }
  })
})
