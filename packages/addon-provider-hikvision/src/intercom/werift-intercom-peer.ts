/**
 * werift-backed `IntercomWebrtcPeer` impl. Audio-only sendrecv peer:
 * the browser pushes Opus mic up, we push nothing back (the talk-back
 * leg goes via the camera-side ISAPI sticky PUT, not WebRTC).
 *
 * NOTE — Phase 1 duplication: this file mirrors
 * `addon-provider-reolink/src/intercom-webrtc-peer.ts` almost verbatim.
 * The Phase 1.5 cleanup will hoist a single `WeriftIntercomPeer` into a
 * shared package both providers depend on. Cross-addon imports are
 * forbidden today (per CLAUDE.md), so duplicate-and-tag is the
 * pragmatic path until the shared lib lands.
 */

import type { IScopedLogger } from '@camstack/types'
import type { IntercomWebrtcPeer } from './intercom-orchestrator.js'

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

async function loadWerift(): Promise<WeriftModule> {
  if (_werift) return _werift
  try {
    const moduleName = 'werift'
    // eslint-disable-next-line @typescript-eslint/no-unsafe-call -- intentional dynamic import
    _werift = await (Function('m', 'return import(m)')(moduleName) as Promise<WeriftModule>)
    return _werift!
  } catch {
    throw new Error(
      "The 'werift' package is required for Hikvision intercom support but is not installed. " +
        'Install it with: npm install werift',
    )
  }
}

export interface IntercomWebrtcPeerOptions {
  readonly logger: IScopedLogger
  readonly iceServers?: readonly WeriftIceServer[]
}

export class WeriftIntercomPeer implements IntercomWebrtcPeer {
  private pc: WeriftPeerConnection | null = null
  private opusCallbacks: Array<(frame: Buffer, pts: number) => void> = []
  private iceStateCallbacks: Array<(state: string) => void> = []
  private rtpUnsubscribe: (() => void) | null = null
  private trackUnsubscribe: (() => void) | null = null
  private closed = false
  private firstRtpTimestamp: number | null = null

  constructor(private readonly opts: IntercomWebrtcPeerOptions) {}

  onOpusFrame(cb: (frame: Buffer, pts: number) => void): void {
    if (this.closed) return
    this.opusCallbacks.push(cb)
  }

  onIceStateChange(cb: (state: string) => void): void {
    if (this.closed) return
    this.iceStateCallbacks.push(cb)
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

    const localTrack = new werift.MediaStreamTrack({ kind: 'audio' })
    const transceiver = pc.addTransceiver(localTrack, { direction: 'sendrecv' })

    const trackSub = transceiver.onTrack.subscribe((track) => {
      if (track.kind !== 'audio') return
      const rtpSub = track.onReceiveRtp.subscribe((pkt) => {
        if (this.closed) return
        const payload = pkt.payload
        if (!payload || payload.length === 0) return
        const ts = pkt.header.timestamp
        if (this.firstRtpTimestamp === null) this.firstRtpTimestamp = ts
        const relTs = (ts - this.firstRtpTimestamp) >>> 0
        // Opus RTP clock is 48 kHz → ms.
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

    pc.iceConnectionStateChange.subscribe((state) => {
      this.opts.logger.info('intercom-peer: ICE state', { meta: { state } })
      for (const cb of this.iceStateCallbacks) {
        try {
          cb(state)
        } catch (err) {
          this.opts.logger.debug('intercom-peer: ICE state callback threw', {
            meta: { error: errMsg(err) },
          })
        }
      }
    })
    pc.iceGatheringStateChange.subscribe((state) => {
      this.opts.logger.debug('intercom-peer: ICE gathering', { meta: { state } })
    })

    const offer = await pc.createOffer()
    await pc.setLocalDescription(offer)
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
    this.iceStateCallbacks = []
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
