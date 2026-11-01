import { z } from 'zod'
import { ActionStepSchema } from '../automation/recipe.js'
import { DeviceType } from '../device/device-type.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'

/**
 * fan-presets — named settings the operator composes for a fan ("Night":
 * speed 25 %, oscillation off, the room's light off). A preset is a short
 * sequence of action steps over the fan itself and the devices that sit in the
 * same container (its siblings); applying it runs the steps in order and
 * reports every one, so a caller tells "applied" from "the speed was set but
 * the light step failed" without parsing text.
 *
 * It is a Customize `config` extension of a fan: the presets are the
 * operator's, stored per device (D865), and the editor is derived from the
 * target below. Every preset is also listed as an `action-source` entry
 * (`fan-preset:<deviceId>/<presetId>`) so the exports that publish actions
 * (a scene, a switch, a button) offer it.
 */

export const FAN_PRESETS_MAX = 12
export const FAN_PRESET_STEPS_MAX = 20

export const FanPresetSchema = z.object({
  /** Stable key; never reused after a delete within one device's list. */
  id: z.string().min(1).max(64),
  /** What the operator and a voice assistant call it. */
  name: z.string().trim().min(1).max(40),
  steps: z.array(ActionStepSchema).min(1).max(FAN_PRESET_STEPS_MAX),
})
export type FanPreset = z.infer<typeof FanPresetSchema>

export const FAN_PRESETS_REFUSALS = [
  'not-sibling',
  'bad-target',
  'duplicate-name',
  'duplicate-id',
  'too-many',
  'not-a-fan',
] as const
export const FanPresetsRefusalSchema = z.enum(FAN_PRESETS_REFUSALS)
export type FanPresetsRefusal = z.infer<typeof FanPresetsRefusalSchema>

export const FanPresetsSetResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('saved'), count: z.number().int().nonnegative() }),
  z.object({
    status: z.literal('refused'),
    reason: FanPresetsRefusalSchema,
    /** Names the preset and step at fault. */
    detail: z.string(),
  }),
])
export type FanPresetsSetResult = z.infer<typeof FanPresetsSetResultSchema>

export const FanPresetStepResultSchema = z.object({
  index: z.number().int().nonnegative(),
  outcome: z.enum(['applied', 'failed', 'not-run', 'refused']),
  deviceId: z.number().int().nonnegative().optional(),
  cap: z.string().optional(),
  method: z.string().optional(),
  /** The cause, for every outcome but `applied`. */
  message: z.string().optional(),
})
export type FanPresetStepResult = z.infer<typeof FanPresetStepResultSchema>

export const FanPresetApplyResultSchema = z.object({
  /** `applied`: every step ran. `partial`: some ran, one failed. `refused`: nothing ran. */
  status: z.enum(['applied', 'partial', 'refused']),
  steps: z.array(FanPresetStepResultSchema),
})
export type FanPresetApplyResult = z.infer<typeof FanPresetApplyResultSchema>

/** The fan's own readings a capture may take. */
export const FAN_CAPTURE_FIELDS = ['speed', 'oscillating', 'direction', 'preset'] as const
export const FanCaptureFieldSchema = z.enum(FAN_CAPTURE_FIELDS)
export type FanCaptureField = z.infer<typeof FanCaptureFieldSchema>

export const FanCaptureOmissionSchema = z.object({
  /** A fan field (`speed`) or `step <n>` for a sibling step. */
  what: z.string(),
  /** Why no value was taken: unknown reading (never stored as 0, D393), or a step that cannot be read. */
  reason: z.string(),
})
export type FanCaptureOmission = z.infer<typeof FanCaptureOmissionSchema>

export const FanPresetCaptureResultSchema = z.object({
  /** The steps filled from the device's current values; NOT saved. */
  steps: z.array(ActionStepSchema),
  omitted: z.array(FanCaptureOmissionSchema),
})
export type FanPresetCaptureResult = z.infer<typeof FanPresetCaptureResultSchema>

const deviceInput = z.object({ deviceId: z.number().int().nonnegative() })

const FAN_PRESETS_DEVICE_TYPES = [DeviceType.Fan] as const

const fanPresetsCustomize = {
  version: 1,
  targets: [
    {
      id: 'presets',
      cardinality: 'config',
      vocabulary: { cap: 'fan-presets' },
      deviceTypes: FAN_PRESETS_DEVICE_TYPES,
      apply: 'add',
      readMethod: 'getPresets',
      writeMethod: 'setPresets',
    },
  ],
} as const satisfies CapabilityCustomizeSpec

export const fanPresetsCapability = {
  name: 'fan-presets',
  scope: 'system',
  mode: 'singleton',
  methods: {
    getPresets: method(deviceInput, z.array(FanPresetSchema), { auth: 'protected' }),
    setPresets: method(
      deviceInput.extend({ presets: z.array(FanPresetSchema).max(FAN_PRESETS_MAX) }),
      FanPresetsSetResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    applyPreset: method(
      deviceInput.extend({ presetId: z.string().min(1) }),
      FanPresetApplyResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
    /**
     * Fills steps from the CURRENT values: the fan's own fields named in
     * `fields` (all when absent) and the sibling `steps` already composed
     * (a control value, a switch state). A reading that is unknown is left out
     * and named in `omitted`, never captured as 0. Nothing is saved.
     */
    capturePreset: method(
      deviceInput.extend({
        fields: z.array(FanCaptureFieldSchema).optional(),
        steps: z.array(ActionStepSchema).max(FAN_PRESET_STEPS_MAX).default([]),
      }),
      FanPresetCaptureResultSchema,
      { auth: 'protected' },
    ),
  },
  customize: fanPresetsCustomize,
} as const satisfies CapabilityDefinition

export type IFanPresetsProvider = InferProvider<typeof fanPresetsCapability>
