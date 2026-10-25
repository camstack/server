import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Unified user-settable input cap. Models HA's `number` /
 * `input_number` / `select` / `input_select` / `text` / `input_text`
 * / `input_datetime` domains as a single device-scoped cap on
 * `DeviceType.Control`.
 *
 * The slice is a discriminated union over four `kind` values that
 * mirror the corresponding `DeviceRole` sub-roles
 * (NumericControl / SelectControl / TextControl / DateTimeControl)
 * — the device's `role` and the slice's `kind` are populated in
 * lockstep at materialisation time. The UI reads `device.role`
 * (or equivalently the slice's `kind`) to render the correct input
 * widget (slider / dropdown / text field / date picker).
 *
 * The `select` branch carries its `options` list IN THE SLICE
 * (not in `sourceInfo`) because HA `select.*` entities can update
 * their options dynamically at runtime — the slice is the live
 * source of truth. Numeric `unit`/`min`/`max`/`step` also live IN
 * THE SLICE — populated live from the upstream source on each state
 * push (HA `attributes.unit_of_measurement` / `min` / `max` /
 * `step`). The slice is the single source of truth; there is no
 * separate `sourceInfo` or device-config blob for these values.
 */

export const ControlKindSchema = z.enum(['numeric', 'select', 'text', 'datetime'])
export type ControlKind = z.infer<typeof ControlKindSchema>

/**
 * Status slice — flat object (the framework's `runtimeState` contract
 * requires a `ZodObject`, not a discriminated union). The `kind`
 * field discriminates the value type at the type level via the
 * `ControlNumericValue` / `ControlStringValue` aliases; consumers
 * narrow with a kind check.
 *
 * The `value` field is typed as `number | string`:
 *   - `kind === 'numeric'` → `value` is `number`
 *   - `kind === 'select' | 'text' | 'datetime'` → `value` is `string`
 *
 * The `options` array is populated only when `kind === 'select'`
 * (empty array for the other kinds). It lives in the slice because
 * HA `select.*` entities may update their options at runtime.
 *
 * The `unit`/`min`/`max`/`step` fields are meaningful for
 * `kind === 'numeric'` and are absent (undefined) for all other
 * kinds. They are populated live from HA attributes on each state
 * push — consistent with `options` and the sensor-unit approach.
 */
export const ControlStatusSchema = z.object({
  kind: ControlKindSchema,
  /** Current value. Numeric kind → number; select/text/datetime → string.
   *  Datetime values are ISO 8601 strings (full timestamp, date-only,
   *  or time-only — HA accepts all three forms). */
  value: z.union([z.number(), z.string()]),
  /** Acceptable values when `kind === 'select'`. Empty for other kinds. */
  options: z.array(z.string()),
  /** Ms epoch when the slice was last updated. */
  lastChangedAt: z.number(),
  /** Display unit-of-measurement (e.g. '°C', '%', 'lx').
   *  Populated live from HA `attributes.unit_of_measurement` on each push.
   *  Meaningful for `kind === 'numeric'`; absent for other kinds. */
  unit: z.string().optional(),
  /** Minimum allowed value. Populated live from HA `attributes.min`.
   *  Meaningful for `kind === 'numeric'`; absent for other kinds. */
  min: z.number().optional(),
  /** Maximum allowed value. Populated live from HA `attributes.max`.
   *  Meaningful for `kind === 'numeric'`; absent for other kinds. */
  max: z.number().optional(),
  /** Step increment. Populated live from HA `attributes.step`.
   *  Meaningful for `kind === 'numeric'`; absent for other kinds. */
  step: z.number().optional(),
  /** Suggested decimal places for numeric display. Populated live from HA
   *  `attributes.suggested_display_precision`, or derived from `step` when the
   *  HA attribute is absent. Meaningful for `kind === 'numeric'`; absent for
   *  other kinds. Falls back to auto-formatting when absent. */
  precision: z.number().int().min(0).max(10).optional(),
  /** Date-picker granularity for `kind === 'datetime'`. 'date' → date-only,
   *  'time' → time-only, 'datetime' → full timestamp. Absent for other kinds
   *  (UI defaults to 'datetime'). Derived live from the device's HA domain
   *  (date.* / time.* / datetime.*) or, for input_datetime, from the entity's
   *  `has_date`/`has_time` attributes on each push. */
  format: z.enum(['date', 'time', 'datetime']).optional(),
})

export type ControlStatus = z.infer<typeof ControlStatusSchema>

const ControlSetValueInputSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('numeric'), value: z.number() }),
  z.object({ kind: z.literal('select'), value: z.string().min(1) }),
  z.object({ kind: z.literal('text'), value: z.string() }),
  z.object({ kind: z.literal('datetime'), value: z.string().min(1) }),
])

export type ControlSetValueInput = z.infer<typeof ControlSetValueInputSchema>

export const controlCapability = {
  name: 'control',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  deviceTypes: [DeviceType.Control],
  methods: {
    setValue: method(
      z.object({
        deviceId: z.number().int().nonnegative(),
        control: ControlSetValueInputSchema,
      }),
      z.void(),
      { kind: 'mutation', auth: 'protected' },
    ),
  },
  status: {
    schema: ControlStatusSchema,
    kind: 'push',
  },
  /**
   * Runtime-state slice — mirrored by the kernel. UI widgets (slider /
   * dropdown / text field / date picker) read the slice's discriminant
   * and value directly without polling the provider.
   */
  runtimeState: ControlStatusSchema,

  /**
   * Runtime-state durability: **session** — a generic control mirrors an external entity that re-publishes on connect; the options array is re-derived with it.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'session',
  /**
   * History (D850): none — `value` is a number/string union; configuration entity.
   */
  history: 'none',
} as const satisfies CapabilityDefinition

export type IControlProvider = InferProvider<typeof controlCapability>
