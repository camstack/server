import { describe, expect, it } from 'vitest'
import {
  declaredEventCandidates,
  declaredEventOptions,
  type DeclaredEventRead,
} from './declared-event-options'

function read(
  deviceId: number,
  deviceName: string,
  data: unknown,
  status: DeclaredEventRead['status'] = 'success',
): DeclaredEventRead {
  return { deviceId, deviceName, status, data }
}

const BUTTON = {
  eventTypes: ['PRESS_SHORT', 'PRESS_LONG'],
  vocabulary: [
    { id: 'PRESS_SHORT', label: 'Press', kind: 'press' },
    { id: 'PRESS_LONG', label: 'Long press', kind: 'long-press' },
  ],
  lastEvent: null,
  eventCountSinceStart: 0,
}

describe('declaredEventOptions', () => {
  it('offers the events one event device declares, by token, under their label', () => {
    const out = declaredEventOptions([read(7, 'Hall button 1', BUTTON)])
    expect(out.options).toEqual([
      { value: 'PRESS_SHORT', label: 'Press' },
      { value: 'PRESS_LONG', label: 'Long press' },
    ])
    expect(out.eventDeviceCount).toBe(1)
    expect(out.pending).toBe(false)
    expect(out.unknownDevices).toEqual([])
  })

  it('reads a status that declares no vocabulary through its plain tokens', () => {
    const out = declaredEventOptions([
      read(7, 'Old remote', { eventTypes: ['single'], lastEvent: null, eventCountSinceStart: 0 }),
    ])
    expect(out.options).toEqual([{ value: 'single', label: 'single' }])
  })

  it('lists a token two devices declare once, and names who declares what', () => {
    const other = {
      ...BUTTON,
      eventTypes: ['PRESS_SHORT'],
      vocabulary: [{ id: 'PRESS_SHORT', label: 'Press', kind: 'press' }],
    }
    const out = declaredEventOptions([read(7, 'Button 1', BUTTON), read(8, 'Button 2', other)])
    expect(out.options).toEqual([
      { value: 'PRESS_SHORT', label: 'Press', hint: 'Button 1, Button 2' },
      { value: 'PRESS_LONG', label: 'Long press', hint: 'Button 1' },
    ])
    expect(out.eventDeviceCount).toBe(2)
  })

  it('lists a token once when one device declares it for several of its parts', () => {
    const remote = {
      eventTypes: ['PRESS_SHORT'],
      vocabulary: [
        { id: 'PRESS_SHORT', label: 'Press', source: { id: '1', label: 'Button 1' } },
        { id: 'PRESS_SHORT', label: 'Press', source: { id: '2', label: 'Button 2' } },
      ],
      lastEvent: null,
      eventCountSinceStart: 0,
    }
    expect(declaredEventOptions([read(7, 'Remote', remote)]).options).toEqual([
      { value: 'PRESS_SHORT', label: 'Press' },
    ])
  })

  it('a device with no event slice is not an event device, and says nothing', () => {
    const out = declaredEventOptions([read(3, 'Front door contact', null)])
    expect(out).toEqual({ options: [], pending: false, unknownDevices: [], eventDeviceCount: 0 })
  })

  it('a read that has not answered is pending, never an empty vocabulary (D315)', () => {
    const out = declaredEventOptions([read(7, 'Button 1', undefined, 'pending')])
    expect(out.pending).toBe(true)
    expect(out.options).toEqual([])
    expect(out.unknownDevices).toEqual([])
  })

  it('a read that failed, or a slice that does not parse, names the device as unknown', () => {
    const out = declaredEventOptions([
      read(7, 'Button 1', undefined, 'error'),
      read(8, 'Button 2', { eventTypes: 'nope' }),
      read(9, 'Button 3', BUTTON),
    ])
    expect(out.unknownDevices).toEqual(['Button 1', 'Button 2'])
    expect(out.options.map((o) => o.value)).toEqual(['PRESS_SHORT', 'PRESS_LONG'])
  })
})

describe('declaredEventCandidates', () => {
  it('keeps the selected devices that are not cameras, under their fleet name', () => {
    const cameras = [{ id: 1, name: 'Porch' }]
    const fleet = [
      { id: 1, name: 'Porch', type: 'camera', location: null },
      { id: 7, name: 'Hall button 1', type: 'event-emitter', location: null },
    ]
    expect(declaredEventCandidates([1, 7, 9], cameras, fleet)).toEqual([
      { deviceId: 7, deviceName: 'Hall button 1' },
      { deviceId: 9, deviceName: '#9' },
    ])
    expect(declaredEventCandidates([7], cameras, undefined)).toEqual([
      { deviceId: 7, deviceName: '#7' },
    ])
  })
})
