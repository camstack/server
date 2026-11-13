import { z } from 'zod'
import { DeviceType } from '../device/device-type.js'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { FanDirectionSchema } from './fan-control.cap.js'

/**
 * fan-presets — named settings the operator keeps for a fan ("Night": speed
 * 25 %, horizontal sweep off, angle 30°). A preset is a DESIRED fan-control
 * state (D1034): the fields it names, nothing else. Applying it calls the
 * fan's own `fan-control` methods — `setPreset`, `setPercentage`,
 * `setDirection`, `setOscillationAxis` — and an axis the operator linked in
 * Customize reaches its sibling device through that link, never through a
 * step the preset stores. Every field is reported (applied / failed / not-run
 * / refused), so a caller tells "applied" from "the speed was set but the
 * angle was refused" without parsing text.
 *
 * It is a Customize `config` extension of a fan: the presets are the
 * operator's, stored per device (D865), and the editor is derived from the
 * target below. Every preset is also listed as an `action-source` entry
 * (`fan-preset:<deviceId>/<presetId>`) so the exports that publish actions
 * (a scene, a switch, a button) offer it.
 */

export const FAN_PRESETS_MAX = 12

/** One axis as a preset wants it; an absent field is left as it is. */
export const FanPresetAxisSchema = z.object({
  oscillating: z.boolean().optional(),
  angle: z.number().optional(),
  sweepFrom: z.number().optional(),
  sweepTo: z.number().optional(),
})
export type FanPresetAxis = z.infer<typeof FanPresetAxisSchema>

/** The fan-control state a preset sets; an absent field is left as it is. */
export const FanPresetStateSchema = z.object({
  speed: z.number().min(0).max(100).optional(),
  /** The fan's own preset mode (or the linked select's option). */
  preset: z.string().min(1).optional(),
  direction: FanDirectionSchema.optional(),
  oscillationAxes: z
    .object({
      horizontal: FanPresetAxisSchema.optional(),
      vertical: FanPresetAxisSchema.optional(),
    })
    .optional(),
})
export type FanPresetState = z.infer<typeof FanPresetStateSchema>

export const FanPresetSchema = z.object({
  /** Stable key; never reused after a delete within one device's list. */
  id: z.string().min(1).max(64),
  /** What the operator and a voice assistant call it. */
  name: z.string().trim().min(1).max(40),
  state: FanPresetStateSchema,
})
export type FanPreset = z.infer<typeof FanPresetSchema>

export const FAN_PRESETS_REFUSALS = [
  /** A preset that sets nothing. */
  'empty-state',
  'duplicate-name',
  'duplicate-id',
  'too-many',
  'not-a-fan',
] as const
export const FanPresetsRefusalSchema = z.enum(FAN_PRESETS_REFUSALS)
export type FanPresetsRefusal = z.infer<typeof FanPresetsRefusalSchema>

export const FanPresetsSetResultSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('saved'),
    count: z.number().int().nonnegative(),
  }),
  z.object({
    status: z.literal('refused'),
    reason: FanPresetsRefusalSchema,
    /** Names the preset at fault. */
    detail: z.string(),
  }),
])
export type FanPresetsSetResult = z.infer<typeof FanPresetsSetResultSchema>

export const FanPresetFieldResultSchema = z.object({
  /** The state path: `speed`, `preset`, `direction`, `oscillationAxes.horizontal.angle`. */
  field: z.string(),
  outcome: z.enum(['applied', 'failed', 'not-run', 'refused']),
  /** The cause, for every outcome but `applied`. */
  message: z.string().optional(),
})
export type FanPresetFieldResult = z.infer<typeof FanPresetFieldResultSchema>

export const FanPresetApplyResultSchema = z.object({
  /** `applied`: every field landed. `partial`: some did, one did not. `refused`: nothing ran. */
  status: z.enum(['applied', 'partial', 'refused']),
  fields: z.array(FanPresetFieldResultSchema),
})
export type FanPresetApplyResult = z.infer<typeof FanPresetApplyResultSchema>

/** The fan-control fields a capture may take. */
export const FAN_CAPTURE_FIELDS = ['speed', 'direction', 'preset', 'oscillationAxes'] as const
export const FanCaptureFieldSchema = z.enum(FAN_CAPTURE_FIELDS)
export type FanCaptureField = z.infer<typeof FanCaptureFieldSchema>

export const FanCaptureOmissionSchema = z.object({
  /** A state path (`speed`, `oscillationAxes.vertical.angle`). */
  what: z.string(),
  /** Why no value was taken: an unknown reading is never stored as 0 (D393). */
  reason: z.string(),
})
export type FanCaptureOmission = z.infer<typeof FanCaptureOmissionSchema>

export const FanPresetCaptureResultSchema = z.object({
  /** The fan's CURRENT fan-control state, as a preset; NOT saved. */
  state: FanPresetStateSchema,
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
    getPresets: method(deviceInput, z.array(FanPresetSchema), {
      auth: 'protected',
    }),
    setPresets: method(
      deviceInput.extend({
        presets: z.array(FanPresetSchema).max(FAN_PRESETS_MAX),
      }),
      FanPresetsSetResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    applyPreset: method(
      deviceInput.extend({ presetId: z.string().min(1) }),
      FanPresetApplyResultSchema,
      { kind: 'mutation', auth: 'protected' },
    ),
    /**
     * The fan's CURRENT fan-control state as a preset: the fields named in
     * `fields` (all when absent), read from its merged slice — a field linked
     * in Customize reads its link. A reading that is unknown is left out and
     * named in `omitted`, never captured as 0. Nothing is saved.
     */
    capturePreset: method(
      deviceInput.extend({ fields: z.array(FanCaptureFieldSchema).optional() }),
      FanPresetCaptureResultSchema,
      { auth: 'protected' },
    ),
  },
  customize: fanPresetsCustomize,
  vocabulary: {
    notOperatorFacing:
      'the per-fan presets — authored in the Customize presets editor, applied through the actions the exports list',
  },
} as const satisfies CapabilityDefinition

export type IFanPresetsProvider = InferProvider<typeof fanPresetsCapability>
