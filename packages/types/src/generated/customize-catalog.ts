// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-customize-catalog.ts
/* eslint-disable */

import type { CustomizeCatalog } from '../capabilities/customize-catalog.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Customize catalog, projected from every `*.cap.ts` `customize` block.
 * 11 caps. Field keys are `runtimeState` paths. No Zod.
 */
export const CAP_CUSTOMIZE_CATALOG = {
  'ambient-light-sensor': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'lux',
        kind: 'number',
        label: 'Illuminance',
        unit: 'lx',
      },
    ],
  },
  'battery': {
    version: 1,
    targets: [
      {
        id: 'percentage',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Camera, DeviceType.Sensor, DeviceType.Button, DeviceType.Switch, DeviceType.PetFeeder, DeviceType.Container, DeviceType.Thermostat],
        apply: 'add-or-replace',
        vocabularyCap: 'battery',
        vocabularyStateField: 'percentage',
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
          },
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: true,
        path: 'percentage',
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
    advancedParameters: [
      {
        path: 'binary',
        kind: 'boolean',
        label: 'Binary indicator',
      },
      {
        path: 'charging',
        kind: 'enum',
        label: 'Charging source',
        enumValues: [
          'dc',
          'solar',
          'none',
          'unknown',
        ],
      },
      {
        path: 'sleeping',
        kind: 'boolean',
        label: 'Sleeping',
      },
    ],
  },
  'binary': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'on',
        kind: 'boolean',
        label: 'On',
      },
    ],
  },
  'consumables': {
    version: 1,
    targets: [
      {
        id: 'items',
        cardinality: 'keyedArray',
        deviceTypes: [DeviceType.Camera, DeviceType.Hub, DeviceType.Light, DeviceType.Siren, DeviceType.Switch, DeviceType.Sensor, DeviceType.Thermostat, DeviceType.Climate, DeviceType.Button, DeviceType.EventEmitter, DeviceType.Update, DeviceType.Generic, DeviceType.Notifier, DeviceType.Script, DeviceType.Automation, DeviceType.Lock, DeviceType.Cover, DeviceType.Valve, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.Fan, DeviceType.MediaPlayer, DeviceType.AlarmPanel, DeviceType.Control, DeviceType.Presence, DeviceType.Weather, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.Container, DeviceType.Image, DeviceType.PetFeeder, DeviceType.Dishwasher],
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
              },
            ],
            literals: [
              {
                path: 'remaining.unit',
                values: [
                  'days',
                  'hours',
                  'cycles',
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
    advancedParameters: [],
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
          },
          {
            kind: 'switch',
            transformKinds: [],
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
        timestampPath: 'lastPressedAt',
        counterPath: 'pressCountSinceStart',
        highWater: 'composer-advance',
        debounceMs: 2000,
      },
    ],
    advancedParameters: [],
  },
  'humidity-sensor': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'percent',
        kind: 'number',
        label: 'Humidity',
        unit: '%',
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
        apply: 'replace',
        vocabularyCap: 'motion',
        vocabularyEvent: 'onMotionChanged',
        sources: [
          {
            kind: 'binary',
            transformKinds: [],
          },
          {
            kind: 'switch',
            transformKinds: [],
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
    advancedParameters: [],
  },
  'power-meter': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'kwhTotal',
        kind: 'number',
        label: 'Energy',
        unit: 'kWh',
      },
      {
        path: 'watts',
        kind: 'number',
        label: 'Power',
        unit: 'W',
      },
    ],
  },
  'running-state': {
    version: 1,
    targets: [
      {
        id: 'running',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.MediaPlayer, DeviceType.WaterHeater, DeviceType.Humidifier, DeviceType.Fan, DeviceType.Climate, DeviceType.Thermostat, DeviceType.PetFeeder],
        apply: 'add-or-replace',
        vocabularyCap: 'running-state',
        vocabularyStateField: 'running',
        sources: [
          {
            kind: 'switch',
            transformKinds: [
              'identity',
            ],
          },
          {
            kind: 'binary',
            transformKinds: [
              'identity',
              'invert',
            ],
          },
          {
            kind: 'numeric',
            requiredUnit: 'W',
            transformKinds: [
              'threshold',
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
    advancedParameters: [],
  },
  'switch': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'on',
        kind: 'boolean',
        label: 'On',
      },
    ],
  },
  'temperature-sensor': {
    version: 1,
    targets: [],
    advancedParameters: [
      {
        path: 'celsius',
        kind: 'number',
        label: 'Temperature',
        unit: '°C',
      },
    ],
  },
} as const satisfies CustomizeCatalog
