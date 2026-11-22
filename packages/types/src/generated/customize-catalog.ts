// AUTO-GENERATED — do not edit manually.
// Regenerate with: npx tsx scripts/generate-customize-catalog.ts
/* eslint-disable */

import type { CustomizeCatalog } from '../capabilities/customize-catalog.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Customize catalog, projected from every `*.cap.ts` `customize` block.
 * 15 caps. Field keys are `runtimeState` paths. No Zod.
 */
export const CAP_CUSTOMIZE_CATALOG = {
  'battery': {
    version: 1,
    targets: [
      {
        id: 'level',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Camera, DeviceType.Sensor, DeviceType.Button, DeviceType.Switch, DeviceType.PetFeeder, DeviceType.Container, DeviceType.Climate, DeviceType.EventEmitter],
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
  'climate-control': {
    version: 1,
    targets: [
      {
        id: 'room-temperature',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Climate],
        apply: 'replace',
        vocabularyCap: 'climate-control',
        vocabularyStateField: 'currentTemp',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        path: 'currentTemp',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'room-humidity',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Climate],
        apply: 'replace',
        vocabularyCap: 'climate-control',
        vocabularyStateField: 'currentHumidity',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        path: 'currentHumidity',
        valueKind: 'number',
        nullable: true,
      },
    ],
    overridable: [
      {
        path: 'currentTemp',
        by: 'room-temperature',
      },
      {
        path: 'currentHumidity',
        by: 'room-humidity',
      },
    ],
  },
  'consumables': {
    version: 1,
    targets: [
      {
        id: 'items',
        cardinality: 'keyedArray',
        deviceTypes: [DeviceType.Camera, DeviceType.Light, DeviceType.Siren, DeviceType.Switch, DeviceType.Sensor, DeviceType.Climate, DeviceType.Button, DeviceType.EventEmitter, DeviceType.Update, DeviceType.Generic, DeviceType.Notifier, DeviceType.Script, DeviceType.Automation, DeviceType.Lock, DeviceType.Cover, DeviceType.Valve, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.Fan, DeviceType.MediaPlayer, DeviceType.AlarmPanel, DeviceType.Control, DeviceType.Presence, DeviceType.Weather, DeviceType.WeatherStation, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.Container, DeviceType.Image, DeviceType.PetFeeder, DeviceType.PetFountain, DeviceType.Dishwasher, DeviceType.Washer, DeviceType.Dryer, DeviceType.Gateway, DeviceType.HeatPump, DeviceType.Vehicle, DeviceType.EnergySystem, DeviceType.Workload],
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
                  'distance',
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
  'energy-system': {
    version: 1,
    targets: [],
    links: [
      {
        id: 'heat-pump',
        sourceCap: 'heat-pump-status',
        mode: 'reference',
        slot: 'heatPump',
        deviceTypes: [DeviceType.EnergySystem],
        apply: 'add',
      },
    ],
  },
  'fan-control': {
    version: 1,
    targets: [
      {
        id: 'horizontal-oscillating',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
        vocabularyStateField: 'oscillating',
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
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.horizontal.oscillating',
        valueKind: 'boolean',
        nullable: true,
      },
      {
        id: 'horizontal-angle',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.horizontal.angle',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'source-field',
            path: 'oscillationAxes.horizontal.min',
            field: 'min',
          },
          {
            kind: 'source-field',
            path: 'oscillationAxes.horizontal.max',
            field: 'max',
          },
          {
            kind: 'source-field',
            path: 'oscillationAxes.horizontal.step',
            field: 'step',
          },
        ],
      },
      {
        id: 'horizontal-sweepFrom',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.horizontal.sweepFrom',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'horizontal-sweepTo',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.horizontal.sweepTo',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'vertical-oscillating',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
        vocabularyStateField: 'oscillating',
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
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.vertical.oscillating',
        valueKind: 'boolean',
        nullable: true,
      },
      {
        id: 'vertical-angle',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.vertical.angle',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'source-field',
            path: 'oscillationAxes.vertical.min',
            field: 'min',
          },
          {
            kind: 'source-field',
            path: 'oscillationAxes.vertical.max',
            field: 'max',
          },
          {
            kind: 'source-field',
            path: 'oscillationAxes.vertical.step',
            field: 'step',
          },
        ],
      },
      {
        id: 'vertical-sweepFrom',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.vertical.sweepFrom',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'vertical-sweepTo',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        section: 'oscillation-axes',
        path: 'oscillationAxes.vertical.sweepTo',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'preset',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Fan],
        apply: 'replace',
        vocabularyCap: 'fan-control',
        sources: [
          {
            kind: 'field',
            valueKinds: [
              'string',
            ],
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
        advancedExpression: false,
        path: 'preset',
        valueKind: 'string',
        nullable: false,
      },
    ],
    overridable: [
      {
        path: 'oscillationAxes.horizontal.oscillating',
        by: 'horizontal-oscillating',
      },
      {
        path: 'oscillationAxes.horizontal.angle',
        by: 'horizontal-angle',
      },
      {
        path: 'oscillationAxes.horizontal.sweepFrom',
        by: 'horizontal-sweepFrom',
      },
      {
        path: 'oscillationAxes.horizontal.sweepTo',
        by: 'horizontal-sweepTo',
      },
      {
        path: 'oscillationAxes.vertical.oscillating',
        by: 'vertical-oscillating',
      },
      {
        path: 'oscillationAxes.vertical.angle',
        by: 'vertical-angle',
      },
      {
        path: 'oscillationAxes.vertical.sweepFrom',
        by: 'vertical-sweepFrom',
      },
      {
        path: 'oscillationAxes.vertical.sweepTo',
        by: 'vertical-sweepTo',
      },
      {
        path: 'preset',
        by: 'preset',
      },
    ],
  },
  'fan-presets': {
    version: 1,
    targets: [
      {
        id: 'presets',
        cardinality: 'config',
        deviceTypes: [DeviceType.Fan],
        apply: 'add',
        readMethod: 'getPresets',
        writeMethod: 'setPresets',
        vocabularyCap: 'fan-presets',
        sources: [],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
      },
    ],
  },
  'heat-pump-status': {
    version: 1,
    targets: [
      {
        id: 'electrical-power',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.HeatPump],
        apply: 'replace',
        vocabularyCap: 'heat-pump-status',
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
        advancedExpression: false,
        path: 'power.electricalW',
        valueKind: 'number',
        nullable: true,
      },
      {
        id: 'electrical-energy',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.HeatPump],
        apply: 'replace',
        vocabularyCap: 'heat-pump-status',
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
        advancedExpression: false,
        path: 'energy.electricalKwh',
        valueKind: 'number',
        nullable: true,
      },
    ],
    overridable: [
      {
        path: 'power.electricalW',
        by: 'electrical-power',
      },
      {
        path: 'energy.electricalKwh',
        by: 'electrical-energy',
      },
    ],
  },
  'lock-control': {
    version: 1,
    targets: [
      {
        id: 'door-contact',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Lock],
        apply: 'replace',
        vocabularyCap: 'lock-control',
        vocabularyStateField: 'state',
        sources: [
          {
            kind: 'binary',
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
        advancedExpression: false,
        path: 'state',
        override: {
          whenSourceTrue: 'door-open',
          unlessNative: [
            'jammed',
          ],
        },
        valueKind: 'enum',
        nullable: false,
        enumValues: [
          'locked',
          'unlocked',
          'locking',
          'unlocking',
          'jammed',
          'door-open',
        ],
      },
    ],
    overridable: [
      {
        path: 'state',
        by: 'door-contact',
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
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder, DeviceType.Workload],
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
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder, DeviceType.Workload],
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
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder, DeviceType.Workload],
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
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder, DeviceType.Workload],
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
    links: [
      {
        id: 'meter-device',
        sourceCap: 'power-meter',
        mode: 'project',
        apply: 'add',
        deviceTypes: [DeviceType.Switch, DeviceType.Light, DeviceType.Fan, DeviceType.Climate, DeviceType.Humidifier, DeviceType.WaterHeater, DeviceType.MediaPlayer, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.PetFeeder, DeviceType.Workload],
      },
    ],
  },
  'power-source': {
    version: 1,
    targets: [
      {
        id: 'switch',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.Gateway, DeviceType.Camera, DeviceType.Sensor, DeviceType.MediaPlayer, DeviceType.Vacuum, DeviceType.Generic, DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.PetFountain, DeviceType.Fan, DeviceType.Humidifier, DeviceType.Climate, DeviceType.WaterHeater, DeviceType.Light, DeviceType.Switch],
        apply: 'add',
        vocabularyCap: 'power-source',
        vocabularyStateField: 'switchOn',
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
        ],
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        path: 'switchOn',
        valueKind: 'boolean',
        nullable: true,
        companions: [
          {
            kind: 'constant',
            path: 'offSeconds',
            value: 10,
            when: 'add',
            formerValues: [
              0,
            ],
          },
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
        deviceTypes: [DeviceType.Washer, DeviceType.Dryer, DeviceType.Dishwasher, DeviceType.Vacuum, DeviceType.LawnMower, DeviceType.MediaPlayer, DeviceType.WaterHeater, DeviceType.Humidifier, DeviceType.Fan, DeviceType.Climate, DeviceType.PetFeeder],
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
                deviceTypeDefaults: {
                  [DeviceType.MediaPlayer]: {
                    startDwellMs: 10000,
                    stopDwellMs: 10000,
                    minSamples: 1,
                  },
                },
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
            when: 'add',
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
    overridable: [
      {
        path: 'running',
        by: 'running',
      },
    ],
  },
  'weather-station': {
    version: 1,
    targets: [
      {
        id: 'temperature',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'temperature',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '°C',
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
        advancedExpression: false,
        path: 'temperature',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'humidity',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'humidity',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '%',
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
        advancedExpression: false,
        path: 'humidity',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'pressure',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'pressure',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'hPa',
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
        advancedExpression: false,
        path: 'pressure',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'windSpeed',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'windSpeed',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'm/s',
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
        advancedExpression: false,
        path: 'windSpeed',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'windGust',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'windGust',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'm/s',
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
        advancedExpression: false,
        path: 'windGust',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'windBearing',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'windBearing',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '°',
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
        advancedExpression: false,
        path: 'windBearing',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainRate',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainRate',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm/h',
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
        advancedExpression: false,
        path: 'rainRate',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainDaily',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainDaily',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rainDaily',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainEvent',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainEvent',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rainEvent',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'uv',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'uv',
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
        sourceReport: {
          status: 'assignment-status',
        },
        advancedExpression: false,
        path: 'uv',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'solarRadiation',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'solarRadiation',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'W/m²',
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
        advancedExpression: false,
        path: 'solarRadiation',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'dewPoint',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'dewPoint',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '°C',
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
        advancedExpression: false,
        path: 'dewPoint',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'feelsLike',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'feelsLike',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '°C',
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
        advancedExpression: false,
        path: 'feelsLike',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'vpd',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'vpd',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'kPa',
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
        advancedExpression: false,
        path: 'vpd',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'windGustMax',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'windGustMax',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'm/s',
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
        advancedExpression: false,
        path: 'windGustMax',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'windBearingAvg',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'windBearingAvg',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: '°',
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
        advancedExpression: false,
        path: 'windBearingAvg',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rain24h',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rain24h',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rain24h',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainWeekly',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainWeekly',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rainWeekly',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainMonthly',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainMonthly',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rainMonthly',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
      {
        id: 'rainYearly',
        cardinality: 'scalar',
        deviceTypes: [DeviceType.WeatherStation],
        apply: 'add',
        vocabularyCap: 'weather-station',
        vocabularyStateField: 'rainYearly',
        sources: [
          {
            kind: 'numeric',
            requiredUnit: 'mm',
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
        advancedExpression: false,
        path: 'rainYearly',
        valueKind: 'number',
        nullable: true,
        companions: [
          {
            kind: 'clock',
            path: 'lastFetchedAt',
            when: 'add',
          },
        ],
      },
    ],
    overridable: [
      {
        path: 'temperature',
        by: 'temperature',
      },
      {
        path: 'humidity',
        by: 'humidity',
      },
      {
        path: 'pressure',
        by: 'pressure',
      },
      {
        path: 'windSpeed',
        by: 'windSpeed',
      },
      {
        path: 'windGust',
        by: 'windGust',
      },
      {
        path: 'windBearing',
        by: 'windBearing',
      },
      {
        path: 'rainRate',
        by: 'rainRate',
      },
      {
        path: 'rainDaily',
        by: 'rainDaily',
      },
      {
        path: 'rainEvent',
        by: 'rainEvent',
      },
      {
        path: 'uv',
        by: 'uv',
      },
      {
        path: 'solarRadiation',
        by: 'solarRadiation',
      },
      {
        path: 'dewPoint',
        by: 'dewPoint',
      },
      {
        path: 'feelsLike',
        by: 'feelsLike',
      },
      {
        path: 'vpd',
        by: 'vpd',
      },
      {
        path: 'windGustMax',
        by: 'windGustMax',
      },
      {
        path: 'windBearingAvg',
        by: 'windBearingAvg',
      },
      {
        path: 'rain24h',
        by: 'rain24h',
      },
      {
        path: 'rainWeekly',
        by: 'rainWeekly',
      },
      {
        path: 'rainMonthly',
        by: 'rainMonthly',
      },
      {
        path: 'rainYearly',
        by: 'rainYearly',
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
    temperatureC: '°C',
  },
  'humidity-sensor': {
    humidity: '%',
  },
  'location': {
    latitude: '°',
    longitude: '°',
    accuracy: 'm',
    heading: '°',
    speed: 'm/s',
  },
  'power-meter': {
    power: 'W',
    deliveredPower: 'W',
    energy: 'kWh',
    voltage: 'V',
    current: 'A',
  },
  'temperature-sensor': {
    temperature: '°C',
  },
  'vehicle': {
    odometer: 'm',
    range: 'm',
    auxBatteryLevel: '%',
    auxBatteryVoltage: 'V',
  },
}
