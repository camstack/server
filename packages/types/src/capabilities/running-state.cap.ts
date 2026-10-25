import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import {
  RUNNING_POWER_START_DELAY_MS,
  RUNNING_POWER_STOP_DELAY_MS,
  RUNNING_POWER_THRESHOLD_WATTS,
} from '../running-state/defaults.js'

export const RunningStateSourceSchema = z.enum(['native', 'assigned'])
export type RunningStateSource = z.infer<typeof RunningStateSourceSchema>

export const RunningStateStatusSchema = z.object({
  /** null = unknown — never coerced to false (D393). */
  running: z.boolean().nullable(),
  /** Epoch ms the current boolean began; null while `running` is null. */
  since: z.number().nullable(),
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
 * Washer and dryer are not device types yet. The cap itself stays on every
 * type — a camera can still report running natively; it just has no card.
 */
const RUNNING_CUSTOMIZE_DEVICE_TYPES = [
  DeviceType.Dishwasher,
  DeviceType.Vacuum,
  DeviceType.LawnMower,
  DeviceType.MediaPlayer,
  DeviceType.WaterHeater,
  DeviceType.Humidifier,
  DeviceType.Fan,
  DeviceType.Climate,
  DeviceType.Thermostat,
  DeviceType.PetFeeder,
] as const

/** Generic Customize target for the running boolean (D936). */
const runningCustomize = {
  version: 1,
  advanced: 'derive',
  targets: [
    {
      id: 'running',
      cardinality: 'scalar',
      vocabulary: { cap: 'running-state', stateField: 'running' },
      deviceTypes: RUNNING_CUSTOMIZE_DEVICE_TYPES,
      apply: 'add-or-replace',
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
              comparison: 'gte',
              defaultThreshold: RUNNING_POWER_THRESHOLD_WATTS,
              defaultStartDwellMs: RUNNING_POWER_START_DELAY_MS,
              defaultStopDwellMs: RUNNING_POWER_STOP_DELAY_MS,
              thresholdUnit: 'W',
            },
          ],
        },
      ],
      companions: [
        { kind: 'constant', path: 'source', value: 'assigned', when: 'always' },
        { kind: 'constant', path: 'phase', value: null, when: 'always' },
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
    },
    onFinished: {
      data: RunningFlipEventDataSchema,
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
} as const satisfies CapabilityDefinition

export type IRunningStateProvider = InferProvider<typeof runningStateCapability>
