import type { CamStreamDescriptor } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { type LiveRfc4571Endpoint, overlayLiveNativeRfc4571Sdp } from '../native-sdp-overlay.js'

/**
 * Guards the decode-path regression: a Reolink native `pull-rfc4571` catalog
 * entry carries a SYNTHETIC SDP without `sprop-parameter-sets` + a `lazy:` URL.
 * The raw ffmpeg decode reader has no in-band SPS/PPS merge, so it needs the
 * real SDP (with sprop) whenever the upstream server is live — otherwise it
 * loops `non-existing PPS 0 → no frame` (verified live on device 107). The
 * overlay serves the live endpoint's real `tcp://` URL + real SDP on every
 * pull, and reverts to the synthetic entry once the server tears down.
 */

const SYNTHETIC_SDP = 'v=0\r\nm=video 0 RTP/AVP 96\r\na=fmtp:96 packetization-mode=1\r\n'
const REAL_SDP =
  'v=0\r\nm=video 0 RTP/AVP 96\r\na=fmtp:96 packetization-mode=1;sprop-parameter-sets=Z0LAH,aM4G\r\n'

function nativeEntry(camStreamId: string): CamStreamDescriptor {
  return {
    camStreamId,
    kind: 'pull-rfc4571',
    label: 'main',
    url: `lazy:rfc4571:${camStreamId}`,
    autoEligible: true,
    deviceFeatures: [],
    metadata: { sdp: SYNTHETIC_SDP },
  }
}

function liveServer(sdp = REAL_SDP): LiveRfc4571Endpoint {
  return { host: '127.0.0.1', port: 51234, username: 'cam592', password: 's3cr3t/pw', sdp }
}

describe('overlayLiveNativeRfc4571Sdp', () => {
  it('upgrades a native entry to the live tcp URL + real (sprop) SDP when a server is listening', () => {
    const out = overlayLiveNativeRfc4571Sdp([nativeEntry('native:main')], () => liveServer())
    expect(out).toHaveLength(1)
    expect(out[0]!.url).toBe('tcp://cam592:s3cr3t%2Fpw@127.0.0.1:51234')
    expect(out[0]!.metadata?.sdp).toBe(REAL_SDP)
    expect(String(out[0]!.metadata?.sdp)).toContain('sprop-parameter-sets')
  })

  it('leaves the synthetic lazy entry untouched when no server is live (cold path)', () => {
    const entry = nativeEntry('native:main')
    const out = overlayLiveNativeRfc4571Sdp([entry], () => null)
    expect(out[0]!.url).toBe('lazy:rfc4571:native:main')
    expect(out[0]!.metadata?.sdp).toBe(SYNTHETIC_SDP)
  })

  it('never touches non-rfc4571 descriptors even if a lookup would match', () => {
    const rtsp: CamStreamDescriptor = {
      camStreamId: 'rtsp:main',
      kind: 'pull-rtsp',
      label: 'rtsp',
      url: 'rtsp://cam/main',
      autoEligible: false,
      deviceFeatures: [],
    }
    const out = overlayLiveNativeRfc4571Sdp([rtsp], () => liveServer())
    expect(out[0]).toEqual(rtsp)
  })

  it('is pure — does not mutate the input descriptors or preexisting metadata keys', () => {
    const entry: CamStreamDescriptor = {
      ...nativeEntry('native:main'),
      metadata: { sdp: SYNTHETIC_SDP, extra: 'keep' },
    }
    const snapshot = JSON.parse(JSON.stringify(entry))
    const out = overlayLiveNativeRfc4571Sdp([entry], () => liveServer())
    expect(entry).toEqual(snapshot) // input unchanged
    expect(out[0]!.metadata).toEqual({ sdp: REAL_SDP, extra: 'keep' }) // sibling keys preserved
  })

  it('preserves per-entry liveness — one live, one cold in the same catalog', () => {
    const live = liveServer()
    const lookup = (id: string): LiveRfc4571Endpoint | null => (id === 'native:main' ? live : null)
    const out = overlayLiveNativeRfc4571Sdp(
      [nativeEntry('native:main'), nativeEntry('native:sub')],
      lookup,
    )
    expect(out[0]!.url).toBe('tcp://cam592:s3cr3t%2Fpw@127.0.0.1:51234')
    expect(out[1]!.url).toBe('lazy:rfc4571:native:sub')
  })
})
