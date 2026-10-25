/**
 * The three services the new camera specification requires, and the ONE state
 * they are allowed to be in before the negotiation is wired.
 *
 * The first attempt declared `camera-multi-tier-rtp-stream-management` with two
 * of its eight required characteristics and nothing else. Measured on the hub:
 * iOS read the tiers and opened the session on the classic service two seconds
 * later. It was not rejecting the tiers — it had never been told the accessory
 * speaks this specification at all, because § 4.5 makes `Camera Capabilities`
 * the thing that says so.
 *
 * So these tests pin the two failures that are invisible on review:
 *
 *  - a REQUIRED characteristic that is missing (the guide lists eight)
 *  - a characteristic that is declared and cannot be answered — an empty TLV8
 *    took the kitchen camera's whole read down once, because the Home app reads
 *    a camera's characteristics in one batch
 *
 * and the rule that keeps the accessory honest while it cannot stream: "Status
 * Active must be set to false if Streaming Enabled on this service is false",
 * and "the accessory must reject any request to start a stream if Status Active
 * is set to false".
 */
import { Characteristic, decode } from '@homebridge/hap-nodejs'
import { field } from './tlv-assert.js'
import { describe, expect, it, vi } from 'vitest'

import {
  CAMERA_CAPABILITIES_SPEC_VERSION,
  CHAR_CAMERA_CAPABILITIES,
} from '../camera-capabilities.js'
import {
  buildMultiTierServices,
  CHAR_RTP_STREAMING_CONTROL,
  CHAR_RTP_SUPPORTED_AUDIO_STREAM_TIERS,
  CHAR_RTP_SUPPORTED_VIDEO_STREAM_TIERS,
  CHAR_SENSOR_UUID,
  CHAR_STREAMING_ENABLED,
} from '../multi-tier-service.js'
import { TierVideoCodec } from '../video-stream-tiers.js'

function fakeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }
}

/** A negotiation adapter that exists. Its PRESENCE is what the service reads;
 *  none of its methods are exercised here — the adapter has its own spec. */
function fakeNegotiation() {
  return {
    handleSetupEndpointsWrite: vi.fn(async () => undefined),
    readSetupEndpoints: () => 'AgEC',
    handleStreamingControlWrite: vi.fn(async () => undefined),
    readStreamingControl: () => 'AgEE',
  }
}

function build(overrides: Record<string, unknown> = {}) {
  return buildMultiTierServices({
    deviceId: 101,
    logger: fakeLogger() as never,
    width: 2560,
    height: 1920,
    codec: TierVideoCodec.H265,
    audioCaptureRateHz: 16000,
    ...overrides,
  })
}

/** § 3.6 — every one of these is listed as Required. */
const REQUIRED_ON_STREAM_MANAGEMENT = [
  CHAR_STREAMING_ENABLED,
  Characteristic.StatusActive.UUID,
  CHAR_RTP_SUPPORTED_VIDEO_STREAM_TIERS,
  CHAR_RTP_SUPPORTED_AUDIO_STREAM_TIERS,
  Characteristic.SupportedRTPConfiguration.UUID,
  Characteristic.SetupEndpoints.UUID,
  CHAR_RTP_STREAMING_CONTROL,
  CHAR_SENSOR_UUID,
]

describe('the multi-tier RTP service', () => {
  it('declares every characteristic the guide lists as required', () => {
    const declared = new Set(
      build().streamManagement.characteristics.map((c) => c.UUID.toUpperCase()),
    )
    for (const uuid of REQUIRED_ON_STREAM_MANAGEMENT) {
      expect(declared.has(uuid.toUpperCase()), `missing ${uuid}`).toBe(true)
    }
  })

  it('answers every declared characteristic with a value, never an empty string', async () => {
    const service = build().streamManagement
    for (const characteristic of service.characteristics) {
      const value = await characteristic.handleGetRequest()
      expect(value, `${characteristic.displayName} answered nothing`).not.toBe('')
      expect(value, `${characteristic.displayName} answered undefined`).not.toBeUndefined()
    }
  })
})

describe('status active follows what we can actually serve', () => {
  it('is false while the negotiation cannot be completed', async () => {
    const service = build().streamManagement
    const active = service.getCharacteristic(Characteristic.StatusActive)
    expect(await active.handleGetRequest()).toBe(false)
  })

  it('is true only when streaming is enabled AND we can serve', async () => {
    const service = build({ negotiation: fakeNegotiation() }).streamManagement
    const active = service.getCharacteristic(Characteristic.StatusActive)
    expect(await active.handleGetRequest()).toBe(true)
  })

  it('goes false again when the controller disables streaming', async () => {
    const service = build({ negotiation: fakeNegotiation() }).streamManagement
    const enabled = service.characteristics.find(
      (c) => c.UUID.toUpperCase() === CHAR_STREAMING_ENABLED,
    )
    await enabled?.handleSetRequest(false)
    const active = service.getCharacteristic(Characteristic.StatusActive)
    expect(await active.handleGetRequest()).toBe(false)
  })
})

describe('a refusal is a VALID tlv8, not silence', () => {
  it('answers setup-endpoints with an explicit error status', async () => {
    const service = build().streamManagement
    const setup = service.getCharacteristic(Characteristic.SetupEndpoints)
    await setup.handleSetRequest('AQEB')
    const response = decode(Buffer.from((await setup.handleGetRequest()) as string, 'base64'))
    // Type 2 is Status; 2 is Error.
    expect(field(response, 2).readUInt8(0)).toBe(2)
  })

  it('answers a start command with a status the controller can read', async () => {
    const service = build().streamManagement
    const control = service.characteristics.find(
      (c) => c.UUID.toUpperCase() === CHAR_RTP_STREAMING_CONTROL,
    )
    await control?.handleSetRequest('AQEB')
    const response = decode(Buffer.from((await control?.handleGetRequest()) as string, 'base64'))
    // Type 2 is Status; 4 is Error.
    expect(field(response, 2).readUInt8(0)).toBe(4)
  })
})

describe('the camera capabilities service', () => {
  it('carries the spec version string the guide names', async () => {
    const service = build().capabilities
    const version = service.getCharacteristic(Characteristic.Version)
    expect(await version.handleGetRequest()).toBe(CAMERA_CAPABILITIES_SPEC_VERSION)
  })

  it('carries the capabilities tlv itself', () => {
    const declared = build().capabilities.characteristics.map((c) => c.UUID.toUpperCase())
    expect(declared).toContain(CHAR_CAMERA_CAPABILITIES.toUpperCase())
  })
})

describe('the global operating mode service', () => {
  it('declares the three characteristics the guide requires', () => {
    const declared = new Set(
      build().globalOperatingMode.characteristics.map((c) => c.UUID.toUpperCase()),
    )
    expect(declared.has(Characteristic.HomeKitCameraActive.UUID.toUpperCase())).toBe(true)
    expect(declared.has(CHAR_STREAMING_ENABLED.toUpperCase())).toBe(true)
    expect(declared.has(Characteristic.CameraOperatingModeIndicator.UUID.toUpperCase())).toBe(true)
  })
})
