/**
 * RtpEgress — abstraction over "where do encoded RTP packets go?"
 *
 * Today the WebRTC viewer (`AdaptiveSession` in addon-pipeline) does
 * DTLS-SRTP via werift. Tomorrow:
 *   - HomeKit consumes the same source via HAP-derived SRTP over raw UDP;
 *     this interface is preparatory for an in-process RtpEgress there.
 *   - Alexa Echo Show speaks WebRTC over an Alexa-Smart-Home-specific
 *     signalling path; once wired, that path will instantiate its own
 *     `AlexaRtcEgress` and consume the same broker source.
 *
 * Interface = contract. Implementations own DTLS / SRTP / peer-conn
 * management. The producer (broker subscriber loop) is codec-aware
 * (it routes H.264 / H.265 packets through their respective
 * packetizers) and pushes finished RTP packets to N egresses in
 * lock-step.
 */

export interface RtpSinkAddress {
  readonly host: string
  readonly port: number
}

export interface RtpEgressStartOptions {
  /**
   * Pre-derived SRTP keying material. WebRTC egress IGNORES this
   * (DTLS produces its own SRTP keys via DTLS-SRTP key exchange).
   * HAP / Alexa-RTC egress consume it directly.
   */
  readonly srtpKeyMaterial?: Uint8Array
  /**
   * UDP sink for RTP. WebRTC egress ignores this — sockets managed
   * by the underlying peer connection.
   */
  readonly rtpSinkAddress?: RtpSinkAddress
  readonly rtcpSinkAddress?: RtpSinkAddress
}

export interface RtpEgress {
  readonly id: string
  start(opts: RtpEgressStartOptions): Promise<void>
  pushVideoRtp(rtpPacket: Uint8Array): void
  pushAudioRtp(rtpPacket: Uint8Array): void
  stop(): Promise<void>
}

export type RtpEgressKind = 'webrtc' | 'hap' | 'alexa-rtc' | 'srtp-out'
