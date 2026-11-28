/**
 * The derived gateway signals beyond the WatchDog system variables: the
 * mass-UNREACH safety net and radio silence, and how sources merge. "Could not
 * read" is UNKNOWN, never "no fault".
 */
import { ERROR_STATUS_COLD, type ErrorStatus } from '@dominevo/types'
import type { HmDevice, ValueChangedEvent } from 'nodehomematic'
import { describe, expect, it } from 'vitest'
import {
  mergeFaultReadings,
  RADIO_SILENT_FAULT,
  ruleReading,
  watchdogFaultReading,
} from '../homematic-fault-mapping.js'
import { attachRadioActivity, RadioActivityTracker } from '../homematic-radio-silent.js'
import {
  RADIO_UNREACHABLE_MIN_DEVICES,
  RADIO_UNREACHABLE_MIN_FRACTION,
  RADIO_UNREACHABLE_WINDOW_MS,
  radioUnreachableReading,
} from '../homematic-radio-unreachable.js'

const NOW = 1_700_000_000_000
const MIN = 60_000
const DAY = 24 * 60 * MIN

describe('mergeFaultReadings', () => {
  const fine: ErrorStatus = { ...ERROR_STATUS_COLD, active: false, faults: [], lastFetchedAt: NOW }
  const unknown: ErrorStatus = { ...ERROR_STATUS_COLD, lastFetchedAt: NOW }
  const raised = ruleReading(RADIO_SILENT_FAULT, true, NOW)

  it('a fault from either source is active', () => {
    expect(mergeFaultReadings([unknown, raised], NOW).active).toBe(true)
    expect(mergeFaultReadings([fine, raised], NOW).active).toBe(true)
    expect(mergeFaultReadings([raised, fine], NOW).active).toBe(true)
  })
  it('the same code from two sources is one fault', () => {
    expect(mergeFaultReadings([raised, raised], NOW).faults).toHaveLength(1)
  })
  it('unknown from every source is unknown', () => {
    expect(mergeFaultReadings([unknown, unknown], NOW).active).toBeNull()
  })
  it('one source fine with the other unknown is fine', () => {
    expect(mergeFaultReadings([fine, unknown], NOW).active).toBe(false)
  })
})

/** The library's data-point id: `<central>-<interface>:<channel>:<paramset>:<parameter>`, lowercased. */
function dpId(iface: string, channel: string, parameter: string): string {
  return `ccu-${iface}:${channel}:values:${parameter}`.toLowerCase()
}

/**
 * A device on the named interface (read from its data-point ids, as production
 * does). `unreach` null means the maintenance flag was not reported.
 */
function device(address: string, unreach: boolean | null, iface = 'HmIP-RF'): HmDevice {
  const point = (channel: string, parameter: string, type: string, value: boolean) => ({
    id: dpId(iface, channel, parameter),
    parameter,
    type,
    value,
    readable: true,
    writable: false,
    hasEvents: true,
  })
  return {
    address,
    type: 'HmIP-BSM',
    name: null,
    channels: [
      {
        index: 0,
        type: 'MAINTENANCE',
        address: `${address}:0`,
        name: null,
        dataPoints: unreach === null ? [] : [point(`${address}:0`, 'UNREACH', 'BOOL', unreach)],
      },
      {
        index: 1,
        type: 'SWITCH',
        address: `${address}:1`,
        name: null,
        dataPoints: [point(`${address}:1`, 'STATE', 'BOOL', false)],
      },
    ],
  }
}

function hmip(n: number): string {
  return `000A9D89A7AF${String(10 + n)}`
}

/** The id of an event on a device's switch channel, as `valueChanged` reports it. */
function eventId(address: string, iface = 'HmIP-RF'): string {
  return dpId(iface, `${address}:1`, 'STATE')
}

describe('RadioActivityTracker', () => {
  const START = NOW - 60 * MIN
  const hmipDevices = Array.from({ length: 6 }, (_, n) => device(hmip(n), false))

  it('is unknown before the first event until 15 minutes of uptime passed', () => {
    const tracker = new RadioActivityTracker(NOW - 5 * MIN)
    expect(tracker.reading(hmipDevices, NOW).active).toBeNull()
  })
  it('fires after 15 minutes of uptime with no event at all', () => {
    expect(new RadioActivityTracker(START).reading(hmipDevices, NOW).active).toBe(true)
  })
  it('fires on silence after events, and an event clears it', () => {
    const tracker = new RadioActivityTracker(START)
    tracker.record(eventId(hmip(1)), NOW - 20 * MIN)
    const silent = tracker.reading(hmipDevices, NOW)
    expect(silent.active).toBe(true)
    expect(silent.faults?.[0]).toMatchObject({ code: 'radio-silent', severity: 'error' })
    tracker.record(eventId(hmip(2)), NOW - 1 * MIN)
    expect(tracker.reading(hmipDevices, NOW).active).toBe(false)
  })
  it('is fed the library events in epoch milliseconds, untouched', () => {
    // The library stamps Date.now(): a seconds-valued or rescaled stamp would read as
    // 1970 (or the far future) and silence would never clear (or never fire).
    const tracker = new RadioActivityTracker(START)
    const listeners: Array<(payload: ValueChangedEvent) => void> = []
    attachRadioActivity({ on: (_event, listener) => (listeners.push(listener), () => {}) }, tracker)
    const emit = (ts: number): void =>
      listeners.forEach((listener) =>
        listener({
          dpId: eventId(hmip(1)),
          device: hmip(1),
          channel: `${hmip(1)}:1`,
          parameter: 'STATE',
          value: true,
          prevValue: false,
          ts,
        }),
      )
    emit(NOW - 20 * MIN)
    expect(tracker.reading(hmipDevices, NOW).active).toBe(true)
    emit(NOW - MIN)
    expect(tracker.reading(hmipDevices, NOW).active).toBe(false)
  })
  it('is not kept alive by virtual devices or interface-level traffic', () => {
    const tracker = new RadioActivityTracker(START)
    tracker.record(eventId(hmip(1)), NOW - 20 * MIN)
    tracker.record(eventId('VCU0000001', 'VirtualDevices'), NOW - MIN)
    tracker.record(eventId('NEQ0000009', 'BidCos-Wired'), NOW - MIN)
    tracker.record('', NOW - MIN)
    expect(tracker.reading(hmipDevices, NOW).active).toBe(true)
  })
  it('judges nothing for an interface with fewer than 5 devices', () => {
    const tracker = new RadioActivityTracker(START)
    expect(tracker.reading(hmipDevices.slice(0, 4), NOW).active).toBeNull()
  })
  it('does not count wired or virtual devices into a radio population', () => {
    const tracker = new RadioActivityTracker(START)
    const wired = Array.from({ length: 5 }, (_, n) =>
      device(`NEQ000000${n}`, false, 'BidCos-Wired'),
    )
    expect(tracker.reading([...hmipDevices.slice(0, 4), ...wired], NOW).active).toBeNull()
  })
  it('judges BidCos-RF separately from HmIP-RF', () => {
    const tracker = new RadioActivityTracker(START)
    tracker.record(eventId(hmip(1)), NOW - MIN)
    const classic = Array.from({ length: 5 }, (_, n) => device(`NEQ000000${n}`, false, 'BidCos-RF'))
    expect(tracker.reading([...hmipDevices, ...classic], NOW).active).toBe(true)
    tracker.record(eventId('NEQ0000001', 'BidCos-RF'), NOW - MIN)
    expect(tracker.reading([...hmipDevices, ...classic], NOW).active).toBe(false)
  })
})

describe('watchdogFaultReading prefixes', () => {
  const sv = (name: string, value: boolean) => ({
    id: name,
    name,
    type: 'LOGIC',
    value,
    writable: false,
    isInternal: false,
  })
  it('accepts "WatchDog: " and "SV WatchDog: " and reports unmatched WatchDog variables', () => {
    const unmatched: string[] = []
    const reading = watchdogFaultReading(
      [
        sv('WatchDog: low-voltage', true),
        sv('SV WatchDog: no-internet', true),
        sv('WatchDog: Mystery', true),
      ],
      NOW,
      (name) => unmatched.push(name),
    )
    expect(reading.faults?.map((f) => f.code)).toEqual(['low-voltage', 'no-internet'])
    expect(unmatched).toEqual(['WatchDog: Mystery'])
  })
})

describe('radioUnreachableReading', () => {
  const stamp = (n: number, at: number) => ({ address: hmip(n), type: 'UNREACH', timestamp: at })

  it('names its thresholds', () => {
    expect(RADIO_UNREACHABLE_MIN_DEVICES).toBe(3)
    expect(RADIO_UNREACHABLE_MIN_FRACTION).toBe(0.25)
    expect(RADIO_UNREACHABLE_WINDOW_MS).toBe(10 * MIN)
  })

  it('does not fire for 2 stale UNREACH plus 2 fresh', () => {
    const devices = Array.from({ length: 10 }, (_, n) => device(hmip(n), n < 4))
    const messages = [
      stamp(0, NOW - 3 * DAY),
      stamp(1, NOW - 2 * DAY),
      stamp(2, NOW - 2 * MIN),
      stamp(3, NOW - 1 * MIN),
    ]
    expect(radioUnreachableReading(devices, messages, NOW).active).toBe(false)
  })

  it('fires for 3 fresh that are at least 25% of the interface', () => {
    const devices = Array.from({ length: 10 }, (_, n) => device(hmip(n), n < 3))
    const messages = [stamp(0, NOW - 5 * MIN), stamp(1, NOW - 4 * MIN), stamp(2, NOW - 1 * MIN)]
    const reading = radioUnreachableReading(devices, messages, NOW)
    expect(reading.active).toBe(true)
    expect(reading.faults?.[0]).toMatchObject({ code: 'radio-unreachable', severity: 'error' })
  })

  it('does not fire for 3 fresh in a big interface (under 25%)', () => {
    const devices = Array.from({ length: 20 }, (_, n) => device(hmip(n), n < 3))
    const messages = [stamp(0, NOW - 5 * MIN), stamp(1, NOW - 4 * MIN), stamp(2, NOW - 1 * MIN)]
    expect(radioUnreachableReading(devices, messages, NOW).active).toBe(false)
  })

  it('does not fire when the starts are spread beyond the window', () => {
    const devices = Array.from({ length: 6 }, (_, n) => device(hmip(n), n < 3))
    const messages = [stamp(0, NOW - 40 * MIN), stamp(1, NOW - 20 * MIN), stamp(2, NOW - 1 * MIN)]
    expect(radioUnreachableReading(devices, messages, NOW).active).toBe(false)
  })

  it('clears when the count drops below the threshold', () => {
    const messages = [stamp(0, NOW - 5 * MIN), stamp(1, NOW - 4 * MIN), stamp(2, NOW - 1 * MIN)]
    const down = Array.from({ length: 6 }, (_, n) => device(hmip(n), n < 3))
    expect(radioUnreachableReading(down, messages, NOW).active).toBe(true)
    const recovered = Array.from({ length: 6 }, (_, n) => device(hmip(n), n < 1))
    expect(radioUnreachableReading(recovered, messages, NOW).active).toBe(false)
  })

  it('ignores devices that are not on the HmIP-RF interface', () => {
    const classic = ['NEQ0000001', 'NEQ0000002', 'NEQ0000003'].map((a) =>
      device(a, true, 'BidCos-RF'),
    )
    const messages = classic.map((d) => ({
      address: d.address,
      type: 'UNREACH',
      timestamp: NOW - MIN,
    }))
    expect(radioUnreachableReading(classic, messages, NOW).active).toBeNull()
  })

  it('takes the interface from the device, not from the shape of its address', () => {
    // A wired device with a 14-hex address must not count into the HmIP-RF population.
    const wired = Array.from({ length: 10 }, (_, n) => device(hmip(n), false, 'BidCos-Wired'))
    const radio = Array.from({ length: 3 }, (_, n) => device(hmip(20 + n), true))
    const devices = [...wired, ...radio]
    const messages = devices.map((d) => ({
      address: d.address,
      type: 'UNREACH',
      timestamp: NOW - MIN,
    }))
    // 3 of 3 HmIP-RF devices are down; counting the wired ones (3 of 13) would be under 25%.
    expect(radioUnreachableReading(devices, messages, NOW).active).toBe(true)
  })

  it('is unknown, never "fine", when no device has a reading', () => {
    expect(radioUnreachableReading([], [], NOW).active).toBeNull()
  })
})
