import { describe, it, expect } from 'vitest'
import { irTransmitterCapability } from '../ir-transmitter.cap.js'
import { IrTimingsSchema, TransmitSettingsSchema, IR_TIMINGS_MAX } from '../../ir/ir-timings.js'
import { DeviceRole, DeviceType } from '../../device/device-type.js'

function train(length: number): number[] {
  return Array.from({ length }, (_, i) => (i % 2 === 0 ? 500 : -500))
}

describe('IrTimingsSchema', () => {
  it('accepts alternating mark/space starting with a mark', () => {
    expect(IrTimingsSchema.safeParse([9000, -4500, 560, -560]).success).toBe(true)
  })

  it('accepts an odd-length train that ends on a mark', () => {
    expect(IrTimingsSchema.safeParse([9000, -4500, 560]).success).toBe(true)
  })

  it('rejects a train that starts with a space', () => {
    expect(IrTimingsSchema.safeParse([-9000, 4500]).success).toBe(false)
  })

  it('rejects two marks in a row', () => {
    expect(IrTimingsSchema.safeParse([9000, 4500, -560]).success).toBe(false)
  })

  it('rejects a zero duration', () => {
    expect(IrTimingsSchema.safeParse([9000, 0, 560, -560]).success).toBe(false)
  })

  it('rejects a non-integer duration', () => {
    expect(IrTimingsSchema.safeParse([9000.5, -4500]).success).toBe(false)
  })

  it('rejects a single pulse (length 1) and an empty train', () => {
    expect(IrTimingsSchema.safeParse([9000]).success).toBe(false)
    expect(IrTimingsSchema.safeParse([]).success).toBe(false)
  })

  it('bounds the length at the declared maximum', () => {
    expect(IrTimingsSchema.safeParse(train(IR_TIMINGS_MAX)).success).toBe(true)
    expect(IrTimingsSchema.safeParse(train(IR_TIMINGS_MAX + 1)).success).toBe(false)
  })
})

describe('TransmitSettingsSchema', () => {
  it('accepts an empty object (every key optional)', () => {
    expect(TransmitSettingsSchema.safeParse({}).success).toBe(true)
  })

  it('bounds duty cycle 1..100 and repeat 0..20', () => {
    expect(TransmitSettingsSchema.safeParse({ dutyCyclePercent: 0 }).success).toBe(false)
    expect(TransmitSettingsSchema.safeParse({ dutyCyclePercent: 101 }).success).toBe(false)
    expect(TransmitSettingsSchema.safeParse({ repeat: 21 }).success).toBe(false)
    expect(TransmitSettingsSchema.safeParse({ repeat: -1 }).success).toBe(false)
    expect(
      TransmitSettingsSchema.safeParse({
        carrierHz: 38000,
        dutyCyclePercent: 33,
        repeat: 2,
        repeatDelayMs: 40,
      }).success,
    ).toBe(true)
  })
})

describe('irTransmitterCapability shape', () => {
  it('is a device-native singleton on generic devices', () => {
    expect(irTransmitterCapability.name).toBe('ir-transmitter')
    expect(irTransmitterCapability.scope).toBe('device')
    expect(irTransmitterCapability.deviceNative).toBe(true)
    expect(irTransmitterCapability.deviceTypes).toContain(DeviceType.Generic)
  })

  it('has a DeviceRole for its devices', () => {
    expect(DeviceRole.IrTransmitter).toBe('ir-transmitter')
  })

  it('send answers with ok and the settings it ignored', () => {
    const out = irTransmitterCapability.methods.send.output.parse({
      ok: true,
      ignoredSettings: ['carrierHz'],
    })
    expect(out.ignoredSettings).toEqual(['carrierHz'])
  })

  it('send validates timings in its input', () => {
    const input = irTransmitterCapability.methods.send.input
    expect(input.safeParse({ deviceId: 1, timings: [500, -500] }).success).toBe(true)
    expect(input.safeParse({ deviceId: 1, timings: [-500, 500] }).success).toBe(false)
  })

  it('getInfo reports media, settable keys and the timing bound', () => {
    const out = irTransmitterCapability.methods.getInfo.output.parse({
      media: ['ir'],
      settable: ['repeat'],
      maxTimings: 512,
    })
    expect(out.media).toEqual(['ir'])
  })
})
