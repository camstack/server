/**
 * Concrete `IntercomWebrtcPeer` impl backed by werift.
 *
 * Audio-only `RTCPeerConnection`:
 *   - One audio transceiver, direction `sendrecv` so the browser can
 *     push mic-Opus to us. The server doesn't actually send audio
 *     down (no `replaceTrack` / no outgoing audio frames) — Reolink's
 *     intercom is camera-driven on the receive side, our talk-back
 *     leg is the upstream Baichuan ADPCM channel, not WebRTC.
 *   - No video track / no video transceiver. Saves a few hundred ms of
 *     handshake time + avoids edge cases where Chrome rejects an
 *     audio-only m-line offer that's missing video lines (it doesn't
 *     — pure audio is well-supported, but worth flagging if we ever
 *     see SDP weirdness).
 *
 * Lifecycle:
 *   1. `createOffer()` — lazy-loads werift, builds the peer + audio
 *      transceiver, subscribes to `onTrack.onReceiveRtp` so Opus
 *      payloads route straight to the registered callback. Returns
 *      the local SDP for the cap router to surface to the client.
 *   2. `setAnswer(sdp)` — applies remote description; ICE proceeds.
 *   3. `close()` — best-effort `pc.close()` + clears state.
 *
 * No PLI / NACK / FIR handling: there's no video involved and Opus
 * has its own FEC + PLC, so RTCP feedback isn't useful here. The
 * impl is therefore much smaller than the broker's `AdaptiveSession`
 * (~150 LOC vs ~1.5k LOC).
 *
 * werift is loaded via `Function('m', 'return import(m)')(...)` to
 * avoid bundler static-analysis pulling it into builds where it's
 * not installed (the broker uses the same dance — see
 * `addon-stream-broker/src/webrtc/session.ts:loadWerift`).
 */

import type { IScopedLogger } from '@camstack/types'
import type { IntercomWebrtcPeer } from './intercom-orchestrator.js'

/** Minimal werift surface this file relies on. We type-shadow the
 *  module rather than `import type` from werift directly because
 *  werift ships with no published `.d.ts` and the broker's own
 *  `werift-types.ts` lives in another package. Duplicating the few
 *  shapes we need keeps this file self-contained. */
interface WeriftRtpPacket {
  payload: Buffer
  header: { timestamp: number; sequenceNumber: number }
}
interface WeriftMediaStreamTrack {
  kind: 'audio' | 'video'
  onReceiveRtp: {
    subscribe(cb: (pkt: WeriftRtpPacket) => void): { unsubscribe?: () => void } | void
  }
}
interface WeriftTransceiver {
  onTrack: {
    subscribe(cb: (track: WeriftMediaStreamTrack) => void): { unsubscribe?: () => void } | void
  }
}
interface WeriftSessionDescription {
  sdp: string
  type: 'offer' | 'answer' | 'pranswer' | 'rollback'
}
interface WeriftPeerConnection {
  createOffer(): Promise<WeriftSessionDescription>
  setLocalDescription(desc: WeriftSessionDescription): Promise<void>
  setRemoteDescription(desc: WeriftSessionDescription): Promise<void>
  addTransceiver(
    track: WeriftMediaStreamTrack | string,
    options: { direction: 'sendrecv' | 'recvonly' | 'sendonly' | 'inactive' },
  ): WeriftTransceiver
  iceConnectionStateChange: {
    subscribe(cb: (state: string) => void): { unsubscribe?: () => void } | void
  }
  iceGatheringStateChange: {
    subscribe(cb: (state: string) => void): { unsubscribe?: () => void } | void
  }
  localDescription: WeriftSessionDescription | null
  close(): Promise<void> | void
}
interface WeriftModule {
  RTCPeerConnection: new (options?: WeriftPcOptions) => WeriftPeerConnection
  MediaStreamTrack: new (init: { kind: 'audio' | 'video' }) => WeriftMediaStreamTrack
  RTCIceCandidate?: unknown
}
interface WeriftIceServer {
  urls: string
  username?: string
  credential?: string
}
interface WeriftPcOptions {
  iceServers?: WeriftIceServer[]
  iceTransportPolicy?: 'all' | 'relay'
}

let _werift: WeriftModule | undefined

/**
 * Lazy import — werift is an optional peer dep of this package
 * (declared via peerDependenciesMeta so npm install doesn't fail on
 * agents/clusters where the intercom is never used).
 */
async function loadWerift(): Promise<WeriftModule> {
  if (_werift) return _werift
  try {
    const moduleName = 'werift'
    // Dynamic import via Function to avoid bundler static analysis —
    // mirrors the broker's `loadWerift`. tsup's tree-shaker won't
    // resolve `Function('m', 'return import(m)')(...)` so the dep
    // stays optional at build time.
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- intentional dynamic import
    _werift = await (Function('m', 'return import(m)')(moduleName) as Promise<WeriftModule>)
    return _werift!
  } catch {
    throw new Error(
      "The 'werift' package is required for Reolink intercom support but is not installed. " +
        'Install it with: npm install werift',
    )
  }
}

export interface IntercomWebrtcPeerOptions {
  readonly logger: IScopedLogger
  /** STUN / TURN servers to advertise in the SDP. Empty array =
   *  host-only (LAN-only intercom). */
  readonly iceServers?: readonly WeriftIceServer[]
}

export class WeriftIntercomPeer implements IntercomWebrtcPeer {
  private pc: WeriftPeerConnection | null = null
  private opusCallbacks: Array<(frame: Buffer, pts: number) => void> = []
  private rtpUnsubscribe: (() => void) | null = null
  private trackUnsubscribe: (() => void) | null = null
  private closed = false
  /** Anchor PTS to the first observed RTP timestamp so the audio-
   *  codec receives monotonically-increasing PTS values from zero
   *  rather than the camera's free-running 32-bit RTP clock. */
  private firstRtpTimestamp: number | null = null

  constructor(private readonly opts: IntercomWebrtcPeerOptions) {}

  onOpusFrame(cb: (frame: Buffer, pts: number) => void): void {
    if (this.closed) return
    this.opusCallbacks.push(cb)
  }

  async createOffer(): Promise<{ sdp: string }> {
    if (this.pc) throw new Error('WeriftIntercomPeer: createOffer called twice')
    const werift = await loadWerift()
    const pcOptions: WeriftPcOptions = {}
    if (this.opts.iceServers && this.opts.iceServers.length > 0) {
      pcOptions.iceServers = [...this.opts.iceServers]
    }
    const pc = new werift.RTCPeerConnection(pcOptions)
    this.pc = pc

    // Audio-only sendrecv transceiver. The local track placeholder is
    // a dummy `MediaStreamTrack({kind:'audio'})` — werift requires
    // it to materialise the m-line in the offer SDP. We never emit
    // RTP on the local sender; the camera-side talk back goes
    // through the Baichuan ADPCM channel (`ReolinkIntercomSession`),
    // not this WebRTC peer.
    const localTrack = new werift.MediaStreamTrack({ kind: 'audio' })
    const transceiver = pc.addTransceiver(localTrack, { direction: 'sendrecv' })

    // Wire the remote-track receiver. The Opus payload is everything
    // in the RTP `payload` field — werift exposes the wire bytes
    // without re-packetizing, which is exactly what the audio-codec
    // cap accepts (one frame per RTP packet).
    const trackSub = transceiver.onTrack.subscribe((track) => {
      if (track.kind !== 'audio') return
      const rtpSub = track.onReceiveRtp.subscribe((pkt) => {
        if (this.closed) return
        const payload = pkt.payload
        if (!payload || payload.length === 0) return
        // Anchor PTS at the first RTP packet — relative timestamps
        // are easier for the audio-codec session to interpret +
        // avoid wraparound concerns at the 32-bit boundary.
        const ts = pkt.header.timestamp
        if (this.firstRtpTimestamp === null) this.firstRtpTimestamp = ts
        const relTs = (ts - this.firstRtpTimestamp) >>> 0
        // RTP timestamp clock for Opus is 48 kHz — convert to ms.
        const ptsMs = Math.round(relTs / 48)
        for (const cb of this.opusCallbacks) {
          try {
            cb(payload, ptsMs)
          } catch (err) {
            this.opts.logger.debug('intercom-peer: opus callback threw', {
              meta: { error: errMsg(err) },
            })
          }
        }
      })
      if (rtpSub && typeof rtpSub.unsubscribe === 'function') {
        this.rtpUnsubscribe = () => rtpSub.unsubscribe?.()
      }
    })
    if (trackSub && typeof trackSub.unsubscribe === 'function') {
      this.trackUnsubscribe = () => trackSub.unsubscribe?.()
    }

    // ICE state logging — info-level so a stuck `checking` is
    // visible without flipping a debug flag (mirrors the broker's
    // session for symmetry).
    pc.iceConnectionStateChange.subscribe((state) => {
      this.opts.logger.info('intercom-peer: ICE state', { meta: { state } })
    })
    pc.iceGatheringStateChange.subscribe((state) => {
      this.opts.logger.debug('intercom-peer: ICE gathering', { meta: { state } })
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
    // Use the local description after `setLocalDescription` — werift
    // populates fingerprints + ICE-ufrag/pwd at that point. Returning
    // the raw offer (pre-set) would emit a placeholder fingerprint
    // and the browser would reject the answer.
    const localSdp = pc.localDescription?.sdp ?? offer.sdp
    return { sdp: localSdp }
  }

  async setAnswer(sdp: string): Promise<void> {
    if (!this.pc) throw new Error('WeriftIntercomPeer: setAnswer called before createOffer')
    if (this.closed) throw new Error('WeriftIntercomPeer: setAnswer called on closed peer')
    await this.pc.setRemoteDescription({ sdp, type: 'answer' })
  }

  async close(): Promise<void> {
    if (this.closed) return
    this.closed = true
    this.opusCallbacks = []
    if (this.rtpUnsubscribe) {
      try {
        this.rtpUnsubscribe()
      } catch {
        /* swallow */
      }
      this.rtpUnsubscribe = null
    }
    if (this.trackUnsubscribe) {
      try {
        this.trackUnsubscribe()
      } catch {
        /* swallow */
      }
      this.trackUnsubscribe = null
    }
    if (this.pc) {
      try {
        await Promise.resolve(this.pc.close())
      } catch {
        /* swallow */
      }
      this.pc = null
    }
  }
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
