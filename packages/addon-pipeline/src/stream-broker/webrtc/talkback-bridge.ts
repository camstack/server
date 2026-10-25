/**
 * Talk-back over a client-offer WebRTC session (D771).
 *
 * A peer that offers SEND audio on a session created with `talkback: true`
 * (today: the Alexa export, for an Echo or the Alexa app on a camera with the
 * `intercom` cap) has its audio relayed to that camera's speaker through the
 * intercom cap's push-talk triple — `startTalkSession` / `pushTalkAudio` /
 * `endTalkSession` — the same primitive HomeKit's return audio uses. The
 * provider decodes Opus at 48 kHz, resamples to the camera's rate and encodes
 * for the camera; nothing here transcodes.
 *
 * Behaviour, each from a failure HomeKit already had:
 *  - the talk session opens LAZILY on the first audio frame that carries sound,
 *    with a synchronous sentinel so the ~50 frames/s that arrive while the
 *    open is in flight do not each open one;
 *  - Opus DTX / comfort-noise frames (≤ 3 bytes) are not sound and never open
 *    a session, so a muted Echo does not hold the camera's talk channel;
 *  - pushes are chained so the camera receives frames in order;
 *  - a failed open or push drops back to idle so the next frame retries;
 *  - `close()` ends the talk session exactly once.
 */
import type { IScopedLogger } from '@camstack/types'
import { errMsg } from '@camstack/types'
import type { AudioCodec } from './types.js'

/** The slice of `ctx.api.intercom` the bridge drives. */
export interface TalkbackIntercomPort {
  readonly startTalkSession: (deviceId: number) => Promise<void>
  readonly pushTalkAudio: (input: TalkbackFrame) => Promise<{ accepted: boolean }>
  readonly endTalkSession: (deviceId: number) => Promise<void>
}

export interface TalkbackFrame {
  readonly deviceId: number
  readonly audioBase64: string
  readonly codec: 'opus' | 'g711ulaw' | 'g711alaw'
  readonly sampleRate: number
  readonly channels: 1
  readonly sequenceNumber: number
}

/** A frame this small is Opus DTX / comfort noise, not speech. */
const DTX_MAX_BYTES = 3

/** How the push-talk triple names each WebRTC audio codec, or null when the
 *  intercom path cannot take it. */
export function talkCodecOf(
  format: AudioCodec,
): { codec: TalkbackFrame['codec']; sampleRate: number } | null {
  switch (format) {
    case 'Opus':
      return { codec: 'opus', sampleRate: 48_000 }
    case 'Pcmu':
      return { codec: 'g711ulaw', sampleRate: 8_000 }
    case 'Pcma':
      return { codec: 'g711alaw', sampleRate: 8_000 }
    default:
      return null
  }
}

type BridgeState = 'idle' | 'opening' | 'open'

export class TalkbackBridge {
  private state: BridgeState = 'idle'
  /** Set by `close()`; no frame is accepted after it. */
  private closing = false
  /** A talk session was opened at the camera and must be ended. */
  private started = false
  private sequence = 0
  private chain: Promise<void> = Promise.resolve()
  private dropped = 0
  private refusedCodecLogged = false

  constructor(
    private readonly deviceId: number,
    private readonly port: TalkbackIntercomPort,
    private readonly logger: IScopedLogger,
  ) {}

  /** One inbound RTP payload from the peer. Never throws. */
  onAudio(payload: Buffer, format: AudioCodec): void {
    if (this.closing) return
    if (payload.length <= DTX_MAX_BYTES) return
    const talk = talkCodecOf(format)
    if (talk === null) {
      if (!this.refusedCodecLogged) {
        this.refusedCodecLogged = true
        this.logger.warn('talk-back: the peer sends a codec the intercom path cannot take', {
          tags: { deviceId: this.deviceId },
          meta: { format },
        })
      }
      return
    }
    if (this.state === 'idle') {
      this.state = 'opening'
      this.chain = this.chain.then(() => this.open())
    }
    const frame: TalkbackFrame = {
      deviceId: this.deviceId,
      audioBase64: payload.toString('base64'),
      codec: talk.codec,
      sampleRate: talk.sampleRate,
      channels: 1,
      sequenceNumber: ++this.sequence,
    }
    this.chain = this.chain.then(() => this.push(frame))
  }

  /** End the talk session (if one opened). Idempotent. */
  async close(): Promise<void> {
    if (this.closing) return
    this.closing = true
    // Let an open already in flight land, so a session the camera granted is
    // the one this ends.
    await this.chain.catch(() => {})
    if (!this.started) return
    await this.port.endTalkSession(this.deviceId).catch((err: unknown) => {
      this.logger.warn('talk-back: endTalkSession failed', {
        tags: { deviceId: this.deviceId },
        meta: { error: errMsg(err) },
      })
    })
    this.logger.info('talk-back: ended', {
      tags: { deviceId: this.deviceId },
      meta: { frames: this.sequence, dropped: this.dropped },
    })
  }

  private async open(): Promise<void> {
    if (this.state !== 'opening') return
    try {
      await this.port.startTalkSession(this.deviceId)
      this.started = true
      if (this.state === 'opening') this.state = 'open'
      this.logger.info('talk-back: the peer is talking — camera talk session opened', {
        tags: { deviceId: this.deviceId },
      })
    } catch (err) {
      if (this.state === 'opening') this.state = 'idle'
      this.logger.warn('talk-back: startTalkSession failed — will retry on the next frame', {
        tags: { deviceId: this.deviceId },
        meta: { error: errMsg(err) },
      })
    }
  }

  private async push(frame: TalkbackFrame): Promise<void> {
    if (this.state !== 'open') {
      this.dropped += 1
      return
    }
    try {
      const r = await this.port.pushTalkAudio(frame)
      if (!r.accepted) this.dropped += 1
    } catch (err) {
      this.dropped += 1
      if (this.state === 'open') this.state = 'idle'
      this.logger.warn('talk-back: pushTalkAudio failed — reopening on the next frame', {
        tags: { deviceId: this.deviceId },
        meta: { error: errMsg(err), sequence: frame.sequenceNumber },
      })
    }
  }
}

/**
 * Does the client's offer let the PEER send audio? (Its `m=audio` section is
 * `sendrecv` or `sendonly`; absent direction means `sendrecv`, RFC 3264.)
 */
export function offerLetsPeerSendAudio(offerSdp: string): boolean {
  let inAudio = false
  let direction: string | null = null
  let sawAudio = false
  for (const raw of offerSdp.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('m=')) {
      if (inAudio) break
      inAudio = line.startsWith('m=audio')
      if (inAudio) sawAudio = true
      continue
    }
    if (inAudio && /^a=(sendrecv|sendonly|recvonly|inactive)$/.test(line)) {
      direction = line.slice(2)
    }
  }
  if (!sawAudio) return false
  return direction === null || direction === 'sendrecv' || direction === 'sendonly'
}

/**
 * The direction to ANSWER a client offer's audio with: `sendrecv` only when
 * talk-back was asked for AND the peer offered to send audio; otherwise the
 * `sendonly` every viewer has always had.
 */
export function clientOfferAudioDirection(
  talkback: boolean,
  offerSdp: string,
): 'sendrecv' | 'sendonly' {
  return talkback && offerLetsPeerSendAudio(offerSdp) ? 'sendrecv' : 'sendonly'
}

/** One negotiated codec as werift lists it on a transceiver. */
export interface NegotiatedCodecLike {
  readonly mimeType: string
  readonly payloadType: number
}

/** The codec an inbound RTP packet carries, by its payload type. */
export function audioCodecForPayloadType(
  codecs: readonly NegotiatedCodecLike[],
  payloadType: number,
): AudioCodec | null {
  const codec = codecs.find((c) => c.payloadType === payloadType)
  switch (codec?.mimeType.toLowerCase()) {
    case 'audio/opus':
      return 'Opus'
    case 'audio/pcmu':
      return 'Pcmu'
    case 'audio/pcma':
      return 'Pcma'
    default:
      return null
  }
}
