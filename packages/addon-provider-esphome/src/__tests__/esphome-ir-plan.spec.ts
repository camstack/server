import { describe, expect, it } from 'vitest'
import { parseIrServices, planIrServices } from '../esphome-ir-plan.js'
import type { EspServiceInfo } from '../esphome-link.js'

const RAW: EspServiceInfo = {
  name: 'send_raw_command',
  key: 1,
  args: [{ name: 'command', type: 'int[]' }],
}
const WITH_CARRIER: EspServiceInfo = {
  name: 'send_rf',
  key: 2,
  args: [
    { name: 'code', type: 'int[]' },
    { name: 'carrier_frequency', type: 'int' },
  ],
}
const TWO_ARRAYS: EspServiceInfo = {
  name: 'two_arrays',
  key: 3,
  args: [
    { name: 'a', type: 'int[]' },
    { name: 'b', type: 'int[]' },
  ],
}
const EXTRA_ARG: EspServiceInfo = {
  name: 'with_label',
  key: 4,
  args: [
    { name: 'command', type: 'int[]' },
    { name: 'label', type: 'string' },
  ],
}
const FLOATS: EspServiceInfo = {
  name: 'floats',
  key: 5,
  args: [{ name: 'command', type: 'float[]' }],
}
const NO_ARGS: EspServiceInfo = { name: 'reboot', key: 6, args: [] }
const ALL = [RAW, WITH_CARRIER, TWO_ARRAYS, EXTRA_ARG, FLOATS, NO_ARGS]

describe('planIrServices auto', () => {
  it('takes every service whose only argument is an int[]', () => {
    const plans = planIrServices([RAW, FLOATS, NO_ARGS, TWO_ARRAYS, EXTRA_ARG], 'auto')
    expect(plans).toEqual([{ name: 'send_raw_command', media: ['ir'], timingsArg: 'command' }])
  })

  it('reads an int argument named like a carrier as the carrier', () => {
    const plans = planIrServices([WITH_CARRIER], 'auto')
    expect(plans).toEqual([
      { name: 'send_rf', media: ['ir'], timingsArg: 'code', carrierArg: 'carrier_frequency' },
    ])
  })
})

describe('planIrServices with an override', () => {
  it('keeps only the listed services, in the board order', () => {
    const setting = parseIrServices(['send_rf', 'send_raw_command'])
    const plans = planIrServices(ALL, setting ?? 'auto')
    expect(plans.map((p) => p.name)).toEqual(['send_raw_command', 'send_rf'])
  })

  it('an empty list means no transmitter at all', () => {
    expect(planIrServices(ALL, parseIrServices([]) ?? 'auto')).toEqual([])
  })

  it('declares RF by the override, never by guessing', () => {
    const setting = parseIrServices([{ name: 'send_rf', medium: 'rf' }, 'send_raw_command:rf'])
    const plans = planIrServices(ALL, setting ?? 'auto')
    expect(plans.map((p) => [p.name, p.media])).toEqual([
      ['send_raw_command', ['rf']],
      ['send_rf', ['rf']],
    ])
  })

  it('does not turn a listed service without an int[] argument into a transmitter', () => {
    const plans = planIrServices(ALL, parseIrServices(['reboot', 'floats']) ?? 'auto')
    expect(plans).toEqual([])
  })

  it('a listed service with extra non-carrier arguments is not drivable', () => {
    expect(planIrServices(ALL, parseIrServices(['with_label']) ?? 'auto')).toEqual([])
  })
})

describe('parseIrServices', () => {
  it('reads auto and absence as auto', () => {
    expect(parseIrServices('auto')).toBe('auto')
    expect(parseIrServices(undefined)).toBe('auto')
  })

  it('rejects a malformed value instead of guessing', () => {
    expect(parseIrServices(42)).toBeNull()
    expect(parseIrServices([{ name: 'x', medium: 'laser' }])).toBeNull()
  })
})
