/**
 * A PoE port is a `switch` device with the role `poe-port`: on / off powers the
 * device behind it. Its link is the `network-link` cap (speed, up / down) and its
 * draw the `power-meter` cap. Restarting the POWERED device through its port is
 * that device's `power-source` cap, never a reboot of the port.
 */
import { describe, expect, it } from 'vitest'
import { DeviceRole, DeviceType } from '../../device/device-type.js'
import { deviceIconKey } from '../../device/device-icon.js'
import { NetworkLinkStatusSchema } from '../network-link.cap.js'
import { PowerMeterStatusSchema } from '../power-meter.cap.js'
import { switchCapability } from '../switch.cap.js'

describe('the poe-port role', () => {
  it('is a role of the switch type, drawn as an ethernet port', () => {
    expect(DeviceRole.PoePort).toBe('poe-port')
    expect(deviceIconKey(DeviceType.Switch, DeviceRole.PoePort)).toBe('ethernet-port')
  })

  it('words the switch as powering the port, in both languages', () => {
    const port = switchCapability.vocabulary.overrides.byRole[DeviceRole.PoePort]
    expect(port.actions['switch.on'].label).toEqual({ en: 'Power on', it: 'Alimenta' })
    expect(port.actions['switch.off'].label).toEqual({
      en: 'Power off',
      it: 'Togli alimentazione',
    })
    expect(port.actions['switch.on'].phrase.en).toContain('{device}')
    expect(port.actions['switch.on'].phrase.it).toContain('{device}')
    expect(port.actions['switch.off'].phrase.en).toContain('{device}')
    expect(port.actions['switch.off'].phrase.it).toContain('{device}')
    expect(port.actions['switch.on'].icon).toBe('plug-zap')
    expect(port.state.on.whenTrue.it).toContain('{device}')
  })
})

describe('network-link — a wired port speed and link state', () => {
  it('carries the negotiated speed and whether the link is up', () => {
    const parsed = NetworkLinkStatusSchema.parse({
      type: 'ethernet',
      signal: null,
      speedMbps: 1000,
      linkUp: true,
      lastUpdated: 1,
    })
    expect(parsed.speedMbps).toBe(1000)
    expect(parsed.linkUp).toBe(true)
  })

  it('a down port is linkUp false with no speed, and unknown is null', () => {
    const down = NetworkLinkStatusSchema.parse({
      type: 'ethernet',
      signal: null,
      speedMbps: null,
      linkUp: false,
      lastUpdated: 1,
    })
    expect(down.linkUp).toBe(false)
    expect(down.speedMbps).toBeNull()
    expect(() =>
      NetworkLinkStatusSchema.parse({
        type: 'ethernet',
        signal: null,
        speedMbps: -10,
        lastUpdated: 1,
      }),
    ).toThrow()
  })

  it('a provider that never reported either field stays valid', () => {
    const wifi = NetworkLinkStatusSchema.parse({ type: 'wifi', signal: 60, lastUpdated: 1 })
    expect(wifi.speedMbps).toBeUndefined()
    expect(wifi.linkUp).toBeUndefined()
  })
})

describe('power-meter — a PoE port reading', () => {
  it('already has watts, voltage and current', () => {
    const reading = PowerMeterStatusSchema.parse({
      power: 6.4,
      voltage: 53.1,
      current: 0.12,
      lastFetchedAt: 1,
    })
    expect(reading).toEqual({ power: 6.4, voltage: 53.1, current: 0.12, lastFetchedAt: 1 })
  })
})
