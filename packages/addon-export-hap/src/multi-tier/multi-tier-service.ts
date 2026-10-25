/**
 * The three services Apple's new camera specification requires, built together
 * because none of them means anything alone.
 *
 * ## What the first attempt got wrong
 *
 * It declared `camera-multi-tier-rtp-stream-management` (0x8031) with two of
 * its eight required characteristics, and nothing else. Measured on the hub,
 * 2026-09-16: at 22:53:21 iOS read the tiers, at 22:53:23 it opened the session
 * on the CLASSIC service. That was read as "it engages and declines".
 *
 * Reading the guide closes the question differently. § 4.5: *"the presence of
 * this service and characteristic with versions as specified in this document
 * is required to signify that this camera supports the camera functionality
 * described in this specification."* `Camera Capabilities` (0x8010) is the
 * handshake, and we never sent it. iOS was not declining our tiers — it had no
 * reason to believe the accessory spoke the specification they belong to.
 *
 * So this builds all three:
 *
 *  - **Camera Capabilities** (0x8010) — the claim, with `Version = "17.99"`.
 *  - **Camera Global Operating Mode** (0x8032) — the master switches, which
 *    `Status Active` on the streaming service is defined in terms of.
 *  - **Camera Multi-Tier RTP Stream Management** (0x8031) — all eight required
 *    characteristics.
 *
 * ## Why it is honest to ship this before the negotiation exists
 *
 * The guide defines the state we are in. § 3.6: *"Status Active must be set to
 * false if ... Streaming Enabled on this service is false"*, and *"the
 * accessory must reject any request to start a stream if Status Active is set
 * to false."* An accessory that cannot serve a session yet is not a
 * half-written accessory — it is a conformant one with streaming off, and it
 * says so in the field designed to say it.
 *
 * What is NOT allowed is declaring a characteristic we cannot answer. An empty
 * string is not a valid TLV8, and the Home app reads a camera's characteristics
 * in ONE batch to draw it — one malformed member took the kitchen camera's
 * whole read down and left it on "loading". Every characteristic here answers
 * with a real value, and the two that would negotiate a session answer with the
 * specification's own explicit refusal.
 */
import {
  Characteristic,
  encode as tlvEncode,
  Formats,
  Perms,
  Service,
  type CharacteristicValue,
} from '@homebridge/hap-nodejs'
import type { IScopedLogger } from '@camstack/types'

import type { MultiTierNegotiation } from './negotiation.js'

import { encodeRtpStreamingControlStatus, RtpStreamingStatus } from './rtp-streaming-control.js'
import { encodeSetupEndpointsRefusal, SetupEndpointsStatus } from './setup-endpoints.js'
import {
  encodeAudioStreamConfiguration,
  opusTierForCapture,
  TierAudioCodec,
} from './audio-stream-tiers.js'
import {
  CAMERA_CAPABILITIES_SERVICE_UUID,
  CAMERA_CAPABILITIES_SPEC_VERSION,
  CHAR_CAMERA_CAPABILITIES,
  encodeCameraCapabilities,
  SensorIntent,
  SensorType,
  sensorUuidForDevice,
  type VideoStreamCapability,
} from './camera-capabilities.js'
import {
  encodeVideoStreamConfiguration,
  type TierVideoCodec,
  type VideoStreamTier,
} from './video-stream-tiers.js'
import { peakBitrateKbpsFor, tiersForSensor } from './tiers-for-sensor.js'

/** Service UUIDs, § 3.2 and § 3.6. */
export const MULTI_TIER_RTP_SERVICE_UUID = '00008031-0000-1000-8000-0026BB765291'
export const GLOBAL_OPERATING_MODE_SERVICE_UUID = '00008032-0000-1000-8000-0026BB765291'

/**
 * Characteristic UUIDs this specification adds.
 *
 * The RTP service and the WebRTC service each have their OWN tier
 * characteristics and they are not interchangeable — video is 0x8043 here and
 * 0x8059 there, audio is 0x8044 here and 0x805A there. Declaring a sibling's
 * UUID produces a service a controller reads and abandons with no error.
 */
export const CHAR_RTP_SUPPORTED_VIDEO_STREAM_TIERS = '00008043-0000-1000-8000-0026BB765291'
export const CHAR_RTP_SUPPORTED_AUDIO_STREAM_TIERS = '00008044-0000-1000-8000-0026BB765291'
export const CHAR_RTP_STREAMING_CONTROL = '00008045-0000-1000-8000-0026BB765291'
export const CHAR_STREAMING_ENABLED = '00008041-0000-1000-8000-0026BB765291'
export const CHAR_SENSOR_UUID = '0000805B-0000-1000-8000-0026BB765291'

/** Supported RTP Configuration, § 3.6: "must be set to AES_CM_128_HMAC_SHA1_80". */
const SRTP_CRYPTO_SUITE_TYPE = 0x02
const AES_CM_128_HMAC_SHA1_80 = 0x00

export interface MultiTierInput {
  readonly deviceId: number
  readonly logger: IScopedLogger
  /** The sensor's native size — the tier list is derived from it. */
  readonly width: number
  readonly height: number
  /** What the camera really produces. H.265 is why this service exists. */
  readonly codec: TierVideoCodec
  /** Capture rate; what goes on the wire is 48 kHz either way. */
  readonly audioCaptureRateHz: number
  /**
   * The negotiation adapter, or nothing.
   *
   * Its PRESENCE is the answer to "can this accessory serve a session" — one
   * fact, one place. An accessory with no adapter cannot negotiate by
   * construction, which makes `Status Active` false, which is the state § 3.6
   * defines and the reason a Start is refused in the specification's own
   * words. A separate `canServeStream` boolean beside it would be a second
   * authority that could disagree with the wiring.
   */
  readonly negotiation?: MultiTierNegotiation | undefined
}

export interface MultiTierServices {
  readonly capabilities: Service
  readonly globalOperatingMode: Service
  readonly streamManagement: Service
}

function tlvCharacteristic(uuid: string, name: string, writable: boolean): Characteristic {
  return new Characteristic(name, uuid, {
    format: Formats.TLV8,
    perms: writable
      ? [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY]
      : [Perms.PAIRED_READ, Perms.NOTIFY],
  })
}

/** The video configurations advertised in Camera Capabilities, from the tiers
 *  we would actually offer — one source, so the two cannot drift. */
function capabilitiesFromTiers(
  tiers: readonly VideoStreamTier[],
  deviceId: number,
): readonly VideoStreamCapability[] {
  return tiers.map((tier) => ({
    identifier: sensorUuidForDevice(deviceId * 1000 + tier.identifier),
    quality: tier.quality,
    width: tier.width,
    height: tier.height,
    framesPerSecond: tier.frameRate,
    averageBitrateKbps: tier.targetAverageBitrateKbps,
    // The guide's own ceiling for this resolution, not average x 1.1. That
    // multiplier reads as the 10% gap the guide recommends and overshoots
    // three rows of the table -- 1080p would claim 1870 against a maximum of
    // 1800, and "maximum bitrates should not be exceeded".
    peakBitrateKbps: peakBitrateKbpsFor(tier.width),
  }))
}

export function buildMultiTierServices(input: MultiTierInput): MultiTierServices {
  const { deviceId, logger } = input
  const sensorUuid = sensorUuidForDevice(deviceId)
  const tiers = tiersForSensor(input.width, input.height)

  const note = (what: string): void => {
    logger.info('hap multi-tier: controller touched a characteristic', {
      tags: { deviceId },
      meta: { characteristic: what },
    })
  }

  // ── Camera Capabilities (0x8010) — the claim ──────────────────────
  const capabilities = new Service(
    'Camera Capabilities',
    CAMERA_CAPABILITIES_SERVICE_UUID,
    'camera-capabilities',
  )
  const version = new Characteristic.Version()
  version.onGet(() => {
    note('version')
    return CAMERA_CAPABILITIES_SPEC_VERSION
  })
  capabilities.addCharacteristic(version)

  const capabilitiesValue = encodeCameraCapabilities([
    {
      sensorUuid,
      type: SensorType.PRIMARY,
      intent: SensorIntent.MAIN,
      width: input.width,
      height: input.height,
      videoStreams: capabilitiesFromTiers(tiers, deviceId),
    },
  ]).toString('base64')
  const capabilitiesChar = tlvCharacteristic(CHAR_CAMERA_CAPABILITIES, 'Camera Capabilities', false)
  capabilitiesChar.onGet(() => {
    note('camera-capabilities')
    return capabilitiesValue
  })
  capabilities.addCharacteristic(capabilitiesChar)

  // ── Camera Global Operating Mode (0x8032) — the master switches ────
  //
  // `Status Active` on the streaming service is DEFINED in terms of these, so
  // they exist even though nothing here turns the camera off: without them the
  // streaming service's central rule has no operands.
  const globalOperatingMode = new Service(
    'Camera Operating Mode',
    GLOBAL_OPERATING_MODE_SERVICE_UUID,
    'global-operating-mode',
  )
  let homeKitCameraActive = true
  const cameraActive = new Characteristic.HomeKitCameraActive()
  cameraActive.onGet(() => {
    note('homekit-camera-active')
    return homeKitCameraActive ? 1 : 0
  })
  cameraActive.onSet((value: CharacteristicValue) => {
    homeKitCameraActive = value === 1 || value === true
  })
  globalOperatingMode.addCharacteristic(cameraActive)

  let globalStreamingEnabled = true
  const globalStreaming = new Characteristic('Streaming Enabled', CHAR_STREAMING_ENABLED, {
    format: Formats.BOOL,
    perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY],
  })
  globalStreaming.onGet(() => globalStreamingEnabled)
  globalStreaming.onSet((value: CharacteristicValue) => {
    globalStreamingEnabled = value === true
  })
  globalOperatingMode.addCharacteristic(globalStreaming)

  const indicator = new Characteristic.CameraOperatingModeIndicator()
  indicator.onGet(() => 0)
  globalOperatingMode.addCharacteristic(indicator)

  // ── Camera Multi-Tier RTP Stream Management (0x8031) ───────────────
  const streamManagement = new Service(
    'CamStack multi tier',
    MULTI_TIER_RTP_SERVICE_UUID,
    'multi-tier',
  )

  let serviceStreamingEnabled = true
  const streamingEnabled = new Characteristic('Streaming Enabled', CHAR_STREAMING_ENABLED, {
    format: Formats.BOOL,
    perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE, Perms.NOTIFY],
  })
  streamingEnabled.onGet(() => {
    note('streaming-enabled')
    return serviceStreamingEnabled
  })
  streamingEnabled.onSet((value: CharacteristicValue) => {
    serviceStreamingEnabled = value === true
  })
  streamManagement.addCharacteristic(streamingEnabled)

  /**
   * § 3.6's rule, written once and read everywhere it matters.
   *
   * It is deliberately an AND over four terms rather than a stored flag: a
   * stored one would have to be invalidated from four places, and the one that
   * got forgotten would leave the accessory claiming it can stream.
   */
  const statusActive = (): boolean =>
    serviceStreamingEnabled &&
    globalStreamingEnabled &&
    homeKitCameraActive &&
    input.negotiation !== undefined

  const active = new Characteristic.StatusActive()
  active.onGet(() => {
    // The VALUE, not just the read. This is the one number that says whether
    // the accessory claims it can serve a session, and § 3.6 defines it as an
    // AND over four terms -- so when a controller declines, the log has to be
    // able to say which term was false rather than only that it asked.
    const value = statusActive()
    logger.info('hap multi-tier: status active read', {
      tags: { deviceId },
      meta: {
        value,
        serviceStreamingEnabled,
        globalStreamingEnabled,
        homeKitCameraActive,
        hasNegotiator: input.negotiation !== undefined,
      },
    })
    return value
  })
  streamManagement.addCharacteristic(active)

  const videoTiersValue = encodeVideoStreamConfiguration({
    codec: input.codec,
    // 96 is the first dynamic payload type (RFC 3551).
    payloadType: 96,
    tiers,
  }).toString('base64')
  const videoTiers = tlvCharacteristic(
    CHAR_RTP_SUPPORTED_VIDEO_STREAM_TIERS,
    'Supported Video Stream Tiers',
    false,
  )
  videoTiers.onGet(() => {
    note('supported-video-stream-tiers')
    return videoTiersValue
  })
  streamManagement.addCharacteristic(videoTiers)

  const audioTiersValue = encodeAudioStreamConfiguration({
    codec: TierAudioCodec.OPUS,
    // 110 is the payload type our own Opus offers use.
    payloadType: 110,
    tiers: [opusTierForCapture(input.audioCaptureRateHz)],
  }).toString('base64')
  const audioTiers = tlvCharacteristic(
    CHAR_RTP_SUPPORTED_AUDIO_STREAM_TIERS,
    'Supported Audio Stream Tiers',
    false,
  )
  audioTiers.onGet(() => {
    note('supported-audio-stream-tiers')
    return audioTiersValue
  })
  streamManagement.addCharacteristic(audioTiers)

  const rtpConfiguration = new Characteristic.SupportedRTPConfiguration()
  const rtpConfigurationValue = tlvEncode(
    SRTP_CRYPTO_SUITE_TYPE,
    Buffer.from([AES_CM_128_HMAC_SHA1_80]),
  ).toString('base64')
  rtpConfiguration.onGet(() => {
    note('supported-rtp-configuration')
    return rtpConfigurationValue
  })
  streamManagement.addCharacteristic(rtpConfiguration)

  // ── The two that negotiate ────────────────────────────────────────
  //
  // With an adapter they drive the same engine the classic service uses;
  // without one they answer the specification's explicit refusal. What they
  // never do is answer nothing: the Home app reads a camera's characteristics
  // in ONE batch, and one member that answers nothing took the kitchen
  // camera's whole read down and left it on "loading".
  const setupEndpoints = new Characteristic.SetupEndpoints()
  setupEndpoints.onGet(() => {
    note('setup-endpoints')
    return (
      input.negotiation?.readSetupEndpoints() ??
      encodeSetupEndpointsRefusal(SetupEndpointsStatus.ERROR)
    )
  })
  setupEndpoints.onSet(async (value: CharacteristicValue) => {
    if (input.negotiation === undefined || typeof value !== 'string') {
      logger.info('hap multi-tier: refused a setup-endpoints write', {
        tags: { deviceId },
        meta: { reason: input.negotiation === undefined ? 'no-negotiator' : 'not-a-string' },
      })
      return
    }
    await input.negotiation.handleSetupEndpointsWrite(value)
  })
  streamManagement.addCharacteristic(setupEndpoints)

  const streamingControl = new Characteristic('RTP Streaming Control', CHAR_RTP_STREAMING_CONTROL, {
    format: Formats.TLV8,
    perms: [Perms.PAIRED_READ, Perms.PAIRED_WRITE],
  })
  streamingControl.onGet(() => {
    note('rtp-streaming-control')
    return (
      input.negotiation?.readStreamingControl() ??
      encodeRtpStreamingControlStatus(null, RtpStreamingStatus.ERROR)
    )
  })
  streamingControl.onSet(async (value: CharacteristicValue) => {
    if (input.negotiation === undefined || typeof value !== 'string') {
      logger.info('hap multi-tier: refused an rtp streaming control write', {
        tags: { deviceId },
        meta: { reason: input.negotiation === undefined ? 'no-negotiator' : 'not-a-string' },
      })
      return
    }
    await input.negotiation.handleStreamingControlWrite(value)
  })
  streamManagement.addCharacteristic(streamingControl)

  const sensor = new Characteristic('Sensor UUID', CHAR_SENSOR_UUID, {
    format: Formats.DATA,
    perms: [Perms.PAIRED_READ],
  })
  const sensorValue = sensorUuid.toString('base64')
  sensor.onGet(() => {
    note('sensor-uuid')
    return sensorValue
  })
  streamManagement.addCharacteristic(sensor)

  return { capabilities, globalOperatingMode, streamManagement }
}
