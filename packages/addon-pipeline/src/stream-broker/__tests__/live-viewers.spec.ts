import { describe, expect, it } from 'vitest'
import {
  isExternalRestreamClient,
  isViewerConsumerKind,
  mergeViewerCounts,
  type RestreamClientFacts,
} from '../live-viewers.js'

const external: RestreamClientFacts = {
  playing: true,
  userAgent: 'VLC/3.0.20 LibVLC/3.0.20',
  remoteAddr: '192.168.1.40:51234',
  muted: false,
  intent: null,
}

describe('isViewerConsumerKind', () => {
  it('counts the kinds that are a person watching', () => {
    for (const k of [
      'webrtc-browser',
      'webrtc-mobile',
      'webrtc-whep',
      'alexa',
      'homekit',
    ] as const) {
      expect(isViewerConsumerKind(k)).toBe(true)
    }
  })

  it('does not count a system holder', () => {
    for (const k of [
      'recording',
      'pipeline',
      'snapshot',
      'warmup',
      'derived-broker',
      'rtsp-listen',
      'unknown',
    ] as const) {
      expect(isViewerConsumerKind(k)).toBe(false)
    }
  })
})

describe('isExternalRestreamClient', () => {
  it('counts a playing client from another host', () => {
    expect(isExternalRestreamClient(external)).toBe(true)
  })

  it('does not count a client that has not reached PLAY', () => {
    expect(isExternalRestreamClient({ ...external, playing: false })).toBe(false)
  })

  it.each([
    'recorder/102/high/3',
    'decode/102/2',
    'camstack-rtsp-client',
    'prebuffer',
  ])('does not count our own dial (%s)', (userAgent) => {
    expect(isExternalRestreamClient({ ...external, userAgent })).toBe(false)
  })

  it.each([
    'detection',
    'recording',
    'sentry',
  ] as const)('does not count a declared %s dial', (intent) => {
    expect(isExternalRestreamClient({ ...external, intent })).toBe(false)
  })

  it('does not count the muted decoder loopback', () => {
    expect(isExternalRestreamClient({ ...external, muted: true })).toBe(false)
  })

  it.each([
    '127.0.0.1:5000',
    '::1:5000',
    '::ffff:127.0.0.1:5000',
  ])('does not count a process on this host (%s)', (remoteAddr) => {
    expect(isExternalRestreamClient({ ...external, remoteAddr })).toBe(false)
  })

  it('counts a client that sent no User-Agent from another host', () => {
    expect(isExternalRestreamClient({ ...external, userAgent: null })).toBe(true)
  })
})

describe('mergeViewerCounts', () => {
  it('sums per camera and drops zeros without touching the inputs', () => {
    const a = new Map([
      [1, 2],
      [2, 0],
    ])
    const b = new Map([
      [1, 1],
      [3, 4],
    ])
    const merged = mergeViewerCounts([a, b])
    expect([...merged]).toEqual([
      [1, 3],
      [3, 4],
    ])
    expect(a.get(1)).toBe(2)
  })
})
