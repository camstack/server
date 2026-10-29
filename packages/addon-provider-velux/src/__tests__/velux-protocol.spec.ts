import { describe, expect, it } from 'vitest'
import {
  ACTUATOR,
  coverClassOf,
  coverStateOf,
  hasRainSensor,
  isRainLimitation,
  KLF_POSITION_MAX,
  nodeNativeKey,
  openPercentToRaw,
  rawToOpenPercent,
  serialToHex,
} from '../velux-protocol.js'

/**
 * KLF-200 wire positions run 0x0000..0xC800 and 0 means FULLY OPEN, for a
 * window opener as much as for a roller shutter (the vendor library inverts
 * the window type only to present "100 % = open"; HA reads
 * `100 - position_percent` for every cover). CamStack's `cover` cap is
 * 0 = closed .. 100 = open, so the mapping is the same for every actuator.
 */
describe('position mapping', () => {
  it('maps wire 0 to fully open and 0xC800 to fully closed', () => {
    expect(rawToOpenPercent(0)).toBe(100)
    expect(rawToOpenPercent(KLF_POSITION_MAX)).toBe(0)
    expect(rawToOpenPercent(KLF_POSITION_MAX / 2)).toBe(50)
  })

  it('reports a wire value above the range (target / current / ignore markers) as unknown', () => {
    expect(rawToOpenPercent(0xd100)).toBeNull()
    expect(rawToOpenPercent(0xd200)).toBeNull()
    expect(rawToOpenPercent(0xf7ff)).toBeNull()
  })

  it('round-trips a percentage through the wire encoding', () => {
    for (const percent of [0, 1, 25, 50, 73, 99, 100]) {
      expect(rawToOpenPercent(openPercentToRaw(percent))).toBe(percent)
    }
  })

  it('encodes open as wire 0 and closed as 0xC800, clamping out-of-range input', () => {
    expect(openPercentToRaw(100)).toBe(0)
    expect(openPercentToRaw(0)).toBe(KLF_POSITION_MAX)
    expect(openPercentToRaw(140)).toBe(0)
    expect(openPercentToRaw(-5)).toBe(KLF_POSITION_MAX)
  })
})

describe('actuator classification', () => {
  it('maps cover-like actuator types and ignores the rest', () => {
    expect(coverClassOf(ACTUATOR.WindowOpener)).toBe('window')
    expect(coverClassOf(ACTUATOR.RollerShutter)).toBe('shutter')
    expect(coverClassOf(ACTUATOR.SwingingShutter)).toBe('shutter')
    expect(coverClassOf(ACTUATOR.DualShutter)).toBe('shutter')
    expect(coverClassOf(ACTUATOR.Awning)).toBe('awning')
    expect(coverClassOf(ACTUATOR.HorizontalAwning)).toBe('awning')
    expect(coverClassOf(ACTUATOR.VenetianBlind)).toBe('blind')
    expect(coverClassOf(ACTUATOR.Blind)).toBe('blind')
    expect(coverClassOf(ACTUATOR.ExternalVenetianBlind)).toBe('blind')
    expect(coverClassOf(ACTUATOR.LouvreBlind)).toBe('blind')
    expect(coverClassOf(ACTUATOR.CurtainTrack)).toBe('blind')
    expect(coverClassOf(ACTUATOR.GarageOpener)).toBe('garage')
    expect(coverClassOf(ACTUATOR.RollingDoorOpener)).toBe('garage')
    expect(coverClassOf(ACTUATOR.GateOpener)).toBe('gate')
    expect(coverClassOf(ACTUATOR.Light)).toBeNull()
    expect(coverClassOf(ACTUATOR.Lock)).toBeNull()
    expect(coverClassOf(ACTUATOR.OnOffSwitch)).toBeNull()
    expect(coverClassOf(ACTUATOR.HeatPump)).toBeNull()
  })

  it('flags only the window opener with the integrated rain sensor subtype', () => {
    expect(hasRainSensor(ACTUATOR.WindowOpener, 1)).toBe(true)
    expect(hasRainSensor(ACTUATOR.WindowOpener, 0)).toBe(false)
    expect(hasRainSensor(ACTUATOR.RollerShutter, 1)).toBe(false)
  })
})

describe('rain limitation', () => {
  // pyvlx / HA: a window with a rain sensor reports an opening limitation of
  // 89, 91, 93 or 100 % (wire minimum) while it rains; >= 89 % means rain.
  it('reads a high minimum limitation as rain', () => {
    const at = (percent: number): number => Math.round((KLF_POSITION_MAX * percent) / 100)
    expect(isRainLimitation(at(89))).toBe(true)
    expect(isRainLimitation(at(91))).toBe(true)
    expect(isRainLimitation(at(100))).toBe(true)
    expect(isRainLimitation(at(88))).toBe(false)
    expect(isRainLimitation(0)).toBe(false)
  })

  it('answers null when the gateway reported no usable limitation', () => {
    expect(isRainLimitation(0xd400)).toBeNull()
  })
})

describe('identity', () => {
  it('renders the 8-byte serial as lowercase hex and treats an all-zero serial as absent', () => {
    expect(serialToHex(Uint8Array.from([0x0a, 0xbc, 0, 1, 2, 3, 0xff, 0x10]))).toBe(
      '0abc00010203ff10',
    )
    expect(serialToHex(new Uint8Array(8))).toBe('')
  })

  it('keys a node on its serial, falling back to the node id', () => {
    expect(nodeNativeKey('velux:192-168-20-65', { serial: '0abc', nodeId: 3 })).toBe(
      'velux:192-168-20-65:serial:0abc',
    )
    expect(nodeNativeKey('velux:192-168-20-65', { serial: '', nodeId: 3 })).toBe(
      'velux:192-168-20-65:node:3',
    )
  })
})

describe('cover state', () => {
  it('derives opening / closing from the target while the node executes', () => {
    expect(coverStateOf({ position: 20, targetPosition: 80, executing: true })).toBe('opening')
    expect(coverStateOf({ position: 80, targetPosition: 20, executing: true })).toBe('closing')
  })

  it('derives open / closed at rest and stopped when the position is unknown', () => {
    expect(coverStateOf({ position: 0, targetPosition: 0, executing: false })).toBe('closed')
    expect(coverStateOf({ position: 40, targetPosition: 40, executing: false })).toBe('open')
    expect(coverStateOf({ position: null, targetPosition: null, executing: false })).toBe('stopped')
  })
})
