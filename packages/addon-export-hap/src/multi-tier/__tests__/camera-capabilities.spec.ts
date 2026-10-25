/**
 * The `Camera Capabilities` TLV8 (0x8011), checked by DECODING it.
 *
 * The guide is unusually direct about what this is for: *"the presence of this
 * service and characteristic with versions as specified in this document is
 * required to signify that this camera supports the camera functionality
 * described in this specification."* It is the handshake. An accessory that
 * declares the new streaming service without it is declaring a service for a
 * specification it has not claimed to speak.
 *
 * Structure restated from § 4.5, three TLVs deep, because the nesting is the
 * part that is easy to get plausibly wrong:
 *
 *   Camera Capabilities := { 1: Version uint8, 2: Camera Sensors }
 *   Camera Sensors      := { 1: Sensor Configuration, REPEATED }
 *   Sensor Configuration:= { 1: Dimensions, 2: UUID, 3: Type, 4: Intent,
 *                            5: Video Stream Capabilities, REPEATED }
 */
import { decode, decodeWithLists } from '@homebridge/hap-nodejs'
import { describe, expect, it } from 'vitest'

import { at, field, repeated } from './tlv-assert.js'
import {
  CAMERA_CAPABILITIES_DATA_VERSION,
  encodeCameraCapabilities,
  SensorIntent,
  SensorType,
  sensorUuidForDevice,
} from '../camera-capabilities.js'
import { TierQuality } from '../video-stream-tiers.js'

const SENSOR = {
  sensorUuid: sensorUuidForDevice(101),
  type: SensorType.PRIMARY,
  intent: SensorIntent.MAIN,
  width: 2560,
  height: 1920,
  videoStreams: [
    {
      identifier: sensorUuidForDevice(101),
      quality: TierQuality.HIGH,
      width: 1920,
      height: 1080,
      framesPerSecond: 30,
      averageBitrateKbps: 1700,
      peakBitrateKbps: 1800,
    },
  ],
}

describe('encodeCameraCapabilities', () => {
  it('carries the data version and nests the sensor two levels down', () => {
    const top = decode(encodeCameraCapabilities([SENSOR]))
    expect(field(top, 1).readUInt8(0)).toBe(CAMERA_CAPABILITIES_DATA_VERSION)

    const sensors = repeated(decodeWithLists(field(top, 2))['1'], 1)
    expect(sensors).toHaveLength(1)

    const sensor = decodeWithLists(at(sensors, 0) as Buffer)
    const dims = decode(field(sensor, 1) as Buffer)
    expect(field(dims, 1).readUInt16LE(0)).toBe(2560)
    expect(field(dims, 2).readUInt16LE(0)).toBe(1920)
    expect((field(sensor, 3) as Buffer).readUInt8(0)).toBe(1)
    expect((field(sensor, 4) as Buffer).readUInt8(0)).toBe(1)
  })

  it('emits one repeated TLV per video stream, not one concatenated blob', () => {
    const two = {
      ...SENSOR,
      videoStreams: [
        at(SENSOR.videoStreams, 0),
        {
          ...at(SENSOR.videoStreams, 0),
          identifier: sensorUuidForDevice(616),
          width: 640,
          height: 360,
        },
      ],
    }
    const sensors = repeated(
      decodeWithLists(field(decode(encodeCameraCapabilities([two])), 2))['1'],
      1,
    )
    const sensor = decodeWithLists(at(sensors, 0) as Buffer)
    const streams = sensor['5']
    expect(Array.isArray(streams)).toBe(true)
    expect(repeated(streams, 5)).toHaveLength(2)

    const second = decode(at(repeated(streams, 5), 1) as Buffer)
    expect(field(second, 3).readUInt16LE(0)).toBe(640)
    expect(field(second, 6).readUInt32LE(0)).toBe(1700)
    expect(field(second, 7).readUInt32LE(0)).toBe(1800)
  })
})

describe('sensorUuidForDevice', () => {
  /**
   * The sensor UUID is `data` on the wire and must be STABLE: it is the value
   * a controller correlates a stream with, and it appears in three places
   * (Sensor UUID on the service, the sensor's own entry, and each video
   * configuration's identifier). Deriving it from the device id means it
   * survives a restart with no new state to persist.
   */
  it('is 16 bytes and stable for a device', () => {
    expect(sensorUuidForDevice(101)).toHaveLength(16)
    expect(sensorUuidForDevice(101)).toEqual(sensorUuidForDevice(101))
  })

  it('differs between devices', () => {
    expect(sensorUuidForDevice(101)).not.toEqual(sensorUuidForDevice(616))
  })
})
