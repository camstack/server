/**
 * Proof that werift negotiates Opus with the dual-codec audio offer the session
 * sends (Opus preferred, PCMU fallback), and still falls back to PCMU for a
 * PCMU-only peer. This is the headless-verifiable half of "prove werift
 * negotiates Opus" — it does NOT prove real-browser playback or A/V sync, which
 * need hardware.
 *
 * The codec array here mirrors `pcOptions.codecs.audio` in `AdaptiveSession`'s
 * offer (session.ts) — keep them in sync.
 */
import { describe, it, expect } from 'vitest'
import { RTCPeerConnection, RTCRtpCodecParameters } from 'werift'
import { AUDIO_PT_OPUS, AUDIO_PT_PCMU } from '../audio-rtp-clock'

function opusCodec(): RTCRtpCodecParameters {
  return new RTCRtpCodecParameters({
    mimeType: 'audio/opus',
    clockRate: 48000,
    channels: 2,
    payloadType: AUDIO_PT_OPUS,
    parameters: 'minptime=10;useinbandfec=1',
  })
}
function pcmuCodec(): RTCRtpCodecParameters {
  return new RTCRtpCodecParameters({
    mimeType: 'audio/PCMU',
    clockRate: 8000,
    channels: 1,
    payloadType: AUDIO_PT_PCMU,
  })
}

/** The dual-codec audio offer, Opus first (preferred), PCMU second (fallback). */
function offerAudioCodecs(): RTCRtpCodecParameters[] {
  return [opusCodec(), pcmuCodec()]
}

describe('WebRTC audio SDP offer (dual-codec)', () => {
  it('offers BOTH opus/48000/2 and PCMU/8000, with opus preferred', async () => {
    const offerer = new RTCPeerConnection({ codecs: { audio: offerAudioCodecs() } })
    try {
      offerer.addTransceiver('audio', { direction: 'sendonly' })
      const offer = await offerer.createOffer()
      await offerer.setLocalDescription(offer)
      const sdp = offer.sdp

      expect(/a=rtpmap:\d+ opus\/48000\/2/i.test(sdp)).toBe(true)
      expect(/a=rtpmap:\d+ PCMU\/8000/i.test(sdp)).toBe(true)

      // Opus must appear before PCMU in the m=audio payload-type list so a
      // capable peer picks it; PCMU stays as the guaranteed fallback.
      const mLine = sdp.split('\n').find((l) => l.startsWith('m=audio'))
      expect(mLine).toBeDefined()
      const pts = mLine!.trim().split(/\s+/).slice(3)
      expect(pts.indexOf(String(AUDIO_PT_OPUS))).toBeGreaterThanOrEqual(0)
      expect(pts.indexOf(String(AUDIO_PT_PCMU))).toBeGreaterThanOrEqual(0)
      expect(pts.indexOf(String(AUDIO_PT_OPUS))).toBeLessThan(pts.indexOf(String(AUDIO_PT_PCMU)))
    } finally {
      await offerer.close()
    }
  })

  it('an Opus-capable peer negotiates Opus (48 kHz sender codec)', async () => {
    const offerer = new RTCPeerConnection({ codecs: { audio: offerAudioCodecs() } })
    const answerer = new RTCPeerConnection({ codecs: { audio: offerAudioCodecs() } })
    try {
      const t = offerer.addTransceiver('audio', { direction: 'sendonly' })
      answerer.addTransceiver('audio', { direction: 'recvonly' })
      const offer = await offerer.createOffer()
      await offerer.setLocalDescription(offer)
      await answerer.setRemoteDescription(offer)
      const answer = await answerer.createAnswer()
      await answerer.setLocalDescription(answer)
      await offerer.setRemoteDescription(answer)

      expect(/a=rtpmap:\d+ opus\/48000\/2/i.test(answer.sdp)).toBe(true)
      const negotiated = t.sender?.codec
      expect(negotiated?.mimeType).toBe('audio/opus')
      expect(negotiated?.clockRate).toBe(48000)
      expect(negotiated?.payloadType).toBe(AUDIO_PT_OPUS)
    } finally {
      await offerer.close()
      await answerer.close()
    }
  })

  it('a PCMU-only peer still negotiates PCMU (fallback preserved)', async () => {
    const offerer = new RTCPeerConnection({ codecs: { audio: offerAudioCodecs() } })
    const answerer = new RTCPeerConnection({ codecs: { audio: [pcmuCodec()] } })
    try {
      const t = offerer.addTransceiver('audio', { direction: 'sendonly' })
      answerer.addTransceiver('audio', { direction: 'recvonly' })
      const offer = await offerer.createOffer()
      await offerer.setLocalDescription(offer)
      await answerer.setRemoteDescription(offer)
      const answer = await answerer.createAnswer()
      await answerer.setLocalDescription(answer)
      await offerer.setRemoteDescription(answer)

      expect(/a=rtpmap:\d+ PCMU\/8000/i.test(answer.sdp)).toBe(true)
      expect(/opus/i.test(answer.sdp)).toBe(false)
      expect(t.sender?.codec?.mimeType).toBe('audio/PCMU')
    } finally {
      await offerer.close()
      await answerer.close()
    }
  })
})
