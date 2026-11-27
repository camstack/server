import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { AdaptiveSession } from '../session'

/**
 * `AdaptiveSession` cannot load werift under vitest (its dynamic-import shim is
 * not resolvable here, see `session-pli-wiring.spec.ts`), so `writeVideoNals`
 * is stood in for by a function that records the value the sender would put on
 * the wire; the capture itself is pinned against the source below.
 */
function makeSession(wireOffset: number, writes: boolean): AdaptiveSession {
  const session: AdaptiveSession = Object.create(AdaptiveSession.prototype)
  Reflect.set(session, 'lastWireVideoRtpTs', null)
  Reflect.set(session, 'recordedWireVideoRtpTs', null)
  Reflect.set(session, 'writeVideoNals', (_nals: Buffer[], rtpTs: number) => {
    if (writes) Reflect.set(session, 'lastWireVideoRtpTs', (rtpTs + wireOffset) >>> 0)
  })
  return session
}

const AU = new Uint8Array([0, 0, 0, 1, 0x65, 0xaa, 0xbb])

describe('recorded video wire RTP timestamp (planning#728)', () => {
  it('reports the timestamp the sender wrote, offset included', () => {
    const s = makeSession(1000, true)
    s.pushRecordedAccessUnit(AU, 90_000, 'H264')
    expect(s.takeVideoWireRtpTs()).toBe(91_000)
  })

  it('is consumed once: nothing is reported until the next frame', () => {
    const s = makeSession(0, true)
    s.pushRecordedAccessUnit(AU, 5, 'H264')
    expect(s.takeVideoWireRtpTs()).toBe(5)
    expect(s.takeVideoWireRtpTs()).toBeUndefined()
  })

  it('stays a uint32 across the wrap', () => {
    const s = makeSession(0x1_0000_0000 - 10, true)
    s.pushRecordedAccessUnit(AU, 30, 'H264')
    expect(s.takeVideoWireRtpTs()).toBe(20)
  })

  it('does not report a stale value when a later push writes nothing', () => {
    const writing = makeSession(0, true)
    writing.pushRecordedAccessUnit(AU, 5, 'H264')
    Reflect.set(writing, 'writeVideoNals', () => {})
    writing.pushRecordedAccessUnit(AU, 9, 'H264')
    expect(writing.takeVideoWireRtpTs()).toBeUndefined()
  })

  it('reads the wire value off the header AFTER the sender added its offset', () => {
    const source = readFileSync(new URL('../session.ts', import.meta.url), 'utf8')
    const send = source.indexOf('this.videoSender!.sendRtp(pkt)')
    const capture = source.indexOf('this.lastWireVideoRtpTs = header.timestamp >>> 0')
    expect(send).toBeGreaterThan(-1)
    expect(capture).toBeGreaterThan(send)
  })
})
