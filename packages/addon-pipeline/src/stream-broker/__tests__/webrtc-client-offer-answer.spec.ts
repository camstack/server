/**
 * Client-offer answer SDP — integration test against real werift.
 *
 * A browser doing client-offer passthrough creates the SDP offer with
 * `recvonly` audio+video transceivers; the server (`AdaptiveSession.
 * handleOffer`) must answer `sendonly` on each. The regression this guards:
 * without forcing the transceiver direction, werift answers `inactive` and
 * marks both m-lines rejected (port 0), which empties the `a=group:BUNDLE`
 * line. werift-to-werift tolerates that, but Chrome/iOS rejects the answer
 * with "A BUNDLE group contains a MID='' matching no m= section" and the
 * session never connects — exactly the iPhone failure observed live.
 *
 * `session.ts` loads werift through a `Function('m','return import(m)')`
 * shim (to dodge bundler static analysis), which the vitest module runner
 * can't resolve — so we can't drive `AdaptiveSession.handleOffer` directly
 * here. Instead we reproduce the exact server-side answer construction it
 * performs (setRemoteDescription → per-transceiver `setDirection('sendonly')`
 * + replaceTrack → createAnswer) and assert the answer is Chrome-valid, plus
 * a contrast case proving the bug WITHOUT the direction fix.
 */
import { describe, it, expect } from 'vitest'
import { RTCPeerConnection, MediaStreamTrack, RTCRtpCodecParameters, type PeerConfig } from 'werift'

function serverPcOptions(): Partial<PeerConfig> {
  return {
    iceServers: [],
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 96,
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        }),
      ],
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/PCMU',
          clockRate: 8000,
          payloadType: 0,
          channels: 1,
        }),
      ],
    },
    headerExtensions: {
      video: [{ id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
      audio: [{ id: 1, uri: 'urn:ietf:params:rtp-hdrext:sdes:mid' }],
    },
  }
}

/** Browser-style offer: recvonly video + audio, advertising H.264 High + Baseline. */
async function buildBrowserOfferSdp(): Promise<string> {
  const pc = new RTCPeerConnection({
    codecs: {
      video: [
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 96,
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=640c1f',
        }),
        new RTCRtpCodecParameters({
          mimeType: 'video/H264',
          clockRate: 90000,
          payloadType: 102,
          parameters: 'level-asymmetry-allowed=1;packetization-mode=1;profile-level-id=42e01f',
        }),
      ],
      audio: [
        new RTCRtpCodecParameters({
          mimeType: 'audio/PCMU',
          clockRate: 8000,
          payloadType: 0,
          channels: 1,
        }),
      ],
    },
  })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  await pc.setLocalDescription(await pc.createOffer())
  const sdp = pc.localDescription!.sdp
  await pc.close()
  return sdp
}

/** The server-side answer construction `AdaptiveSession.handleOffer` performs. */
async function buildServerAnswerSdp(
  offerSdp: string,
  opts: { forceSendonly: boolean },
): Promise<string> {
  const pc = new RTCPeerConnection(serverPcOptions())
  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
  let videoTrack = false,
    audioTrack = false
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver?.track?.kind ?? t.kind
    if (kind === 'video' && !videoTrack) {
      if (opts.forceSendonly) t.setDirection('sendonly')
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: 'video' }))
      videoTrack = true
    } else if (kind === 'audio' && !audioTrack) {
      if (opts.forceSendonly) t.setDirection('sendonly')
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: 'audio' }))
      audioTrack = true
    }
  }
  await pc.setLocalDescription(await pc.createAnswer())
  const sdp = pc.localDescription!.sdp
  await pc.close()
  return sdp
}

interface AnswerShape {
  bundleTokens: string[]
  mids: string[]
  ports: number[]
  directions: string[]
}

function parseAnswer(sdp: string): AnswerShape {
  const bundleRaw = sdp.match(/a=group:BUNDLE([^\r\n]*)/)?.[1] ?? ''
  return {
    bundleTokens: bundleRaw.split(/\s+/).filter((t) => t.length > 0),
    mids: [...sdp.matchAll(/a=mid:(\S*)/g)].map((m) => m[1] ?? ''),
    ports: [...sdp.matchAll(/^m=\S+ (\d+)/gm)].map((m) => Number(m[1])),
    directions: [...sdp.matchAll(/a=(sendonly|recvonly|sendrecv|inactive)/g)].map((m) => m[1]!),
  }
}

describe('client-offer answer SDP (werift)', () => {
  it('FIX: setDirection(sendonly) → Chrome-valid BUNDLE (no empty MID) + active sendonly m-lines', async () => {
    const offerSdp = await buildBrowserOfferSdp()
    const answer = await buildServerAnswerSdp(offerSdp, { forceSendonly: true })
    const s = parseAnswer(answer)

    // two m-lines, each with a non-empty mid
    expect(s.mids.length).toBe(2)
    expect(s.mids.every((m) => m.length > 0)).toBe(true)
    // BUNDLE lists exactly those mids — never an empty token (the Chrome reject)
    expect(s.bundleTokens.length).toBe(2)
    expect(new Set(s.bundleTokens)).toEqual(new Set(s.mids))
    // both m-lines active (port != 0) and sending toward the browser
    expect(s.ports.every((p) => p !== 0)).toBe(true)
    expect(s.directions).toContain('sendonly')
    expect(s.directions).not.toContain('inactive')
  }, 15_000)

  it('BUG (contrast): without setDirection the answer rejects both m-lines and empties BUNDLE', async () => {
    const offerSdp = await buildBrowserOfferSdp()
    const answer = await buildServerAnswerSdp(offerSdp, { forceSendonly: false })
    const s = parseAnswer(answer)

    // This is the malformed answer Chrome/iOS rejects: empty BUNDLE + port-0 m-lines.
    expect(s.bundleTokens.length).toBe(0)
    expect(s.ports.every((p) => p === 0)).toBe(true)
    expect(s.directions).toContain('inactive')
  }, 15_000)
})
