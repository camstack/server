import { describe, expect, it } from 'vitest'
import {
  decodeBinary,
  decodeCover,
  decodeNumber,
  decodeSwitch,
  decodeText,
  decodeBrightnessPercent,
  COVER_OPERATION_IDLE,
  COVER_OPERATION_OPENING,
  COVER_OPERATION_CLOSING,
} from '../esphome-decode.js'

describe('absent means the protobuf default', () => {
  it('a switch with no state field is OFF, not unknown', () => {
    expect(decodeSwitch({ type: 'switch', id: 'switch-r1' })).toBe(false)
    expect(decodeSwitch({ type: 'switch', id: 'switch-r1', state: true })).toBe(true)
  })

  it('a binary sensor with no state field is false', () => {
    expect(decodeBinary({ type: 'binary_sensor', id: 'binary_sensor-d' })).toBe(false)
  })

  it('a sensor with no state field reads 0, a sensor flagged missing reads null', () => {
    expect(decodeNumber({ type: 'sensor', id: 'sensor-w' })).toBe(0)
    expect(decodeNumber({ type: 'sensor', id: 'sensor-w', missingState: true })).toBeNull()
  })

  it('NaN and infinity are a failed measurement, never a number', () => {
    expect(decodeNumber({ type: 'sensor', id: 'sensor-w', state: Number.NaN })).toBeNull()
    expect(decodeNumber({ type: 'sensor', id: 'sensor-w', state: Infinity })).toBeNull()
  })

  it('text: absent is the empty string, missing is null', () => {
    expect(decodeText({ type: 'text_sensor', id: 'text_sensor-x' })).toBe('')
    expect(decodeText({ type: 'text_sensor', id: 'text_sensor-x', missingState: true })).toBeNull()
  })

  it('a cover with no fields is idle and closed', () => {
    expect(decodeCover({ type: 'cover', id: 'cover-c' })).toEqual({ state: 'closed', position: 0 })
  })

  it('a cover reports its movement before its position', () => {
    expect(
      decodeCover({
        type: 'cover',
        id: 'cover-c',
        position: 0.4,
        currentOperation: COVER_OPERATION_OPENING,
      }),
    ).toEqual({ state: 'opening', position: 40 })
    expect(
      decodeCover({
        type: 'cover',
        id: 'cover-c',
        position: 0.4,
        currentOperation: COVER_OPERATION_CLOSING,
      }),
    ).toEqual({ state: 'closing', position: 40 })
  })

  it('an idle cover is open at 1, stopped in between, closed at 0', () => {
    expect(
      decodeCover({ type: 'cover', id: 'c', position: 1, currentOperation: COVER_OPERATION_IDLE }),
    ).toEqual({
      state: 'open',
      position: 100,
    })
    expect(decodeCover({ type: 'cover', id: 'c', position: 0.5 })).toEqual({
      state: 'stopped',
      position: 50,
    })
  })

  it('brightness is a 0..1 fraction on the wire and a percentage in the cap', () => {
    expect(
      decodeBrightnessPercent({ type: 'light', id: 'light-l', state: true, brightness: 0.5 }),
    ).toBe(50)
    expect(decodeBrightnessPercent({ type: 'light', id: 'light-l', state: true })).toBe(0)
  })
})
