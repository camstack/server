import { describe, it, expect } from 'vitest'
import { userError } from '../../i18n/camstack-error.js'
import {
  irTransmitterCapability,
  irTransmitterErrorCode,
  irTransmitterStateAfter,
} from '../ir-transmitter.cap.js'
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

describe('ir-transmitter native codes and learning', () => {
  const send = irTransmitterCapability.methods.send.input
  const learn = irTransmitterCapability.methods.learn.input

  it('send takes exactly one of timings or native', () => {
    const native = { format: 'tuya', code: 'AxAAIABAAw==' }
    expect(send.safeParse({ deviceId: 1, timings: [500, -500] }).success).toBe(true)
    expect(send.safeParse({ deviceId: 1, native }).success).toBe(true)
    expect(send.safeParse({ deviceId: 1 }).success).toBe(false)
    expect(send.safeParse({ deviceId: 1, timings: [500, -500], native }).success).toBe(false)
  })

  it('learn defaults to 20 s and is bounded at 60 s', () => {
    expect(learn.parse({ deviceId: 1 }).timeoutMs).toBe(20_000)
    expect(learn.safeParse({ deviceId: 1, timeoutMs: 60_000 }).success).toBe(true)
    expect(learn.safeParse({ deviceId: 1, timeoutMs: 60_001 }).success).toBe(false)
  })

  it('getInfo defaults learn to false and formats to none for an older provider', () => {
    const info = irTransmitterCapability.methods.getInfo.output.parse({
      media: ['ir'],
      settable: [],
      maxTimings: 100,
    })
    expect(info).toMatchObject({ learn: false, formats: [] })
  })
})

const NOW = 1_700_000_000_000

describe('ir-transmitter runtime state', () => {
  it('records a refused send as not ok with the error code, and keeps the previous learn', () => {
    const previous = irTransmitterStateAfter(
      null,
      { kind: 'learn', ok: false, error: 'ir-transmitter.learn-timeout' },
      NOW,
    )
    const next = irTransmitterStateAfter(
      previous,
      { kind: 'send', ok: false, error: 'ir-transmitter.too-long', medium: 'rf' },
      NOW + 5,
    )
    expect(next.lastSend).toEqual({
      at: NOW + 5,
      ok: false,
      error: 'ir-transmitter.too-long',
      medium: 'rf',
    })
    expect(next.lastLearn).toEqual(previous.lastLearn)
    expect(irTransmitterCapability.runtimeState.safeParse(next).success).toBe(true)
  })

  it('reads the typed code off a refusal', () => {
    const err = userError('ir-transmitter.offline', { name: 'Board' }, 'offline')
    expect(irTransmitterErrorCode(err)).toBe('ir-transmitter.offline')
    expect(irTransmitterErrorCode(new Error('plain'))).toBeNull()
  })
})
