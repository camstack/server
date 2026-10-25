import { readFileSync } from 'node:fs'
import { BatteryStatusSchema, CamStreamDescriptorSchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import {
  advertisedRfcHost,
  cameraBatterySlice,
  cameraStreamCatalog,
  LAZY_RFC4571_URL,
  relayHubAddress,
  rfcUrl,
} from '../devices/dreame-camera-stream.js'

/**
 * The robot camera streams ON DEMAND: the relay only carries video between
 * `open()` and `close()`, so the stream-broker's battery path is the seam —
 * `battery.wakeForStream` opens the monitor, the catalog reconcile that
 * follows the wake reads a relay URL, and the broker pulls it. These are the
 * pure facts that seam is built from.
 */
describe('cameraBatterySlice — the robot as a battery camera', () => {
  it('is asleep while the monitor is closed, awake while it is open', () => {
    const closed = cameraBatterySlice({
      level: 80,
      charging: 2,
      streamOpen: false,
      now: 10,
      contactAt: 9,
    })
    const open = cameraBatterySlice({
      level: 80,
      charging: 2,
      streamOpen: true,
      now: 10,
      contactAt: 9,
    })
    expect(closed.sleeping).toBe(true)
    expect(open.sleeping).toBe(false)
    expect(BatteryStatusSchema.safeParse(closed).success).toBe(true)
  })

  it('maps the robot charging states onto the cap vocabulary', () => {
    expect(
      cameraBatterySlice({ level: 50, charging: 1, streamOpen: false, now: 1, contactAt: 1 })
        .charging,
    ).toBe('dc')
    expect(
      cameraBatterySlice({ level: 50, charging: 2, streamOpen: false, now: 1, contactAt: 1 })
        .charging,
    ).toBe('none')
    expect(
      cameraBatterySlice({ level: 50, charging: 5, streamOpen: false, now: 1, contactAt: 1 })
        .charging,
    ).toBe('none')
    expect(
      cameraBatterySlice({ level: 50, charging: null, streamOpen: false, now: 1, contactAt: 1 })
        .charging,
    ).toBe('unknown')
  })

  it('carries the last contact, and omits it when there has been none — never 0', () => {
    const heard = cameraBatterySlice({
      level: null,
      charging: null,
      streamOpen: false,
      now: 5,
      contactAt: 4,
    })
    const never = cameraBatterySlice({
      level: null,
      charging: null,
      streamOpen: false,
      now: 5,
      contactAt: null,
    })
    expect(heard.lastContactAt).toBe(4)
    expect(never).not.toHaveProperty('lastContactAt')
    expect(never.percentage).toBeNull()
  })

  it('clamps an out-of-range level instead of failing the schema', () => {
    expect(
      cameraBatterySlice({ level: 140, charging: null, streamOpen: false, now: 1, contactAt: 1 })
        .percentage,
    ).toBe(100)
  })
})

describe('cameraStreamCatalog — the RTP server while open, the lazy sentinel while closed', () => {
  it('carries the lazy sentinel and a codec-only SDP while the monitor is closed, so the stream is LISTED and the first dial materializes it', () => {
    const [only, ...rest] = cameraStreamCatalog(null)
    expect(rest).toEqual([])
    expect(only).toMatchObject({ kind: 'pull-rfc4571', url: LAZY_RFC4571_URL, codec: 'h264' })
    expect(only?.metadata?.sdp).toContain('a=rtpmap:96 H264/90000')
    expect(only?.metadata?.sdp).not.toContain('sprop-parameter-sets')
    expect(CamStreamDescriptorSchema.safeParse(only).success).toBe(true)
  })

  it('names one pull-rfc4571 stream with its SDP, carrying the battery feature, while open', () => {
    const [only, ...rest] = cameraStreamCatalog({ url: 'tcp://127.0.0.1:4321', sdp: 'v=0' })
    expect(rest).toEqual([])
    expect(only).toMatchObject({ kind: 'pull-rfc4571', url: 'tcp://127.0.0.1:4321', codec: 'h264' })
    expect(only?.metadata).toEqual({ sdp: 'v=0' })
    expect(only?.deviceFeatures).toContain('battery-operated')
    expect(CamStreamDescriptorSchema.safeParse(only).success).toBe(true)
  })
})

describe('advertisedRfcHost — the address a broker on another node can reach', () => {
  it("is the host of the hub's internal address", () => {
    expect(advertisedRfcHost('https://192.168.10.9:4443')).toBe('192.168.10.9')
  })
  it('reads the internal role, never the public endpoint (D734)', () => {
    const book = {
      roles: {
        internal: { resolved: 'http://192.168.10.9:4480' },
        publicEndpoint: { resolved: 'https://cams.example.org' },
      },
    }
    expect(advertisedRfcHost(relayHubAddress(book))).toBe('192.168.10.9')
  })
  it('is loopback when the hub names no address', () => {
    expect(advertisedRfcHost(null)).toBe('127.0.0.1')
    expect(advertisedRfcHost('not a url')).toBe('127.0.0.1')
  })
  it('composes the tcp url the broker dials', () => {
    expect(rfcUrl('192.168.10.9', 40001)).toBe('tcp://192.168.10.9:40001')
  })
})

describe('the monitor and the broker registration move together (source guard)', () => {
  const src = readFileSync(new URL('../devices/dreame-camera-device.ts', import.meta.url), 'utf8')
  it('an open publishes the server, a close publishes the lazy sentinel back — never a stale tcp url the next play would dial into nothing', () => {
    const open = src.indexOf('robot camera: monitor open')
    const close = src.indexOf('robot camera: monitor closed')
    expect(src.lastIndexOf('publishRelay(this.session)', open)).toBeGreaterThan(-1)
    expect(src.lastIndexOf('publishRelay(null)', close)).toBeGreaterThan(-1)
    // a materialize request on a closed monitor IS the wake
    expect(src).toContain('void this.openStream().catch(() => undefined)')
    // and the consumer leaving IS the close (the plugin's rule): no broker polling
    expect(src).toContain('onConsumerDisconnect: () => {')
    expect(src).not.toContain('listClients')
  })
  it('a lost feed closes the monitor (lazy sentinel back), so the next dial is a wake and not a re-publish of a dead port', () => {
    // 2026-09-09: the relay went silent at 22:52, the broker asked for a
    // refresh 71 times and was handed the same dead port each time, until an
    // unhandled `read ETIMEDOUT` from the relay socket killed the provider.
    expect(src).toContain('onFeedLost: (loss) => {')
    expect(src).toContain("void this.closeStream('feed-lost')")
    expect(src).toContain('robot camera: relay feed lost')
  })
})

describe('cameraStreamCatalog — the one stream is the LOW of this camera', () => {
  it('hints `low` so the broker files it under recordingsLow and scrub can read it', () => {
    const [closed] = cameraStreamCatalog(null)
    const [open] = cameraStreamCatalog({ url: 'tcp://127.0.0.1:1', sdp: 'v=0' })
    expect(closed?.profileHint).toBe('low')
    expect(open?.profileHint).toBe('low')
  })
})
