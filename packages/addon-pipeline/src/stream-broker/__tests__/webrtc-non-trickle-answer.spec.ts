/**
 * Non-trickle answer SDP — integration test against real werift.
 *
 * Guards the Alexa fix: `AdaptiveSession.handleOffer(offer, { nonTrickle: true })`
 * must return a FULL-candidate answer SDP (with `a=candidate` lines) because
 * Alexa's RTCSessionController does NOT support trickle ICE — it never polls
 * `getIceCandidates` nor trickles back via `addIceCandidate`. Without the
 * server's candidates embedded in the answer, Alexa's ICE agent stalls (no
 * nominated pair → DTLS never connects → Echo black → SessionDisconnected).
 *
 * The DEFAULT (browser) path stays trickle: it returns the BARE `createAnswer`
 * SDP (ufrag/pwd/fingerprint, NO candidates) immediately and lets the browser
 * poll candidates afterwards — that fast-start behaviour must be unchanged.
 *
 * `session.ts` loads werift through a `Function('m','return import(m)')` shim
 * (to dodge bundler static analysis) which the vitest module runner can't
 * resolve — so, exactly like `webrtc-client-offer-answer.spec.ts`, we can't
 * drive `AdaptiveSession.handleOffer` directly. Instead we reproduce the exact
 * server-side answer construction it performs for BOTH branches and assert the
 * candidate presence/absence each yields.
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

/** Browser-style offer: recvonly video + audio advertising H.264. */
async function buildBrowserOfferSdp(): Promise<string> {
  const pc = new RTCPeerConnection({
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
  })
  pc.addTransceiver('video', { direction: 'recvonly' })
  pc.addTransceiver('audio', { direction: 'recvonly' })
  await pc.setLocalDescription(await pc.createOffer())
  const sdp = pc.localDescription!.sdp
  await pc.close()
  return sdp
}

/**
 * The server-side answer construction `AdaptiveSession.handleOffer` performs,
 * branching on `nonTrickle` exactly as the production code does:
 *  - nonTrickle=true  → await setLocalDescription + wait for gathering complete,
 *    then read localDescription.sdp (candidates embedded).
 *  - nonTrickle=false → fire setLocalDescription (no await), return the bare
 *    createAnswer SDP (no candidates trickle separately).
 */
async function buildServerAnswerSdp(
  offerSdp: string,
  opts: { nonTrickle: boolean },
): Promise<string> {
  const pc = new RTCPeerConnection(serverPcOptions())

  let gatheringComplete = false
  pc.onIceCandidate.subscribe((c) => {
    if (!c || !c.candidate) gatheringComplete = true
  })

  await pc.setRemoteDescription({ type: 'offer', sdp: offerSdp })
  let videoTrack = false,
    audioTrack = false
  for (const t of pc.getTransceivers()) {
    const kind = t.receiver?.track?.kind ?? t.kind
    if (kind === 'video' && !videoTrack) {
      t.setDirection('sendonly')
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: 'video' }))
      videoTrack = true
    } else if (kind === 'audio' && !audioTrack) {
      t.setDirection('sendonly')
      await t.sender.replaceTrack(new MediaStreamTrack({ kind: 'audio' }))
      audioTrack = true
    }
  }

  const answerDesc = await pc.createAnswer()
  let finalSdp: string
  if (opts.nonTrickle) {
    await pc.setLocalDescription(answerDesc)
    // Wait for gathering to COMPLETE (bounded) — the production
    // `waitForIceGatheringComplete` does the same: it resolves on the
    // gathering-complete signal (onIceCandidate fires undefined) with a cap.
    await new Promise<void>((resolve) => {
      if (gatheringComplete || pc.iceGatheringState === 'complete') return resolve()
      const poll = setInterval(() => {
        if (gatheringComplete || pc.iceGatheringState === 'complete') {
          clearInterval(poll)
          resolve()
        }
      }, 50)
      setTimeout(() => {
        clearInterval(poll)
        resolve()
      }, 5000)
    })
    finalSdp = pc.localDescription?.sdp ?? answerDesc.sdp
  } else {
    void pc.setLocalDescription(answerDesc).catch(() => undefined)
    finalSdp = answerDesc.sdp
  }
  await pc.close()
  return finalSdp
}

function candidateLines(sdp: string): string[] {
  return sdp
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('a=candidate:'))
}

describe('non-trickle answer SDP (werift)', () => {
  it('nonTrickle=true → answer SDP CONTAINS a=candidate lines (full gather)', async () => {
    const offerSdp = await buildBrowserOfferSdp()
    const answer = await buildServerAnswerSdp(offerSdp, { nonTrickle: true })
    expect(candidateLines(answer).length).toBeGreaterThan(0)
    // Still a valid answer with the ufrag/pwd/fingerprint the bare path has.
    expect(answer).toMatch(/a=ice-ufrag:/)
    expect(answer).toMatch(/a=fingerprint:/)
  }, 15_000)

  it('default (trickle) → bare answer SDP has NO a=candidate lines', async () => {
    const offerSdp = await buildBrowserOfferSdp()
    const answer = await buildServerAnswerSdp(offerSdp, { nonTrickle: false })
    expect(candidateLines(answer).length).toBe(0)
    // The bare answer still carries the negotiation primitives — only the
    // candidates trickle separately via getIceCandidates.
    expect(answer).toMatch(/a=ice-ufrag:/)
    expect(answer).toMatch(/a=fingerprint:/)
  }, 15_000)
})
