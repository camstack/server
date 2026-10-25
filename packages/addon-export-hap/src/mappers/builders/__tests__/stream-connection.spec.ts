import { describe, expect, it } from 'vitest'

import { classifyConnection, slotForConnection } from '../stream-connection.js'

describe('classifyConnection', () => {
  it('reads REMOTE off the audio packet time, not the video', () => {
    // The only reliable remote-ness signal HAP exposes: Opus negotiates 20 ms
    // locally and 60 ms through a relay. Remote and local Wi-Fi are otherwise
    // indistinguishable — same resolution, same bitrate ceiling.
    expect(
      classifyConnection({ negotiatedWidth: 1280, audioPacketTimeMs: 60, viaHomeHub: false }),
    ).toBe('remote')
    expect(
      classifyConnection({ negotiatedWidth: 1280, audioPacketTimeMs: 20, viaHomeHub: false }),
    ).toBe('local')
  })

  it('calls every failing live session LOCAL', () => {
    // Every blank-screen session on this hub logged audioPacketTimeMs=20 while
    // the picker was busy matching 1280x720 to a 10 fps slot. The signal was
    // there the whole time.
    expect(
      classifyConnection({ negotiatedWidth: 1280, audioPacketTimeMs: 20, viaHomeHub: false }),
    ).toBe('local')
  })

  it('uses the video width for ONE thing — spotting a watch', () => {
    expect(
      classifyConnection({ negotiatedWidth: 480, audioPacketTimeMs: 20, viaHomeHub: false }),
    ).toBe('watch')
    // A watch stays a watch even on a local link…
    expect(
      classifyConnection({ negotiatedWidth: 320, audioPacketTimeMs: 60, viaHomeHub: true }),
    ).toBe('watch')
    // …and a full-size panel is never a watch, however small the bitrate.
    expect(
      classifyConnection({ negotiatedWidth: 640, audioPacketTimeMs: 20, viaHomeHub: false }),
    ).toBe('local')
  })

  it('treats a hub relay as possibly-remote, but only when it is not already remote', () => {
    expect(
      classifyConnection({ negotiatedWidth: 1280, audioPacketTimeMs: 20, viaHomeHub: true }),
    ).toBe('home-hub')
    expect(
      classifyConnection({ negotiatedWidth: 1280, audioPacketTimeMs: 60, viaHomeHub: true }),
    ).toBe('remote')
  })
})

describe('slotForConnection', () => {
  it('serves a LOCAL session the camera’s best stream', () => {
    // Pinned to `low` for a year by a measurement (101/high: 93 video packets
    // and one key frame in 30.8 s, against 1497 on the audio leg of the same
    // ffmpeg). The cause was the loopback socket's unset SO_RCVBUF: a 4K
    // key-frame burst overran net.core.rmem_default and the kernel dropped what
    // did not fit. With 8 MiB the same camera and slot delivered 6512 packets
    // in 9.9 s (~660/s, was ~3/s), first key frame at 858 ms, 24 fps —
    // session 12308100-7dbe-4ad1-b277-1f046ba54ec2, 2026-08-07.
    expect(slotForConnection('local')).toBe('high')
  })

  it('keeps every REMOTE class on the small stream — a separate, unmeasured question', () => {
    // The buffer fix says something about a loopback hop inside one host and
    // nothing about a WAN. Raising these needs a measurement of the remote
    // link, not an analogy with the local one.
    expect(slotForConnection('remote')).toBe('low')
    expect(slotForConnection('watch')).toBe('low')
    expect(slotForConnection('home-hub')).toBe('low')
  })

  it('never routes ANY session through the middle slot', () => {
    // On 101 that slot is a 10 fps stream by the camera's own configuration and
    // it has never rendered — pass-through or transcoded, lossy or lossless.
    // Resolution proximity is what used to select it.
    for (const cls of ['local', 'remote', 'watch', 'home-hub'] as const) {
      expect(slotForConnection(cls)).not.toBe('mid')
    }
  })
})
