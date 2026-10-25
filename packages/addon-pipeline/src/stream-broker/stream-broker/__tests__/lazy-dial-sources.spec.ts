import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  isDerivedOnDemandSource,
  isLazyDialSource,
  shouldDeferBrokerStart,
} from '../lazy-dial-sources.js'

/**
 * Guards the "open only when someone is watching" rule for PULL sources.
 *
 * `flv` was excluded until 2026-08-07. Measured against the sleeping Reolink
 * "Baby monitor" (deviceId 106): every broker (re)start dialed
 * `http://<cam>/flv?...` on both the main and sub slots — ~120 dials a day at
 * a camera nobody was watching, each one failing with `Connection refused` and
 * only then logging `Reconnect skipped — no demand, broker suspended`.
 *
 * `http` was excluded until 2026-08-12 — the SAME failure class one door
 * along. `pull-http` (MJPEG, e.g. the terminal addon's glances relay) maps to
 * `type: 'http'` in `buildSourceFromCamStream`, so the guard in `start()`
 * never fired for it: the broker held a permanent `libx264` transcode of a
 * relay nobody was watching (~12% of a core) and kept the relay's PTY open
 * for hours with zero viewers.
 */
describe('lazy-dial sources — every PULL source waits for demand', () => {
  it.each(['rtsp', 'rtmp', 'rfc4571', 'flv', 'http'])('%s is dialed lazily', (type) => {
    expect(isLazyDialSource(type)).toBe(true)
  })

  it('flv specifically — the regression that woke a battery camera', () => {
    expect(isLazyDialSource('flv')).toBe(true)
  })

  it('http specifically — the regression that kept a terminal relay transcoding for nobody', () => {
    expect(isLazyDialSource('http')).toBe(true)
  })

  it('push and synthetic sources are not lazy-dial — there is nothing to dial', () => {
    for (const type of ['push', 'push-rtp', 'placeholder', 'tcp-raw']) {
      expect(isLazyDialSource(type)).toBe(false)
    }
  })
})

describe('derived on-demand push — idle is suspended, not stale', () => {
  it('recognises a derived push broker', () => {
    expect(isDerivedOnDemandSource({ type: 'push', metadata: { kind: 'derived' } })).toBe(true)
  })

  it('does not treat a camera-provider push as derived', () => {
    expect(isDerivedOnDemandSource({ type: 'push' })).toBe(false)
    expect(isDerivedOnDemandSource({ type: 'push', metadata: { kind: 'pull-rtsp' } })).toBe(false)
    expect(isDerivedOnDemandSource({ type: 'push-rtp', metadata: { kind: 'derived' } })).toBe(false)
  })

  it('shouldDeferBrokerStart covers both lazy-dial pulls and derived push', () => {
    expect(shouldDeferBrokerStart({ type: 'rtsp' })).toBe(true)
    expect(shouldDeferBrokerStart({ type: 'push', metadata: { kind: 'derived' } })).toBe(true)
    expect(shouldDeferBrokerStart({ type: 'push' })).toBe(false)
    expect(shouldDeferBrokerStart({ type: 'push-rtp' })).toBe(false)
  })
})

describe('stream-broker uses the shared predicate, not its own inline list', () => {
  it('start() defers through shouldDeferBrokerStart, not an inline source-type union', () => {
    const here = dirname(fileURLToPath(import.meta.url))
    const source = readFileSync(resolve(here, '../stream-broker.ts'), 'utf8')

    expect(source).toContain('shouldDeferBrokerStart(')
    // The inline union is what let `flv` fall through for months. A second
    // copy of this list is how it comes back.
    expect(source).not.toMatch(/source\.type === 'rtsp' \|\| source\.type === 'rtmp'/)
  })
})
