import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import {
  RUNNING_POWER_DEFAULTS_BY_TYPE,
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '../running-state/defaults.js'
import { t } from '../device/cap-vocabulary/l10n.js'
import { EventCategory } from '../enums/event-category.js'

export const RunningStateSourceSchema = z.enum(['native', 'assigned'])
export type RunningStateSource = z.infer<typeof RunningStateSourceSchema>

export const RunningStateStatusSchema = z.object({
  /** null = unknown — never coerced to false (D393). */
  running: z.boolean().nullable(),
  /** Epoch ms the current boolean began; null while `running` is null. */
  since: z.number().nullable().meta(readingMeta('none')),
  source: RunningStateSourceSchema.meta({ label: 'Source' }),
  phase: z.string().nullable(),
  /** null until a reading has been published (D393). */
  lastFetchedAt: z.number().nullable(),
})

export type RunningStateStatus = z.infer<typeof RunningStateStatusSchema>

const RunningFlipEventDataSchema = z.object({
  deviceId: z.number(),
  since: z.number().nullable(),
  phase: z.string().nullable(),
})

const RUNNING_DEVICE_TYPES: readonly DeviceType[] = Object.values(DeviceType)

/**
 * Customize offers "running" only where a job makes sense (D933): a cycle,
 * a clean, a mow, playback, or another appliance that is on and working.
 * The cap itself stays on every type — a camera can still report running
 * natively; it just has no card.
 */
export const RUNNING_CUSTOMIZE_DEVICE_TYPES = [
  DeviceType.Washer,
  DeviceType.Dryer,
  DeviceType.Dishwasher,
  DeviceType.Vacuum,
  DeviceType.LawnMower,
  DeviceType.MediaPlayer,
  DeviceType.WaterHeater,
  DeviceType.Humidifier,
  DeviceType.Fan,
  DeviceType.Climate,
  DeviceType.PetFeeder,
] as const

/** Generic Customize target for the running boolean (D936). */
const runningCustomize = {
  version: 1,
  // The assigned source may REPLACE a native `running` (D990): the same target
  // adds it where the device has none. The target's companions ride with it.
  overridable: [{ path: 'running', by: 'running' }],
  targets: [
    {
      id: 'running',
      cardinality: 'scalar',
      vocabulary: { cap: 'running-state', stateField: 'running' },
      deviceTypes: RUNNING_CUSTOMIZE_DEVICE_TYPES,
      apply: 'add',
      path: 'running',
      sources: [
        { kind: 'switch', transforms: [{ kind: 'identity' }] },
        {
          kind: 'binary',
          transforms: [{ kind: 'identity' }, { kind: 'invert' }],
        },
        {
          kind: 'numeric',
          requiredUnit: 'W',
          transforms: [
            {
              kind: 'threshold',
              comparisons: ['gte', 'lte'],
              comparison: 'gte',
              defaultThreshold: RUNNING_POWER_THRESHOLD_WATTS,
              defaultStartDwellMs: RUNNING_POWER_START_DELAY_MS,
              defaultStopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
              deviceTypeDefaults: RUNNING_POWER_DEFAULTS_BY_TYPE,
              thresholdUnit: 'W',
            },
          ],
        },
      ],
      companions: [
        { kind: 'constant', path: 'source', value: 'assigned', when: 'always' },
        // On a replace the NATIVE phase stays: the claimed slice merges over the native one.
        { kind: 'constant', path: 'phase', value: null, when: 'add' },
        { kind: 'clock', path: 'lastFetchedAt', when: 'always' },
        { kind: 'transition-time', path: 'since', sourceChangedAt: 'prefer' },
      ],
      sourceReport: {
        status: 'assignment-status',
        runtimeField: 'source',
        nativeValue: 'native',
        assignedValue: 'assigned',
      },
      advancedExpression: true,
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const runningStateCapability = {
  name: 'running-state',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: RUNNING_DEVICE_TYPES,
  methods: {},
  events: {
    onStarted: {
      data: RunningFlipEventDataSchema,
      trigger: {
        category: EventCategory.RunningStarted,
        label: t('Started running', 'Ha iniziato a funzionare'),
        phrase: t('When {device} starts running', 'Quando {device} inizia a funzionare'),
        icon: 'play',
      },
    },
    onFinished: {
      data: RunningFlipEventDataSchema,
      trigger: {
        category: EventCategory.RunningFinished,
        label: t('Finished', 'Ha finito'),
        phrase: t('When {device} finishes', 'Quando {device} finisce'),
        icon: 'square',
      },
    },
  },
  status: {
    schema: RunningStateStatusSchema,
    kind: 'push',
  },
  runtimeState: RunningStateStatusSchema,
  durability: 'restored',
  history: {
    fields: {
      running: { kind: 'boolean' },
    },
  },
  volatileStateFields: ['lastFetchedAt'],
  customize: runningCustomize,
  vocabulary: {
    noun: t('Running', 'In funzione'),
    order: 2120,
    state: [
      {
        kind: 'boolean',
        field: 'running',
        label: t('Running', 'In funzione'),
        whenTrue: t('When {device} starts', 'Quando {device} inizia'),
        whenFalse: t('When {device} finishes', 'Quando {device} finisce'),
        icon: 'play',
      },
    ],
    overrides: {
      byType: {
        [DeviceType.Washer]: {
          state: {
            running: {
              whenTrue: t('When the washing machine starts', 'Quando la lavatrice inizia'),
              whenFalse: t(
                'When the washing machine has finished',
                'Quando la lavatrice ha finito',
              ),
            },
          },
          events: {
            onStarted: {
              phrase: t('When the washing machine starts', 'Quando la lavatrice inizia'),
            },
            onFinished: {
              phrase: t('When the washing machine has finished', 'Quando la lavatrice ha finito'),
            },
          },
        },
        [DeviceType.Dryer]: {
          state: {
            running: {
              whenTrue: t('When the dryer starts', "Quando l'asciugatrice inizia"),
              whenFalse: t('When the dryer has finished', "Quando l'asciugatrice ha finito"),
            },
          },
          events: {
            onStarted: {
              phrase: t('When the dryer starts', "Quando l'asciugatrice inizia"),
            },
            onFinished: {
              phrase: t('When the dryer has finished', "Quando l'asciugatrice ha finito"),
            },
          },
        },
        [DeviceType.Dishwasher]: {
          state: {
            running: {
              whenTrue: t('When the dishwasher starts', 'Quando la lavastoviglie inizia'),
              whenFalse: t('When the dishwasher has finished', 'Quando la lavastoviglie ha finito'),
            },
          },
          events: {
            onStarted: {
              phrase: t('When the dishwasher starts', 'Quando la lavastoviglie inizia'),
            },
            onFinished: {
              phrase: t('When the dishwasher has finished', 'Quando la lavastoviglie ha finito'),
            },
          },
        },
      },
    },
  },
} as const satisfies CapabilityDefinition

export type IRunningStateProvider = InferProvider<typeof runningStateCapability>
