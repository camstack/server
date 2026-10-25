/**
 * Relay-only werift peer helper.
 *
 * Builds a werift {@link RTCPeerConnection} forced onto a TURN relay
 * (`iceTransportPolicy: 'relay'`) so the relay is the ONLY possible media
 * path, then exposes a minimal send / receive surface over a single VP8
 * track. The werift module is a PARAMETER (`typeof import('werift')`), never
 * a static import, so the SAME helper runs unchanged against:
 *   - upstream `werift@0.22.9` (the bug — media never reaches the receiver),
 *   - `@koush/werift` (the oracle fork that DOES relay), and
 *   - a later locally-patched werift.
 *
 * This is the ONLY file in the package that touches werift's media API; the
 * acceptance spec stays declarative.
 *
 * Pass `options` to override the ICE transport policy and/or ice servers.
 * When omitted, defaults to `policy: 'relay'` and `iceServers: [iceServer]`
 * (the third positional arg), preserving full backward-compatibility for all
 * existing callers.
 */

/** ICE server descriptor (subset of werift's `RTCIceServer`). */
export interface IceServer {
  urls: string
  username?: string
  credential?: string
}

/** Which half of the relay-only flow a peer plays. */
export type RelayRole = 'sender' | 'receiver'

/**
 * Optional overrides for {@link createRelayPeer}.
 *
 * - `policy` — ICE transport policy. Defaults to `'relay'` (forced TURN).
 *   Pass `'all'` for the normal host/srflx/relay path.
 * - `iceServers` — List of ICE servers to use. Defaults to `[iceServer]`
 *   (the third positional arg). Pass `[]` to use no TURN/STUN servers and
 *   rely on host-path gathering only.
 */
export interface CreateRelayPeerOptions {
  policy?: 'relay' | 'all'
  iceServers?: IceServer[]
}

/** Inbound-RTP-payload-length callback (receiver side). */
export type RtpLenCallback = (len: number) => void

/**
 * Minimal relay-only peer. The werift module is injected so the helper is
 * implementation-agnostic; `pc` is exposed for diagnostics (ICE/gathering
 * state inspection in tests).
 */
export interface RelayPeer {
  pc: import('werift').RTCPeerConnection
  /** Register a callback fired with each inbound RTP packet's payload length (receiver side). */
  onRtpLen: (cb: RtpLenCallback) => void
  /** Send one RTP packet carrying `payload` (sender side). */
  sendRtp: (payload: Uint8Array) => void
  /** Offerer → offer SDP / answerer → answer SDP, after ICE gather completes. */
  localDescription: () => Promise<string>
  /** Apply the peer's remote description (offerer applies the answer, answerer applies the offer). */
  setRemote: (sdp: string) => Promise<void>
  /** Close the underlying connection, swallowing errors. */
  close: () => Promise<void>
}

/** Single negotiated video codec, identical on both peers (payloadType 96). */
const VIDEO_PAYLOAD_TYPE = 96
const FIXED_SSRC = 0x1234abcd
const TIMESTAMP_STEP = 3000
const SEQ_WRAP = 0x10000
const GATHER_TIMEOUT_MS = 5000

function buildPcOptions(
  wrtc: typeof import('werift'),
  options: Required<CreateRelayPeerOptions>,
): Partial<import('werift').PeerConfig> {
  const videoCodec = new wrtc.RTCRtpCodecParameters({
    mimeType: 'video/VP8',
    clockRate: 90000,
    payloadType: VIDEO_PAYLOAD_TYPE,
  })
  return {
    codecs: { video: [videoCodec], audio: [] },
    headerExtensions: { video: [], audio: [] },
    iceServers: options.iceServers,
    iceTransportPolicy: options.policy,
  }
}

/**
 * Resolve once ICE gathering has produced its full candidate set, so the
 * returned SDP is non-trickle (carries every candidate). Falls back after
 * {@link GATHER_TIMEOUT_MS} so a stalled gather can't deadlock the test.
 */
function waitForGatherComplete(pc: import('werift').RTCPeerConnection): Promise<void> {
  return new Promise<void>((resolve) => {
    if (pc.iceGatheringState === 'complete') {
      resolve()
      return
    }
    const sub = pc.iceGatheringStateChange.subscribe((state) => {
      if (state === 'complete') {
        sub.unSubscribe()
        resolve()
      }
    })
    setTimeout(() => {
      sub.unSubscribe()
      resolve()
    }, GATHER_TIMEOUT_MS)
  })
}

function createSender(
  wrtc: typeof import('werift'),
  pc: import('werift').RTCPeerConnection,
): Pick<RelayPeer, 'sendRtp' | 'localDescription' | 'setRemote'> {
  const track = new wrtc.MediaStreamTrack({ kind: 'video' })
  const transceiver = pc.addTransceiver(track, { direction: 'sendonly' })
  const sender = transceiver.sender

  let sequenceNumber = 0
  let timestamp = 0

  return {
    sendRtp: (payload: Uint8Array): void => {
      const header = new wrtc.RtpHeader()
      header.payloadType = VIDEO_PAYLOAD_TYPE
      header.sequenceNumber = sequenceNumber
      header.timestamp = timestamp
      header.ssrc = FIXED_SSRC
      header.marker = true
      sequenceNumber = (sequenceNumber + 1) % SEQ_WRAP
      timestamp = (timestamp + TIMESTAMP_STEP) >>> 0
      void sender.sendRtp(new wrtc.RtpPacket(header, Buffer.from(payload)))
    },
    localDescription: async (): Promise<string> => {
      const offer = await pc.createOffer()
      await pc.setLocalDescription(offer)
      await waitForGatherComplete(pc)
      return pc.localDescription?.sdp ?? offer.sdp
    },
    setRemote: async (sdp: string): Promise<void> => {
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp, 'answer'))
    },
  }
}

function createReceiver(
  wrtc: typeof import('werift'),
  pc: import('werift').RTCPeerConnection,
  onRtpLen: () => RtpLenCallback | null,
): Pick<RelayPeer, 'localDescription' | 'setRemote'> {
  const track = new wrtc.MediaStreamTrack({ kind: 'video' })
  const transceiver = pc.addTransceiver(track, { direction: 'recvonly' })
  transceiver.onTrack.subscribe((inbound) => {
    inbound.onReceiveRtp.subscribe((pkt) => {
      const cb = onRtpLen()
      if (cb) cb(pkt.payload.length)
    })
  })

  return {
    setRemote: async (sdp: string): Promise<void> => {
      await pc.setRemoteDescription(new wrtc.RTCSessionDescription(sdp, 'offer'))
    },
    localDescription: async (): Promise<string> => {
      const answer = await pc.createAnswer()
      await pc.setLocalDescription(answer)
      await waitForGatherComplete(pc)
      return pc.localDescription?.sdp ?? answer.sdp
    },
  }
}

/**
 * Build a werift peer in the given `role`.
 *
 * By default the connection is forced onto the supplied TURN server with
 * `iceTransportPolicy: 'relay'`; a single VP8 codec (pt 96) is configured on
 * both video directions so the negotiated payload type matches the peer.
 *
 * Pass `options` to override the ICE transport policy and/or the set of ICE
 * servers. When `options` is omitted, defaults are `policy: 'relay'` and
 * `iceServers: [iceServer]`, so all existing callers are unaffected.
 *
 * @example Host-path (regression guard — no TURN, default policy):
 * ```ts
 * const peer = await createRelayPeer(wrtc, DUMMY_SERVER, 'sender', {
 *   policy: 'all',
 *   iceServers: [],
 * })
 * ```
 */
export async function createRelayPeer(
  wrtc: typeof import('werift'),
  iceServer: IceServer,
  role: RelayRole,
  options?: CreateRelayPeerOptions,
): Promise<RelayPeer> {
  const resolvedOptions: Required<CreateRelayPeerOptions> = {
    policy: options?.policy ?? 'relay',
    iceServers: options?.iceServers ?? [iceServer],
  }
  const pc = new wrtc.RTCPeerConnection(buildPcOptions(wrtc, resolvedOptions))

  let rtpLenCb: RtpLenCallback | null = null
  const onRtpLen = (cb: RtpLenCallback): void => {
    rtpLenCb = cb
  }

  const close = async (): Promise<void> => {
    try {
      await pc.close()
    } catch {
      // closing is best-effort: a half-open PC must never fail teardown.
    }
  }

  if (role === 'sender') {
    const half = createSender(wrtc, pc)
    return {
      pc,
      onRtpLen,
      sendRtp: half.sendRtp,
      localDescription: half.localDescription,
      setRemote: half.setRemote,
      close,
    }
  }

  const half = createReceiver(wrtc, pc, () => rtpLenCb)
  return {
    pc,
    onRtpLen,
    sendRtp: (): void => {
      throw new Error('sendRtp is sender-only')
    },
    localDescription: half.localDescription,
    setRemote: half.setRemote,
    close,
  }
}
