/**
 * `WebRtcEgress` — `RtpEgress` adapter over an existing `AdaptiveSession`.
 *
 * The session already knows how to negotiate DTLS via werift, derive
 * SRTP keys from the DTLS handshake, send RTP via
 * `videoSender.sendRtp` / `audioSender.sendRtp`, and manage PLI / RTCP /
 * keyframe cache. WE add: a stable `RtpEgress` shape so the fan-out
 * loop in the future broker `getStreamWithCodec` pipeline can speak to
 * any egress without knowing about werift or DTLS or HAP. Today this
 * adapter is opt-in — `BrokerWebrtcServer.createSession` still works
 * unchanged and the existing WebRTC viewer path doesn't go through it.
 */
import { errMsg } from '@camstack/types'
import type { RtpEgress, RtpEgressStartOptions } from '@camstack/types'
import type { Logger } from './types.js'
import type { AdaptiveSession } from './session.js'

interface WebRtcEgressOptions {
  readonly id: string
  readonly session: AdaptiveSession
  readonly logger: Logger
}

export class WebRtcEgress implements RtpEgress {
  readonly id: string
  private readonly session: AdaptiveSession
  private readonly logger: Logger
  private started = false
  private stopped = false

  constructor(opts: WebRtcEgressOptions) {
    this.id = opts.id
    this.session = opts.session
    this.logger = opts.logger
  }

  async start(opts: RtpEgressStartOptions): Promise<void> {
    if (this.started) return
    if (this.stopped) {
      throw new Error('WebRtcEgress: cannot restart after stop()')
    }
    this.started = true
    void opts
  }

  pushVideoRtp(rtpPacket: Uint8Array): void {
    if (!this.started || this.stopped) return
    try {
      const buf = Buffer.isBuffer(rtpPacket) ? rtpPacket : Buffer.from(rtpPacket)
      this.session.forwardSourceRtpVideo(buf)
    } catch (err) {
      this.logger.warn('WebRtcEgress.pushVideoRtp threw', {
        meta: { phase: 'egress', egressId: this.id, error: errMsg(err) },
      })
    }
  }

  pushAudioRtp(rtpPacket: Uint8Array): void {
    if (!this.started || this.stopped) return
    void rtpPacket
    // The session's source-driven loop handles audio. Wiring an
    // external audio push would duplicate packets on the wire.
  }

  async stop(): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    // Session lifecycle owned by BrokerWebrtcServer.
  }
}
