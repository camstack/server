/**
 * D771 — talk-back from a client-offer peer (an Echo) to the camera speaker,
 * through the intercom cap's push-talk triple.
 */
import { describe, expect, it, vi } from 'vitest'
import { RTCPeerConnection } from 'werift'
import { createNullLogger } from '../types.js'
import {
  audioCodecForPayloadType,
  clientOfferAudioDirection,
  offerLetsPeerSendAudio,
  type TalkbackFrame,
  type TalkbackIntercomPort,
  TalkbackBridge,
  talkCodecOf,
} from '../talkback-bridge.js'

function port(opts: { failStart?: number } = {}) {
  let starts = 0
  const frames: TalkbackFrame[] = []
  const calls: string[] = []
  const p: TalkbackIntercomPort = {
    startTalkSession: vi.fn(async () => {
      starts += 1
      calls.push('start')
      if (opts.failStart !== undefined && starts <= opts.failStart) throw new Error('busy')
    }),
    pushTalkAudio: vi.fn(async (f: TalkbackFrame) => {
      frames.push(f)
      return { accepted: true }
    }),
    endTalkSession: vi.fn(async () => {
      calls.push('end')
    }),
  }
  return { p, frames, calls }
}

const speech = (n: number) => Buffer.alloc(40, n)
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('TalkbackBridge', () => {
  it('opens ONE talk session for a burst and pushes Opus in order at 48 kHz mono', async () => {
    const { p, frames, calls } = port()
    const b = new TalkbackBridge(101, p, createNullLogger())
    for (let i = 0; i < 5; i++) b.onAudio(speech(i), 'Opus')
    await flush()
    expect(calls.filter((c) => c === 'start')).toHaveLength(1)
    expect(frames.map((f) => f.sequenceNumber)).toEqual([1, 2, 3, 4, 5])
    expect(frames[0]).toMatchObject({
      deviceId: 101,
      codec: 'opus',
      sampleRate: 48_000,
      channels: 1,
    })
  })

  it('never opens on DTX / comfort-noise frames', async () => {
    const { p, calls } = port()
    const b = new TalkbackBridge(101, p, createNullLogger())
    for (let i = 0; i < 20; i++) b.onAudio(Buffer.alloc(3), 'Opus')
    await flush()
    await b.close()
    expect(calls).toEqual([])
  })

  it('retries the open on the next frame after a failure', async () => {
    const { p, calls, frames } = port({ failStart: 1 })
    const b = new TalkbackBridge(101, p, createNullLogger())
    b.onAudio(speech(1), 'Opus')
    await flush()
    b.onAudio(speech(2), 'Opus')
    await flush()
    expect(calls.filter((c) => c === 'start')).toHaveLength(2)
    expect(frames.map((f) => f.sequenceNumber)).toEqual([2])
  })

  it('ends the talk session exactly once on close, and nothing after', async () => {
    const { p, calls } = port()
    const b = new TalkbackBridge(101, p, createNullLogger())
    b.onAudio(speech(1), 'Opus')
    await b.close()
    await b.close()
    b.onAudio(speech(2), 'Opus')
    await flush()
    expect(calls).toEqual(['start', 'end'])
  })

  it('maps PCMU and refuses codecs the intercom path cannot take', () => {
    expect(talkCodecOf('Pcmu')).toEqual({ codec: 'g711ulaw', sampleRate: 8_000 })
    expect(talkCodecOf('Aac')).toBeNull()
  })
})

describe('offerLetsPeerSendAudio', () => {
  const offer = (dir: string | null) =>
    [
      'v=0',
      'm=video 9 UDP/TLS/RTP/SAVPF 96',
      'a=recvonly',
      'm=audio 9 UDP/TLS/RTP/SAVPF 111',
      ...(dir ? [`a=${dir}`] : []),
    ].join('\r\n')

  it('reads the audio m-section, not the video one', () => {
    expect(offerLetsPeerSendAudio(offer('sendrecv'))).toBe(true)
    expect(offerLetsPeerSendAudio(offer('sendonly'))).toBe(true)
    expect(offerLetsPeerSendAudio(offer(null))).toBe(true)
    expect(offerLetsPeerSendAudio(offer('recvonly'))).toBe(false)
    expect(offerLetsPeerSendAudio('v=0\r\nm=video 9 UDP/TLS/RTP/SAVPF 96')).toBe(false)
  })
})

/**
 * `session.ts` loads werift through a `Function('m','return import(m)')` shim
 * the vitest runner cannot resolve (see `webrtc-non-trickle-answer.spec.ts`),
 * so `AdaptiveSession.handleOffer` cannot be driven here. This reproduces its
 * client-offer audio step with real werift, through the SAME exported helpers
 * the session calls (`clientOfferAudioDirection`, `audioCodecForPayloadType`).
 */
describe('client-offer audio answer (real werift)', () => {
  async function answerAudioSection(talkback: boolean): Promise<string> {
    const peer = new RTCPeerConnection({})
    const server = new RTCPeerConnection({})
    try {
      peer.addTransceiver('video', { direction: 'recvonly' })
      peer.addTransceiver('audio', { direction: 'sendrecv' })
      const offer = await peer.createOffer()
      await peer.setLocalDescription(offer)
      await server.setRemoteDescription(offer)
      for (const t of server.getTransceivers()) {
        if (t.kind === 'audio') t.setDirection(clientOfferAudioDirection(talkback, offer.sdp))
        else t.setDirection('sendonly')
      }
      const answer = await server.createAnswer()
      return answer.sdp.split(/m=/).find((sec) => sec.startsWith('audio')) ?? ''
    } finally {
      await peer.close()
      await server.close()
    }
  }

  it('answers sendrecv audio when talk-back is on, so the Echo sends its microphone', async () => {
    expect(await answerAudioSection(true)).toMatch(/a=sendrecv/)
  })

  it('keeps answering sendonly audio when talk-back is off (every other viewer)', async () => {
    expect(await answerAudioSection(false)).toMatch(/a=sendonly/)
  })

  it('names the inbound codec from the negotiated payload type', () => {
    const codecs = [
      { mimeType: 'audio/opus', payloadType: 111 },
      { mimeType: 'audio/PCMU', payloadType: 0 },
    ]
    expect(audioCodecForPayloadType(codecs, 111)).toBe('Opus')
    expect(audioCodecForPayloadType(codecs, 0)).toBe('Pcmu')
    expect(audioCodecForPayloadType(codecs, 9)).toBeNull()
  })
})
