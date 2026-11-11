import type { HomeComBridgeReading, HomeComBridgeSetting } from '../homecom-bridge.js'

/**
 * A bridge reading shaped like the worker's answer for a K40 air/water heat pump, with the
 * values a live gateway answered: the energy meters, the silent mode and the additional
 * heater are refused there (null), heat/cool mode and the hot-water level are read-only.
 */

export function setting(
  value: string | number | null,
  extra: Partial<HomeComBridgeSetting> = {},
): HomeComBridgeSetting {
  return {
    value,
    min: null,
    max: null,
    allowed: [],
    writeable: null,
    ...extra,
  }
}

export function k40Reading(): HomeComBridgeReading {
  return {
    heatSource: {
      heatPumpType: 'air_water',
      supplyTemp: 52.2,
      returnTemp: 47.8,
      modulationPct: 89,
      pressureBar: 1.7,
      starts: 516,
      outdoorTemp: 7.5,
      thermalKwh: null,
      electricalKwh: null,
    },
    system: {
      away: setting('off', { allowed: ['on', 'off'], writeable: true }),
      silent: null,
      additionalHeater: null,
      holiday: setting('', { allowed: [] }),
    },
    heatingCircuits: [
      {
        id: 'hc1',
        name: null,
        operationMode: setting('manual', {
          allowed: ['off', 'manual', 'auto'],
          writeable: true,
        }),
        heatCoolMode: setting('heat', {
          allowed: ['heat', 'cool', 'heatCool'],
          writeable: false,
        }),
        currentSuWiMode: setting('forced'),
        suWiSwitchMode: null,
        roomTemp: 21.4,
        humidity: null,
        currentRoomSetpoint: setting(30),
        manualRoomSetpoint: setting(30, { min: 5, max: 30, writeable: true }),
        coolingRoomSetpoint: null,
        comfortSetpoint: null,
        ecoSetpoint: null,
        maxFlowTemp: setting(60, { min: 30, max: 60, writeable: true }),
      },
    ],
    dhwCircuits: [
      {
        id: 'dhw1',
        operationMode: setting('eco', {
          allowed: ['Off', 'low', 'high', 'ownprogram', 'eco'],
          writeable: true,
        }),
        actualTemp: 48,
        currentTemperatureLevel: setting('eco', {
          allowed: ['off', 'low', 'high', 'eco'],
          writeable: false,
        }),
        charge: setting('stop', {
          allowed: ['start', 'stop'],
          writeable: true,
        }),
        chargeDuration: setting(60, { min: 60, max: 2880, writeable: true }),
        singleChargeSetpoint: setting(60, { min: 50, max: 70 }),
        currentSetpoint: null,
        temperatureLevels: {
          eco: setting(51, { min: 30, max: 60, writeable: true }),
        },
      },
    ],
    heatSourceProbe: {},
  }
}
