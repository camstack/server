/**
 * `Camera Capabilities` — the handshake that says "I speak the new camera
 * specification".
 *
 * The guide, § 4.5, is explicit: *"the presence of this service and
 * characteristic with versions as specified in this document is required to
 * signify that this camera supports the camera functionality described in this
 * specification."*
 *
 * That sentence is the diagnosis of this addon's first attempt. We declared
 * `camera-multi-tier-rtp-stream-management` and nothing else, and iOS read its
 * tiers and opened the session on the classic service two seconds later. It was
 * not refusing the tiers; it had never been told the accessory speaks the
 * specification the tiers belong to.
 *
 * ## Two different versions, and they are not interchangeable
 *
 *  - The SERVICE (0x8010) carries `Version`, a **string**, whose value is the
 *    specification revision: `"17.99"`.
 *  - The CHARACTERISTIC (0x8011) carries `Version`, a **uint8**, which versions
 *    the TLV layout below it.
 *
 * ## The sensor UUID
 *
 * `data` on the wire, and it must be stable across restarts: a controller
 * correlates a stream with it, and it appears in three places. Deriving it from
 * the device id makes it stable with nothing to persist and nothing to lose.
 */
import { createHash } from 'node:crypto'

import { encode } from '@homebridge/hap-nodejs'

import type { TierQuality } from './video-stream-tiers.js'

/** Service and characteristic UUIDs, § 3.1 and § 4.5. */
export const CAMERA_CAPABILITIES_SERVICE_UUID = '00008010-0000-1000-8000-0026BB765291'
export const CHAR_CAMERA_CAPABILITIES = '00008011-0000-1000-8000-0026BB765291'

/**
 * The specification revision, as the SERVICE's `Version` string.
 *
 * The guide notes this "may be updated prior to release". When it is, this is
 * the one place to change — and a controller that wants a newer revision will
 * decline rather than misbehave, which is the failure we can see.
 */
export const CAMERA_CAPABILITIES_SPEC_VERSION = '17.99'

/** The version of the TLV layout inside the characteristic. */
export const CAMERA_CAPABILITIES_DATA_VERSION = 1

export enum SensorType {
  UNKNOWN = 0,
  PRIMARY = 1,
  GENERIC = 255,
}

export enum SensorIntent {
  UNKNOWN = 0,
  MAIN = 1,
  PACKAGE = 2,
  GENERIC = 255,
}

enum CapabilitiesTlv {
  VERSION = 0x01,
  CAMERA_SENSORS = 0x02,
}

enum SensorsTlv {
  CAMERA_SENSORS = 0x01,
}

enum SensorConfigTlv {
  DIMENSIONS = 0x01,
  SENSOR_UUID = 0x02,
  SENSOR_TYPE = 0x03,
  SENSOR_INTENT = 0x04,
  VIDEO_STREAM_CAPABILITIES = 0x05,
}

enum DimensionsTlv {
  WIDTH = 0x01,
  HEIGHT = 0x02,
}

enum VideoStreamCapabilityTlv {
  IDENTIFIER = 0x01,
  VIDEO_QUALITY = 0x02,
  WIDTH = 0x03,
  HEIGHT = 0x04,
  FRAMES_PER_SECOND = 0x05,
  AVERAGE_BIT_RATE = 0x06,
  PEAK_BIT_RATE = 0x07,
}

export interface VideoStreamCapability {
  /** A UUID identifying this video configuration. */
  readonly identifier: Buffer
  readonly quality: TierQuality
  readonly width: number
  readonly height: number
  readonly framesPerSecond: number
  readonly averageBitrateKbps: number
  readonly peakBitrateKbps: number
}

export interface SensorConfiguration {
  readonly sensorUuid: Buffer
  readonly type: SensorType
  readonly intent: SensorIntent
  /** The sensor's own size in pixels — the frame the camera really produces,
   *  not the size of any stream derived from it. */
  readonly width: number
  readonly height: number
  readonly videoStreams: readonly VideoStreamCapability[]
}

function uint8(value: number): Buffer {
  const b = Buffer.alloc(1)
  b.writeUInt8(value, 0)
  return b
}

function uint16(value: number): Buffer {
  const b = Buffer.alloc(2)
  b.writeUInt16LE(value, 0)
  return b
}

function uint32(value: number): Buffer {
  const b = Buffer.alloc(4)
  b.writeUInt32LE(value, 0)
  return b
}

/**
 * A stable 16-byte sensor UUID for a device.
 *
 * Hashed rather than random so that it survives a restart without being
 * persisted — a value we would have to store is a value that can go missing
 * while the accessory that references it does not.
 */
export function sensorUuidForDevice(deviceId: number): Buffer {
  return createHash('sha256').update(`camstack:hap:sensor:${deviceId}`).digest().subarray(0, 16)
}

export function encodeVideoStreamCapability(capability: VideoStreamCapability): Buffer {
  return encode(
    VideoStreamCapabilityTlv.IDENTIFIER,
    capability.identifier,
    VideoStreamCapabilityTlv.VIDEO_QUALITY,
    uint8(capability.quality),
    VideoStreamCapabilityTlv.WIDTH,
    uint16(capability.width),
    VideoStreamCapabilityTlv.HEIGHT,
    uint16(capability.height),
    VideoStreamCapabilityTlv.FRAMES_PER_SECOND,
    uint8(capability.framesPerSecond),
    VideoStreamCapabilityTlv.AVERAGE_BIT_RATE,
    uint32(capability.averageBitrateKbps),
    VideoStreamCapabilityTlv.PEAK_BIT_RATE,
    uint32(capability.peakBitrateKbps),
  )
}

export function encodeSensorConfiguration(sensor: SensorConfiguration): Buffer {
  return encode(
    SensorConfigTlv.DIMENSIONS,
    encode(DimensionsTlv.WIDTH, uint16(sensor.width), DimensionsTlv.HEIGHT, uint16(sensor.height)),
    SensorConfigTlv.SENSOR_UUID,
    sensor.sensorUuid,
    SensorConfigTlv.SENSOR_TYPE,
    uint8(sensor.type),
    SensorConfigTlv.SENSOR_INTENT,
    uint8(sensor.intent),
    // Repeated — an array emits one TLV of this type per element.
    SensorConfigTlv.VIDEO_STREAM_CAPABILITIES,
    sensor.videoStreams.map(encodeVideoStreamCapability),
  )
}

export function encodeCameraCapabilities(sensors: readonly SensorConfiguration[]): Buffer {
  return encode(
    CapabilitiesTlv.VERSION,
    uint8(CAMERA_CAPABILITIES_DATA_VERSION),
    CapabilitiesTlv.CAMERA_SENSORS,
    encode(SensorsTlv.CAMERA_SENSORS, sensors.map(encodeSensorConfiguration)),
  )
}
