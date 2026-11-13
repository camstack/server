import { z } from 'zod'
import {
  type CapabilityDefinition,
  type InferProvider,
  optionalMethod,
} from './capability-definition.js'
import type { CapabilityCustomizeSpec, ScalarCustomizeTarget } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'
import { readingMeta } from '../units/quantity.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/**
 * Fan-control cap. Models HA `fan.*` entity-specific surfaces:
 * speed percentage, preset modes, ceiling-fan direction, and
 * oscillation. The on/off state lives on the existing `switch` cap
 * (Fan devices register `switch + fan-control`, mirroring the
 * Light pattern of `switch + brightness + color`).
 *
 * `availablePresets` mirrors HA's `preset_modes` attribute so the
 * UI renders a closed-list picker without a separate `getOptions`
 * round-trip. `direction` and `oscillating` are nullable — most
 * fans don't expose them.
 *
 * Sub-surface gating paired with `DeviceFeature` flags:
 *   - `FanSpeed` — speed-percentage slider
 *   - `FanPreset` — preset selector
 *   - `FanDirection` — direction toggle (ceiling fans)
 *   - `FanOscillating` — oscillation toggle
 *
 * Per-axis oscillation (`oscillationAxes`, `setOscillationAxis`, D1034): an air
 * circulator sweeps horizontally and vertically, each axis with its own
 * switch, fixed angle, sweep bounds and limits. A provider may report them
 * natively; otherwise the OPERATOR links sibling devices to each field in
 * Customize (a `replace` over the fields listed in `overridable` — nothing is
 * linked or inferred by itself), and a write to a linked field is forwarded to
 * its source. `oscillating` stays the single summary flag: when axes exist it
 * means "any axis oscillates" (`anyAxisOscillating`).
 */

export const FanDirectionSchema = z.enum(['forward', 'reverse'])
export type FanDirection = z.infer<typeof FanDirectionSchema>

export const FAN_OSCILLATION_AXES = ['horizontal', 'vertical'] as const
export const FanOscillationAxisNameSchema = z.enum(FAN_OSCILLATION_AXES)
export type FanOscillationAxisName = z.infer<typeof FanOscillationAxisNameSchema>

/** The fields of one axis a caller may set. */
export const FAN_OSCILLATION_AXIS_SETTABLE = [
  'oscillating',
  'angle',
  'sweepFrom',
  'sweepTo',
] as const
export const FanOscillationAxisFieldSchema = z.enum(FAN_OSCILLATION_AXIS_SETTABLE)
export type FanOscillationAxisField = z.infer<typeof FanOscillationAxisFieldSchema>

/** The limits of one axis, read from the source that serves its angle. */
export const FAN_OSCILLATION_AXIS_LIMITS = ['min', 'max', 'step'] as const
export type FanOscillationAxisLimit = (typeof FAN_OSCILLATION_AXIS_LIMITS)[number]

/**
 * One oscillation axis. Every reading the device has not reported is `null`,
 * never `0` (D393): `0°` is a real position. Each leaf defaults to `null`, so
 * a slice that names only the leaves it knows (a Customize link of one field)
 * is still a whole axis.
 */
export const FanOscillationAxisSchema = z.object({
  /** Whether the axis sweeps. */
  oscillating: z.boolean().nullable().default(null),
  /** The fixed position (degrees) the axis holds when it does not sweep. */
  angle: z.number().nullable().default(null),
  /** The sweep bounds (degrees): left → right, bottom → top. */
  sweepFrom: z.number().nullable().default(null),
  sweepTo: z.number().nullable().default(null),
  /** The angles the axis accepts. Null when the device states none. */
  min: z.number().nullable().default(null),
  max: z.number().nullable().default(null),
  step: z.number().nullable().default(null),
})
export type FanOscillationAxis = z.infer<typeof FanOscillationAxisSchema>

/** Both axes; an axis the device does not have is `null`. */
export const FanOscillationAxesSchema = z.object({
  horizontal: FanOscillationAxisSchema.nullable().default(null),
  vertical: FanOscillationAxisSchema.nullable().default(null),
})
export type FanOscillationAxes = z.infer<typeof FanOscillationAxesSchema>

export const FAN_OSCILLATION_AXIS_REFUSALS = [
  /** No field to set was given. */
  'nothing-to-set',
  /** The field is neither linked in Customize nor served by the native provider. */
  'axis-not-linked',
  /** An angle lies outside the axis limits. */
  'out-of-range',
  /** The linked source device no longer exists. */
  'source-gone',
  /** The linked source could not be resolved (the device index did not answer). */
  'source-unknown',
  /** The linked source (or the native provider) rejected the call. */
  'source-call-failed',
] as const
export const FanOscillationAxisRefusalSchema = z.enum(FAN_OSCILLATION_AXIS_REFUSALS)
export type FanOscillationAxisRefusal = z.infer<typeof FanOscillationAxisRefusalSchema>

export const FanOscillationAxisResultSchema = z.discriminatedUnion('status', [
  z.object({ status: z.literal('applied') }),
  z.object({
    status: z.literal('refused'),
    reason: FanOscillationAxisRefusalSchema,
    /** The field at fault, when one is. */
    field: FanOscillationAxisFieldSchema.optional(),
    /** One line for the operator, naming the axis, the field and the source. */
    detail: z.string(),
    /** Fields that DID land before the refusal (writes run in order, stop at the first failure). */
    applied: z.array(FanOscillationAxisFieldSchema),
  }),
])
export type FanOscillationAxisResult = z.infer<typeof FanOscillationAxisResultSchema>

export const SetOscillationAxisInputSchema = z.object({
  deviceId: z.number().int().nonnegative(),
  axis: FanOscillationAxisNameSchema,
  oscillating: z.boolean().optional(),
  angle: z.number().optional(),
  sweepFrom: z.number().optional(),
  sweepTo: z.number().optional(),
})
export type SetOscillationAxisInput = z.infer<typeof SetOscillationAxisInputSchema>

/** The state path of one axis field: `oscillationAxes.<axis>.<field>`. */
export function fanAxisPath(
  axis: FanOscillationAxisName,
  field: FanOscillationAxisField | FanOscillationAxisLimit,
): string {
  return `oscillationAxes.${axis}.${field}`
}

export const FanControlStatusSchema = z.object({
  /** Active speed as 0..100 inclusive. Null when the device has no
   *  speed surface (single-speed fan). */
  speed: z.number().min(0).max(100).nullable().meta(readingMeta('percentage')),
  /** Speed granularity the device accepts (HA `percentage_step`, e.g. 25 for
   *  a 4-speed fan). Absent when unknown — the UI then falls back to step 1. */
  percentageStep: z.number().positive().optional().meta(readingMeta('percentage')),
  /** Active preset mode (`auto` / `quiet` / `turbo` / vendor-specific)
   *  — empty string when no preset is active or supported. */
  preset: z.string(),
  /** Available preset modes the device accepts. */
  availablePresets: z.array(z.string()),
  /** Ceiling-fan blade direction. Null when the device has no
   *  direction surface. */
  direction: FanDirectionSchema.nullable(),
  /** Oscillation toggle. Null when the device has no oscillation
   *  surface. */
  oscillating: z.boolean().nullable(),
  /**
   * Per-axis oscillation (air circulators). Absent when the device has no
   * per-axis surface and nothing is linked in Customize.
   */
  oscillationAxes: FanOscillationAxesSchema.optional(),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
})

export type FanControlStatus = z.infer<typeof FanControlStatusSchema>

/**
 * The summary flag: with axes, "any axis oscillates"; without an axis that
 * reports, the device's own `oscillating`.
 */
export function anyAxisOscillating(
  status: Pick<FanControlStatus, 'oscillating' | 'oscillationAxes'>,
): boolean | null {
  const axes = status.oscillationAxes
  if (axes === undefined) return status.oscillating
  const known = FAN_OSCILLATION_AXES.flatMap((axis) => {
    const value = axes[axis]?.oscillating
    return value === null || value === undefined ? [] : [value]
  })
  if (known.length === 0) return status.oscillating
  return known.some(Boolean)
}

const FAN_CUSTOMIZE_DEVICE_TYPES = [DeviceType.Fan] as const

/** The Customize section the axis targets are listed under. */
const AXES_SECTION = 'oscillation-axes' as const

function axisOscillatingTarget(axis: FanOscillationAxisName): ScalarCustomizeTarget {
  return {
    id: `${axis}-oscillating`,
    cardinality: 'scalar',
    vocabulary: { cap: 'fan-control', stateField: 'oscillating' },
    deviceTypes: FAN_CUSTOMIZE_DEVICE_TYPES,
    apply: 'replace',
    section: AXES_SECTION,
    path: fanAxisPath(axis, 'oscillating'),
    sources: [{ kind: 'switch', transforms: [{ kind: 'identity' }] }],
    sourceReport: { status: 'assignment-status' },
  }
}

/**
 * A numeric axis field. The `angle` link also carries the axis limits, read
 * from the SAME linked control's own range (`min`/`max`/`step`), so the limits
 * are the source's, never guessed.
 */
function axisNumericTarget(
  axis: FanOscillationAxisName,
  field: 'angle' | 'sweepFrom' | 'sweepTo',
): ScalarCustomizeTarget {
  const base: ScalarCustomizeTarget = {
    id: `${axis}-${field}`,
    cardinality: 'scalar',
    vocabulary: { cap: 'fan-control' },
    deviceTypes: FAN_CUSTOMIZE_DEVICE_TYPES,
    apply: 'replace',
    section: AXES_SECTION,
    path: fanAxisPath(axis, field),
    sources: [{ kind: 'numeric', transforms: [{ kind: 'identity' }] }],
    sourceReport: { status: 'assignment-status' },
  }
  if (field !== 'angle') return base
  return {
    ...base,
    companions: FAN_OSCILLATION_AXIS_LIMITS.map((limit) => ({
      kind: 'source-field' as const,
      path: fanAxisPath(axis, limit),
      field: limit,
    })),
  }
}

const AXIS_TARGETS: readonly ScalarCustomizeTarget[] = FAN_OSCILLATION_AXES.flatMap((axis) => [
  axisOscillatingTarget(axis),
  axisNumericTarget(axis, 'angle'),
  axisNumericTarget(axis, 'sweepFrom'),
  axisNumericTarget(axis, 'sweepTo'),
])

/** A select (an enum control) the operator links to the fan's `preset`. */
const PRESET_TARGET: ScalarCustomizeTarget = {
  id: 'preset',
  cardinality: 'scalar',
  vocabulary: { cap: 'fan-control' },
  deviceTypes: FAN_CUSTOMIZE_DEVICE_TYPES,
  apply: 'replace',
  path: 'preset',
  sources: [
    {
      kind: 'field',
      valueKinds: ['string'],
      transforms: [{ kind: 'identity' }],
    },
  ],
  sourceReport: { status: 'assignment-status' },
}

const FAN_CONTROL_TARGETS: readonly ScalarCustomizeTarget[] = [...AXIS_TARGETS, PRESET_TARGET]

/**
 * Customize (D1034): the fan already serves `fan-control` natively, so every
 * target is a `replace` over a field listed in `overridable` — the axis leaves
 * and `preset`, nothing else. Nothing is pre-linked: the operator picks each
 * source (D356).
 */
const fanControlCustomize = {
  version: 1,
  overridable: FAN_CONTROL_TARGETS.map((target) => ({
    path: target.path,
    by: target.id,
  })),
  targets: FAN_CONTROL_TARGETS,
} as const satisfies CapabilityCustomizeSpec

export const fanControlCapability = {
  name: 'fan-control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Fan],
  methods: {
    setPercentage: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        speed: z.number().min(0).max(100),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'fan.off',
            label: t('Fan off', 'Ventilatore spento'),
            phrase: t('Stop {device}', 'Ferma {device}'),
            icon: 'power-off',
            effect: { field: 'speed', value: 0 },
            args: { speed: 0 },
          },
          {
            id: 'fan.full',
            label: t('Fan full', 'Ventilatore al massimo'),
            phrase: t('Run {device} at full speed', 'Porta {device} alla massima velocità'),
            icon: 'fan',
            effect: { field: 'speed', value: 100 },
            args: { speed: 100 },
          },
          {
            id: 'fan.speed',
            label: t('Set speed', 'Imposta la velocità'),
            phrase: t(
              'Set the speed of {device} to {speed}',
              'Imposta la velocità di {device} al {speed}',
            ),
            icon: 'fan',
            effect: { field: 'speed', fromArg: 'speed' },
            openArgs: [
              {
                key: 'speed',
                label: t('Speed', 'Velocità'),
                offer: { kind: 'number', min: 0, max: 100, step: 1, unit: '%' },
              },
            ],
          },
        ],
      },
    ),
    setPreset: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        preset: z.string().min(1),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'fan.preset',
            label: t('Set preset', 'Imposta il preset'),
            phrase: t('Set {device} to preset {preset}', 'Imposta {device} sul preset {preset}'),
            icon: 'list',
            openArgs: [
              {
                key: 'preset',
                label: t('Preset', 'Preset'),
                offer: {
                  kind: 'dynamic',
                  from: 'status',
                  field: 'availablePresets',
                },
              },
            ],
          },
        ],
      },
    ),
    setDirection: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        direction: FanDirectionSchema,
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'fan.forward',
            label: t('Spin forward', 'Rotazione avanti'),
            phrase: t('Spin {device} forward', 'Fai girare {device} in avanti'),
            icon: 'refresh-cw',
            effect: { field: 'direction', value: 'forward' },
            args: { direction: 'forward' },
          },
          {
            id: 'fan.reverse',
            label: t('Spin in reverse', 'Rotazione inversa'),
            phrase: t('Spin {device} in reverse', 'Fai girare {device} al contrario'),
            icon: 'rotate-ccw',
            effect: { field: 'direction', value: 'reverse' },
            args: { direction: 'reverse' },
          },
        ],
      },
    ),
    setOscillating: optionalMethod(
      z.object({
        deviceId: z.number().int().nonnegative(),
        oscillating: z.boolean(),
      }),
      z.void(),
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'fan.oscillateOn',
            label: t('Oscillate', 'Oscillazione attiva'),
            phrase: t('Make {device} oscillate', 'Fai oscillare {device}'),
            icon: 'move-horizontal',
            effect: { field: 'oscillating', value: true },
            args: { oscillating: true },
          },
          {
            id: 'fan.oscillateOff',
            label: t('Stop oscillating', 'Oscillazione spenta'),
            phrase: t('Stop {device} oscillating', 'Ferma l’oscillazione di {device}'),
            icon: 'move-horizontal',
            effect: { field: 'oscillating', value: false },
            args: { oscillating: false },
          },
        ],
      },
    ),
    /**
     * Sets one oscillation axis: its switch, fixed angle and/or sweep bounds.
     * Fields left out are untouched. A field linked in Customize is forwarded
     * to its linked source (D1034); otherwise the native provider serves it;
     * neither → `axis-not-linked`. Ranges are checked against the axis limits
     * before anything is written; writes run in order and stop at the first
     * failure, which the result names.
     */
    setOscillationAxis: optionalMethod(
      SetOscillationAxisInputSchema,
      FanOscillationAxisResultSchema,
      {
        kind: 'mutation',
        auth: 'protected',
        actions: [
          {
            id: 'fan.horizontalOscillateOn',
            label: t('Horizontal oscillation on', 'Oscillazione orizzontale attiva'),
            phrase: t(
              'Start the horizontal oscillation of {device}',
              'Attiva l’oscillazione orizzontale di {device}',
            ),
            icon: 'move-horizontal',
            args: { axis: 'horizontal', oscillating: true },
          },
          {
            id: 'fan.horizontalOscillateOff',
            label: t('Horizontal oscillation off', 'Oscillazione orizzontale spenta'),
            phrase: t(
              'Stop the horizontal oscillation of {device}',
              'Ferma l’oscillazione orizzontale di {device}',
            ),
            icon: 'move-horizontal',
            args: { axis: 'horizontal', oscillating: false },
          },
          {
            id: 'fan.verticalOscillateOn',
            label: t('Vertical oscillation on', 'Oscillazione verticale attiva'),
            phrase: t(
              'Start the vertical oscillation of {device}',
              'Attiva l’oscillazione verticale di {device}',
            ),
            icon: 'move-vertical',
            args: { axis: 'vertical', oscillating: true },
          },
          {
            id: 'fan.verticalOscillateOff',
            label: t('Vertical oscillation off', 'Oscillazione verticale spenta'),
            phrase: t(
              'Stop the vertical oscillation of {device}',
              'Ferma l’oscillazione verticale di {device}',
            ),
            icon: 'move-vertical',
            args: { axis: 'vertical', oscillating: false },
          },
        ],
      },
    ),
  },
  status: {
    schema: FanControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI fan speed
   * sliders read `speed` for live updates.
   */
  runtimeState: FanControlStatusSchema,
  customize: fanControlCustomize,

  /**
   * Runtime-state durability: **session** — as `brightness`.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): recorded series. Actuator tier: speed keeps every change.
   */
  history: {
    fields: {
      speed: { kind: 'gauge', unit: '%', minIntervalMs: 0 },
      oscillating: { kind: 'boolean' },
    },
  },
  vocabulary: {
    noun: t('Fan', 'Ventilatore'),
    order: 1080,
    state: [
      {
        kind: 'numeric',
        field: 'speed',
        quantity: t('the speed', 'la velocità'),
        label: t('Speed', 'Velocità'),
        unit: '%',
        icon: 'fan',
      },
      {
        kind: 'boolean',
        field: 'oscillating',
        label: t('Oscillating', 'Oscillazione'),
        whenTrue: t('When {device} starts oscillating', 'Quando {device} inizia a oscillare'),
        whenFalse: t('When {device} stops oscillating', 'Quando {device} smette di oscillare'),
        icon: 'move-horizontal',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IFanControlProvider = InferProvider<typeof fanControlCapability>
