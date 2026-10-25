/**
 * Hub-stored composition bytes (2026-10-25 fixtures).
 */
import { DeviceRole, DeviceType } from '../../../device/device-type.js'
import { CompositionSchema, type Composition } from '../../composition.js'

const porchRaw = {
  target: { kind: 'new' as const, type: DeviceType.Sensor, role: DeviceRole.TemperatureSensor },
  features: [
    {
      kind: 'fields' as const,
      cap: 'temperature-sensor',
      fields: {
        celsius: {
          kind: 'expression' as const,
          expr: 'round(avg(t1, t2), 1)',
          bindings: {
            t1: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
              },
              cap: 'temperature-sensor',
              fieldPath: 'celsius',
              kind: 'from' as const,
            },
            t2: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:e5f545dc7f0d92d18e8eee5ded55b777-sensor.clima_porch_temperature',
              },
              cap: 'temperature-sensor',
              fieldPath: 'celsius',
              kind: 'from' as const,
            },
          },
        },
        lastFetchedAt: {
          kind: 'expression' as const,
          expr: 'max(f1, f2)',
          bindings: {
            f1: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:6cddfefa9609eb6e5778e65913b93b86-sensor.termostato_porch_temperature',
              },
              cap: 'temperature-sensor',
              fieldPath: 'lastFetchedAt',
              kind: 'from' as const,
            },
            f2: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:e5f545dc7f0d92d18e8eee5ded55b777-sensor.clima_porch_temperature',
              },
              cap: 'temperature-sensor',
              fieldPath: 'lastFetchedAt',
              kind: 'from' as const,
            },
          },
        },
      },
    },
    {
      kind: 'fields' as const,
      cap: 'binary',
      fields: {
        on: {
          kind: 'expression' as const,
          expr: 'any(d1, d2, within(m1, 300000), within(m2, 300000))',
          bindings: {
            d1: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:45269aa68c25b3951b36c83fdd1f87ce-binary_sensor.sensore_movimento_porch_motion',
              },
              cap: 'motion',
              fieldPath: 'detected',
              kind: 'from' as const,
            },
            d2: {
              source: {
                addonId: 'provider-hikvision',
                stableId: 'mac-040312a373d4',
              },
              cap: 'motion',
              fieldPath: 'detected',
              kind: 'from' as const,
            },
            m1: {
              source: {
                addonId: 'provider-homeassistant',
                stableId:
                  'ha:ha_001:dev:45269aa68c25b3951b36c83fdd1f87ce-binary_sensor.sensore_movimento_porch_motion',
              },
              cap: 'motion',
              fieldPath: 'lastDetectedAt',
              kind: 'from' as const,
            },
            m2: {
              source: {
                addonId: 'provider-hikvision',
                stableId: 'mac-040312a373d4',
              },
              cap: 'motion',
              fieldPath: 'lastDetectedAt',
              kind: 'from' as const,
            },
          },
        },
        lastChangedAt: { kind: 'expression' as const, expr: 'now', bindings: {} },
      },
    },
  ],
}

const doorbell101Raw = {
  target: {
    kind: 'existing' as const,
    device: { addonId: 'provider-hikvision', stableId: 'mac-40acbf7be9f7' },
  },
  features: [
    {
      kind: 'fields' as const,
      cap: 'doorbell',
      enabled: true,
      fields: {
        lastPressedAt: {
          kind: 'expression' as const,
          expr: 'latest(rose(active0, changed0, 2000))',
          bindings: {
            active0: {
              source: {
                addonId: 'provider-homeassistant',
                stableId: 'ha:ha_001:dev:bf38dbc6816ab9fdbd7f8f6b1eb4638b-switch.doorbell_bussano',
              },
              cap: 'switch',
              fieldPath: 'on',
              kind: 'from' as const,
            },
            changed0: {
              source: {
                addonId: 'provider-homeassistant',
                stableId: 'ha:ha_001:dev:bf38dbc6816ab9fdbd7f8f6b1eb4638b-switch.doorbell_bussano',
              },
              cap: 'switch',
              fieldPath: 'lastChangedAt',
              kind: 'from' as const,
            },
          },
        },
        pressCountSinceStart: {
          kind: 'expression' as const,
          expr: 'count(lastPressedAt)',
          bindings: {
            lastPressedAt: {
              source: { addonId: 'provider-hikvision', stableId: 'mac-40acbf7be9f7' },
              cap: 'doorbell',
              fieldPath: 'lastPressedAt',
              kind: 'from' as const,
            },
          },
        },
      },
    },
  ],
}

export const PORCH_COMPOSITION: Composition = CompositionSchema.parse(porchRaw)
export const DOORBELL_101_COMPOSITION: Composition = CompositionSchema.parse(doorbell101Raw)
