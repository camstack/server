/**
 * The adapter between Apple's new characteristics and the streaming engine this
 * addon already has.
 *
 * ## Why an adapter and not a second engine
 *
 * The multi-tier RTP service owns its OWN `Setup Endpoints` and `RTP Streaming
 * Control`, so hap-nodejs's `CameraController` never negotiates for it — and
 * the library's own handlers are all `private`, so its engine cannot be
 * borrowed either. But the sockets, the SRTP contexts, the ffmpeg pipeline and
 * the teardown are the same ones the classic service uses. A second copy would
 * be two engines to keep in agreement, and this repo has paid for that shape
 * before. So: new characteristics, one engine, through `StreamNegotiator`.
 *
 * ## What is different about the new flow
 *
 * The classic `Selected RTP Stream Configuration` carries the whole selected
 * configuration in its start — codec, profile, level, resolution, bitrate.
 * `RTP Streaming Control` carries a **tier identifier**, because the
 * configuration was agreed when we published `Supported Video Stream Tiers`.
 * So this maps an identifier back to the tier WE published, and a tier we never
 * published is `No Such Stream` — improvising a geometry there would serve a
 * stream the controller did not ask for and it would look like it worked.
 *
 * ## Every path answers
 *
 * A read of either characteristic always produces a valid TLV8. The Home app
 * reads a camera's characteristics in one batch, and one member that answers
 * nothing took the kitchen camera's whole read down and left it on "loading".
 * So an engine failure, a malformed write and "nothing has happened yet" are
 * all statuses, never silence.
 */
import {
  AudioStreamingCodecType,
  AudioStreamingSamplerate,
  H264Level,
  H264Profile,
  SRTPCryptoSuites,
  StreamRequestTypes,
  VideoCodecPacketizationMode,
  VideoCodecType,
  type PrepareStreamRequest,
  type StreamingRequest,
} from '@homebridge/hap-nodejs'
import type { IScopedLogger } from '@camstack/types'

import type { StreamNegotiator } from '../mappers/builders/camera-streams.js'
import {
  decodeRtpStreamingControl,
  encodeRtpStreamingControlStatus,
  RtpStreamingCommand,
  RtpStreamingStatus,
} from './rtp-streaming-control.js'
import {
  decodeSetupEndpointsRequest,
  encodeSetupEndpointsRefusal,
  encodeSetupEndpointsResponse,
  SetupEndpointsStatus,
} from './setup-endpoints.js'
import type { TierVideoCodec, VideoStreamTier } from './video-stream-tiers.js'

/** RTP payload types. 96 is the first dynamic one (RFC 3551); 110 is what our
 *  own Opus offers use. Both are echoed in the tier declaration. */
const VIDEO_PAYLOAD_TYPE = 96
const AUDIO_PAYLOAD_TYPE = 110

/** RTCP interval in SECONDS, which is the unit the engine reads. */
const RTCP_INTERVAL_SECONDS = 5

/** The MTU the classic path uses for an Ethernet-sized path. */
const DEFAULT_MTU = 1378

export interface MultiTierNegotiationInput {
  readonly deviceId: number
  readonly logger: IScopedLogger
  readonly negotiator: StreamNegotiator
  /** The tiers we PUBLISHED. A control write names one of these by identifier. */
  readonly tiers: readonly VideoStreamTier[]
  readonly codec: TierVideoCodec
}

export interface MultiTierNegotiation {
  handleSetupEndpointsWrite(base64: string): Promise<void>
  readSetupEndpoints(): string
  handleStreamingControlWrite(base64: string): Promise<void>
  readStreamingControl(): string
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function buildMultiTierNegotiation(input: MultiTierNegotiationInput): MultiTierNegotiation {
  const { deviceId, logger, negotiator } = input
  const log = logger.withTags({ deviceId })

  // The value each characteristic reads back with. Both start as a refusal:
  // before a write there is nothing to report, and "nothing to report" still
  // has to be a parseable answer.
  let setupResponse = encodeSetupEndpointsRefusal(SetupEndpointsStatus.ERROR)
  let controlResponse = encodeRtpStreamingControlStatus(null, RtpStreamingStatus.ERROR)
  /** Sessions we have STARTED, so an End can tell "not started" from "unknown". */
  const started = new Set<string>()

  async function handleSetupEndpointsWrite(base64: string): Promise<void> {
    let sessionId: string | null = null
    try {
      const request = decodeSetupEndpointsRequest(base64)
      sessionId = request.sessionId
      const prepareRequest: PrepareStreamRequest = {
        sessionID: request.sessionId,
        // The engine picks its own local interface from `targetAddress`; the
        // source address it is given is the controller's, as on the classic
        // path.
        sourceAddress: request.controllerAddress,
        targetAddress: request.controllerAddress,
        addressVersion: request.addressVersion,
        video: {
          port: request.videoPort,
          srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
          srtp_key: request.videoSrtp.key,
          srtp_salt: request.videoSrtp.salt,
        },
        audio: {
          port: request.audioPort,
          srtpCryptoSuite: SRTPCryptoSuites.AES_CM_128_HMAC_SHA1_80,
          srtp_key: request.audioSrtp.key,
          srtp_salt: request.audioSrtp.salt,
        },
      }
      const prepared = await negotiator.prepare(prepareRequest)
      setupResponse = encodeSetupEndpointsResponse({
        sessionId: request.sessionId,
        addressVersion: request.addressVersion,
        accessoryAddress: prepared.localAddress,
        videoPort: prepared.videoPort,
        audioPort: prepared.audioPort,
        videoSrtp: { key: request.videoSrtp.key, salt: request.videoSrtp.salt },
        audioSrtp: { key: request.audioSrtp.key, salt: request.audioSrtp.salt },
        videoSsrc: prepared.videoSsrc,
        audioSsrc: prepared.audioSsrc,
      })
      log.info('hap multi-tier: endpoints prepared', {
        meta: {
          sessionId: request.sessionId,
          controller: `${request.controllerAddress}:${request.videoPort}/${request.audioPort}`,
          accessory: `${prepared.localAddress}:${prepared.videoPort}/${prepared.audioPort}`,
          videoSsrc: prepared.videoSsrc,
          audioSsrc: prepared.audioSsrc,
        },
      })
    } catch (error) {
      setupResponse = encodeSetupEndpointsRefusal(SetupEndpointsStatus.ERROR)
      log.warn('hap multi-tier: setup endpoints refused', {
        meta: { sessionId, error: errorMessage(error) },
      })
    }
  }

  async function handleStreamingControlWrite(base64: string): Promise<void> {
    let sessionId: string | null = null
    try {
      const command = decodeRtpStreamingControl(base64)
      sessionId = command.sessionId

      if (!negotiator.has(command.sessionId)) {
        controlResponse = encodeRtpStreamingControlStatus(
          command.sessionId,
          RtpStreamingStatus.UNKNOWN_SESSION_IDENTIFIER,
        )
        log.warn('hap multi-tier: control write for a session that was never prepared', {
          meta: { sessionId: command.sessionId, command: command.command },
        })
        return
      }

      if (command.command === RtpStreamingCommand.END) {
        if (!started.has(command.sessionId)) {
          // The guide names this case explicitly: "No Such Stream indicates
          // that an End command was attempted for a stream that is not
          // currently started."
          controlResponse = encodeRtpStreamingControlStatus(
            command.sessionId,
            RtpStreamingStatus.NO_SUCH_STREAM,
          )
          return
        }
        const stop: StreamingRequest = {
          sessionID: command.sessionId,
          type: StreamRequestTypes.STOP,
        }
        await negotiator.control(stop)
        started.delete(command.sessionId)
        controlResponse = encodeRtpStreamingControlStatus(
          command.sessionId,
          RtpStreamingStatus.SUCCESS,
        )
        log.info('hap multi-tier: stream ended', { meta: { sessionId: command.sessionId } })
        return
      }

      const tier = input.tiers.find((t) => t.identifier === command.videoTier)
      if (tier === undefined) {
        controlResponse = encodeRtpStreamingControlStatus(
          command.sessionId,
          RtpStreamingStatus.NO_SUCH_STREAM,
        )
        log.warn('hap multi-tier: start named a tier we never published', {
          meta: {
            sessionId: command.sessionId,
            requested: command.videoTier,
            published: input.tiers.map((t) => t.identifier),
          },
        })
        return
      }

      // The specification has the controller name SSRCs in the Start while the
      // Setup Endpoints response has the accessory name its own. We keep ours:
      // overriding them mid-stream on an ambiguous reading is riskier than
      // recording the disagreement, and this line is what will settle the
      // reading the first time a real controller disagrees.
      log.info('hap multi-tier: start ssrc comparison', {
        meta: {
          sessionId: command.sessionId,
          controllerVideoSsrc: command.videoSsrc ?? null,
          controllerAudioSsrc: command.audioSsrc ?? null,
          note: 'accessory keeps the ssrcs it advertised at setup',
        },
      })

      const start: StreamingRequest = {
        sessionID: command.sessionId,
        type: StreamRequestTypes.START,
        video: {
          // The engine does not branch on this field; the codec decision lives
          // in the encoder arguments. It is filled truthfully anyway so a
          // future reader is not told H.264 about an HEVC stream.
          codec: VideoCodecType.H264,
          profile: H264Profile.HIGH,
          level: H264Level.LEVEL4_0,
          packetizationMode: VideoCodecPacketizationMode.NON_INTERLEAVED,
          width: tier.width,
          height: tier.height,
          fps: tier.frameRate,
          pt: VIDEO_PAYLOAD_TYPE,
          ssrc: command.videoSsrc ?? 0,
          max_bit_rate: tier.targetAverageBitrateKbps,
          rtcp_interval: RTCP_INTERVAL_SECONDS,
          mtu: DEFAULT_MTU,
        },
        audio: {
          codec: AudioStreamingCodecType.OPUS,
          channel: 1,
          bit_rate: 24,
          // The engine reads this as a rate in kHz. Opus transmits at 48 kHz.
          sample_rate: AudioStreamingSamplerate.KHZ_24,
          packet_time: 20,
          pt: AUDIO_PAYLOAD_TYPE,
          ssrc: command.audioSsrc ?? 0,
          max_bit_rate: 24,
          rtcp_interval: RTCP_INTERVAL_SECONDS,
          comfort_pt: 13,
          comfortNoiseEnabled: false,
        },
      }
      await negotiator.control(start)
      started.add(command.sessionId)
      controlResponse = encodeRtpStreamingControlStatus(
        command.sessionId,
        RtpStreamingStatus.SUCCESS,
      )
      log.info('hap multi-tier: stream started', {
        meta: {
          sessionId: command.sessionId,
          tier: tier.identifier,
          geometry: `${tier.width}x${tier.height}@${tier.frameRate}`,
          targetKbps: tier.targetAverageBitrateKbps,
          codec: input.codec,
        },
      })
    } catch (error) {
      controlResponse = encodeRtpStreamingControlStatus(sessionId, RtpStreamingStatus.ERROR)
      log.warn('hap multi-tier: control write refused', {
        meta: { sessionId, error: errorMessage(error) },
      })
    }
  }

  return {
    handleSetupEndpointsWrite,
    readSetupEndpoints: () => setupResponse,
    handleStreamingControlWrite,
    readStreamingControl: () => controlResponse,
  }
}
