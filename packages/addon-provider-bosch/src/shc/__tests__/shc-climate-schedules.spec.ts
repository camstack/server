import { describe, expect, it } from 'vitest'
import { climatePresetSelection, heatingProfilesFromSchedule } from '../shc-climate-schedules.js'
import { shcEventsFromPayload } from '../shc-events.js'

describe('heating profiles', () => {
  it('names system and custom schedules and marks the active one', () => {
    const view = heatingProfilesFromSchedule({
      activeScheduleId: 'custom-id',
      scheduleData: [
        {
          id: 'custom-id',
          attributeExtensionMap: { ScheduleType: 'CUSTOM' },
        },
        {
          id: 'system-id',
          attributeExtensionMap: { ScheduleType: 'SYSTEM' },
        },
      ],
    })
    expect(view.profiles).toEqual([
      { id: 'custom-id', preset: 'custom' },
      { id: 'system-id', preset: 'system' },
    ])
    expect(climatePresetSelection(view)).toEqual({
      preset: 'custom',
      availablePresets: ['custom', 'system'],
    })
  })
})

describe('shcEventsFromPayload', () => {
  it('reads device ids from a JSON-RPC long-poll result', () => {
    const events = shcEventsFromPayload({
      jsonrpc: '2.0',
      result: [
        {
          '@type': 'DeviceServiceData',
          id: 'RoomClimateControl',
          deviceId: 'roomClimateControl_hz_5',
          state: { setpointTemperature: 5.5 },
        },
      ],
    })
    expect(events).toEqual([
      {
        deviceId: 'roomClimateControl_hz_5',
        serviceId: 'RoomClimateControl',
        eventType: undefined,
      },
    ])
  })
})
