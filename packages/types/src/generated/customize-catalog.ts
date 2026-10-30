// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-customize-catalog.ts
/* eslint-disable */

import type { CustomizeCatalog } from '../capabilities/customize-catalog.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Customize catalog, projected from every `*.cap.ts` `customize` block.
 * 7 caps. Field keys are `runtimeState` paths. No Zod.
 */
export const CAP_CUSTOMIZE_CATALOG = {
  'battery': {
    version: 1,
    targets: [
      {
        id: 'level',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Camera, DeviceType.Sensor, DeviceType.Button, DeviceType.Switch, DeviceType.PetFeeder, DeviceType.Container, DeviceType.Thermostat, DeviceType.EventEmitter],
        apply: 'add',
        vocabularyCap: 'battery',
        vocabularyStateField: 'level',
        sources: [
          {
            kind: 'field',
            valueKinds: [
              'number',
              'string',
            ],
            transformKinds: [
              'identity',
              'linear',
            ],
            transforms: [
              {
                kind: 'identity',
              },
              {
                kind: 'linear',
                defaultScale: 1,
                defaultOffset: 0,
                clampMin: 0,
                clampMax: 100,
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'level',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'constant',
            path: 'charging',
            value: 'unknown',
            when: 'add',
          },
          {
            kind: 'constant',
            path: 'sleeping',
            value: false,
            when: 'add',
          },
          {
            kind: 'clock',
            path: 'lastUpdated',
            when: 'add',
          },
        ],
      },
    ],
  },
  'consumables': {
    version: 1,
    targets: [
      {
        id: 'items',
        cardinality: 'keyedArray',
        deviceTypes: [DeviceType.Camera, DeviceType.Hub, DeviceType.Light, DeviceType.Siren, DeviceType.Switch, DeviceType.Sensor, DeviceType.Thermostat, DeviceType.Climate, DeviceType.Button, DeviceType.EventEmitter, DeviceType.Update, DeviceType.Generic, DeviceType.Notifier, DeviceType.Script, DeviceType.Automation, DeviceType.Lock, DeviceType.Cover, DeviceType.Valve, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.Fan, DeviceType.MediaPlayer, DeviceType.AlarmPanel, DeviceType.Control, DeviceType.Presence, DeviceType.Weather, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.Container, DeviceType.Image, DeviceType.PetFeeder, DeviceType.PetFountain, DeviceType.Dishwasher, DeviceType.Washer, DeviceType.Dryer, DeviceType.Gateway],
        apply: 'add',
        vocabularyCap: 'consumables',
        sources: [],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'items',
        keyField: 'key',
        labelField: 'label',
        nativeItems: 'read-only',
        fields: [
          {
            path: 'level',
            valueKind: 'number',
            nullable: true,
            sources: [
              {
                kind: 'numeric',
                transformKinds: [
                  'identity',
                  'linear',
                ],
                transforms: [
                  {
                    kind: 'identity',
                  },
                  {
                    kind: 'linear',
                    defaultScale: 1,
                    defaultOffset: 0,
                    clampMin: 0,
                    clampMax: 100,
                  },
                ],
              },
            ],
          },
          {
            path: 'remaining.value',
            valueKind: 'number',
            nullable: true,
            sources: [
              {
                kind: 'numeric',
                transformKinds: [
                  'identity',
                ],
                transforms: [
                  {
                    kind: 'identity',
                  },
                ],
              },
            ],
            literals: [
              {
                path: 'remaining.kind',
                values: [
                  'duration',
                  'count',
                ],
              },
            ],
          },
          {
            path: 'status',
            valueKind: 'enum',
            nullable: true,
            enumValues: [
              'ok',
              'low',
              'empty',
              'full',
              'replace',
            ],
            sources: [
              {
                kind: 'enum',
                transformKinds: [
                  'enum-map',
                ],
                transforms: [
                  {
                    kind: 'enum-map',
                    outputValues: [
                      'ok',
                      'low',
                      'empty',
                      'full',
                      'replace',
                    ],
                    unmapped: null,
                  },
                ],
              },
            ],
          },
        ],
        traits: [
          {
            path: 'kind',
            values: [
              'wear',
              'supply',
              'waste',
            ],
            defaultValue: 'wear',
          },
          {
            path: 'form',
            values: [
              'part',
              'tank',
              'product',
              'bin',
            ],
            defaultValue: 'part',
          },
        ],
        companions: [
          {
            kind: 'clock',
            path: 'lastChangedAt',
            when: 'add',
          },
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
    ],
  },
  'doorbell': {
    version: 1,
    targets: [
      {
        id: 'pressed',
        cardinality: 'event',
        deviceTypes: [DeviceType.Camera],
        apply: 'add',
        vocabularyCap: 'doorbell',
        vocabularyEvent: 'onPressed',
        sources: [
          {
            kind: 'binary',
            transformKinds: [],
            transforms: [],
          },
          {
            kind: 'switch',
            transformKinds: [],
            transforms: [],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        shape: 'pulse',
        applyAuthority: {
          kind: 'composition-claim',
        },
        eventName: 'onPressed',
        combine: 'any',
        edges: [
          'rising',
        ],
        defaultEdge: 'rising',
        timestampPath: 'lastPressedAt',
        counterPath: 'pressCountSinceStart',
        highWater: 'composer-advance',
        debounceMs: 2000,
      },
    ],
  },
  'motion': {
    version: 1,
    targets: [
      {
        id: 'detected',
        cardinality: 'event',
        deviceTypes: [DeviceType.Camera],
        apply: 'add',
        vocabularyCap: 'motion',
        vocabularyEvent: 'onMotionChanged',
        sources: [
          {
            kind: 'binary',
            transformKinds: [],
            transforms: [],
          },
          {
            kind: 'switch',
            transformKinds: [],
            transforms: [],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        shape: 'span',
        applyAuthority: {
          kind: 'camera-sensors',
          timeoutField: 'motionCooldownMs',
        },
        eventName: 'onMotionChanged',
        combine: 'any',
        start: 'rising-edge',
        end: 'falling-edge-or-timeout',
        timeoutMs: 30000,
        sourceModes: [
          'in-addition',
          'confirm',
          'replace',
        ],
      },
    ],
  },
  'power-meter': {
    version: 1,
    targets: [
      {
        id: 'power',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder],
        apply: 'add',
        vocabularyCap: 'power-meter',
        vocabularyStateField: 'power',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'W',
            transformKinds: [
              'identity',
            ],
            transforms: [
              {
                kind: 'identity',
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'power',
        valueKind: 'number',
        nullable: false,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'always',
          },
        ],
      },
      {
        id: 'energy',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder],
        apply: 'add',
        vocabularyCap: 'power-meter',
        vocabularyStateField: 'energy',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'kWh',
            transformKinds: [
              'identity',
            ],
            transforms: [
              {
                kind: 'identity',
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'energy',
        valueKind: 'number',
        nullable: false,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'always',
          },
        ],
      },
      {
        id: 'voltage',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder],
        apply: 'add',
        vocabularyCap: 'power-meter',
        vocabularyStateField: 'voltage',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'V',
            transformKinds: [
              'identity',
            ],
            transforms: [
              {
                kind: 'identity',
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'voltage',
        valueKind: 'number',
        nullable: false,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'always',
          },
        ],
      },
      {
        id: 'current',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder],
        apply: 'add',
        vocabularyCap: 'power-meter',
        vocabularyStateField: 'current',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'A',
            transformKinds: [
              'identity',
            ],
            transforms: [
              {
                kind: 'identity',
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'current',
        valueKind: 'number',
        nullable: false,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'always',
          },
        ],
      },
    ],
  },
  'remote': {
    version: 1,
    targets: [
      {
        id: 'remote',
        cardinality: 'config',
        deviceTypes: [DeviceType.MediaPlayer],
        apply: 'add',
        readMethod: 'getConfig',
        writeMethod: 'setConfig',
        vocabularyCap: 'remote',
        sources: [],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
      },
    ],
  },
  'running-state': {
    version: 1,
    targets: [
      {
        id: 'running',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.MediaPlayer, DeviceType.WaterHeater, DeviceType.Humidifier, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.PetFeeder],
        apply: 'add',
        vocabularyCap: 'running-state',
        vocabularyStateField: 'running',
        sources: [
          {
            kind: 'switch',
            transformKinds: [
              'identity',
            ],
            transforms: [
              {
                kind: 'identity',
              },
            ],
          },
          {
            kind: 'binary',
            transformKinds: [
              'identity',
              'invert',
            ],
            transforms: [
              {
                kind: 'identity',
              },
              {
                kind: 'invert',
              },
            ],
          },
          {
            kind: 'numeric',
            requiredUnit: 'W',
            transformKinds: [
              'threshold',
            ],
            transforms: [
              {
                kind: 'threshold',
                comparisons: [
                  'gte',
                  'lte',
                ],
                comparison: 'gte',
                defaultThreshold: 5,
                defaultStartDwellMs: 30000,
                defaultStopDwellMs: 180000,
                thresholdUnit: 'W',
              },
            ],
          },
        ],
        sourceReport: {
          status: 'assignment-status',
          runtimeField: 'source',
          nativeValue: 'native',
          assignedValue: 'assigned',
        },
        advancedExpression: true,
        path: 'running',
        valueKind: 'boolean',
        nullable: true,
        companions: [
          {
            kind: 'constant',
            path: 'source',
            value: 'assigned',
            when: 'always',
          },
          {
            kind: 'constant',
            path: 'phase',
            value: null,
            when: 'always',
          },
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'always',
          },
          {
            kind: 'transition-time',
            path: 'since',
            sourceChangedAt: 'prefer',
          },
        ],
      },
    ],
  },
} as const satisfies CustomizeCatalog

/**
 * Unit meta on runtime-state fields. The composed-device row reads this;
 * it is not an override list (D944).
 */
export const CAP_RUNTIME_FIELD_UNITS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  'ambient-light-sensor': {
    illuminance: 'lx',
  },
  'battery': {
    level: '%',
    voltage: 'V',
  },
  'humidity-sensor': {
    humidity: '%',
  },
  'power-meter': {
    power: 'W',
    energy: 'kWh',
    voltage: 'V',
    current: 'A',
  },
  'temperature-sensor': {
    temperature: '°C',
  },
}
