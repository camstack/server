import { describe, expect, it } from 'vitest'
import {
  climateSliceFromCircuit,
  parseHomeComSystemPayload,
  waterHeaterSliceFromDhw,
} from '../homecom-domain-mapping.js'

describe('parseHomeComSystemPayload', () => {
  it('discovers K40 heating circuits and DHW from system JSON', () => {
    const { circuits, dhw } = parseHomeComSystemPayload({
      heatingCircuits: [
        {
          id: '0',
          name: 'Living room',
          operationMode: 'Heat',
          setpoint: 21.5,
          currentRoomTemperature: 20.1,
          minTemp: 5,
          maxTemp: 30,
        },
      ],
      domesticHotWater: {
        currentTemperature: 48,
        setpoint: 50,
        operationMode: 'eco',
        operationModes: ['off', 'eco', 'performance'],
        minTemp: 40,
        maxTemp: 60,
      },
    })
    expect(circuits).toHaveLength(1)
    expect(circuits[0]?.id).toBe('0')
    expect(dhw?.targetTemp).toBe(50)
  })
})

describe('climateSliceFromCircuit', () => {
  it('maps Heat operation mode → heat HVAC mode with setpoint', () => {
    const slice = climateSliceFromCircuit(
      {
        id: '0',
        name: 'HC1',
        operationMode: 'Heat',
        setpoint: 22,
        currentRoomTemp: 21,
        minTemp: 5,
        maxTemp: 30,
      },
      100,
    )
    expect(slice.mode).toBe('heat')
    expect(slice.target).toBe(22)
    expect(slice.currentTemp).toBe(21)
  })
})

describe('waterHeaterSliceFromDhw', () => {
  it('carries DHW target and operation mode on the slice', () => {
    const slice = waterHeaterSliceFromDhw(
      {
        currentTemp: 48,
        targetTemp: 50,
        operationMode: 'eco',
        availableModes: ['off', 'eco'],
        minTemp: 40,
        maxTemp: 60,
      },
      200,
    )
    expect(slice.targetTemp).toBe(50)
    expect(slice.operationMode).toBe('eco')
  })
})
