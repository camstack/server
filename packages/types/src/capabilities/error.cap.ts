import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { t } from '../device/cap-vocabulary/l10n.js'

/** How loudly a fault wants the operator. Both tiers raise the attention event. */
export const DeviceErrorSeveritySchema = z.enum(['warning', 'error'])
export type DeviceErrorSeverity = z.infer<typeof DeviceErrorSeveritySchema>

/** One fault of a device that can raise several at once. */
export const DeviceFaultSchema = z.object({
  /** The device's own code, as the vendor names it. */
  code: z.string(),
  /** Already translated by the provider (it owns the vendor vocabulary). */
  label: z.string(),
  severity: DeviceErrorSeveritySchema,
})
export type DeviceFault = z.infer<typeof DeviceFaultSchema>

/** One kind of fault a device CAN raise: the integration's own declared catalog entry. */
export const DeviceFaultTypeSchema = DeviceFaultSchema
export type DeviceFaultType = z.infer<typeof DeviceFaultTypeSchema>

/**
 * The fault catalog of a device, declared by its integration at runtime (never a
 * code enum). A fault outside the catalog is still published and still matches
 * a rule that names no code.
 */
export const ListFaultTypesInputSchema = z.object({ deviceId: z.number().int().nonnegative() })
export const FaultTypesSchema = z.object({ types: z.array(DeviceFaultTypeSchema) })
export type FaultTypes = z.infer<typeof FaultTypesSchema>

/**
 * The fault a device reports right now. One slice per device.
 *
 * `active` is tri-state: `null` is "the provider has not read it yet" and is
 * never drawn as "no fault" nor as a fault (D315, D393). The provider filters
 * what is not a fault (a completion or reminder code) BEFORE it writes `true`.
 *
 * The cap's name is the key a template reads (`{{ alias.error.label }}`, D1021).
 */
export const ErrorStatusSchema = z.object({
  active: z.boolean().nullable(),
  /** The code of the principal fault; `null` when none (or unknown). */
  code: z.string().nullable(),
  /** The principal fault's words, provider-translated; `null` when none. */
  label: z.string().nullable(),
  severity: DeviceErrorSeveritySchema,
  /** Ms epoch the current fault started; `null` when none or not known. */
  since: z.number().nullable(),
  /** Every fault, for a device that raises several. The principal is the first. */
  faults: z.array(DeviceFaultSchema).optional(),
  /** Ms epoch of the last read the provider made of the fault. */
  lastFetchedAt: z.number(),
})
export type ErrorStatus = z.infer<typeof ErrorStatusSchema>

/** The slice before the provider has read anything: unknown, not "fine". */
export const ERROR_STATUS_COLD: ErrorStatus = {
  active: null,
  code: null,
  label: null,
  severity: 'error',
  since: null,
  lastFetchedAt: 0,
}

export const errorCapability = {
  name: 'error',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  methods: {
    /** The fault codes this device's integration can raise; `[]` when it declares none. */
    listFaultTypes: method(ListFaultTypesInputSchema, FaultTypesSchema, {
      kind: 'query',
      auth: 'protected',
    }),
  },
  status: {
    schema: ErrorStatusSchema,
    kind: 'push',
    empty: ERROR_STATUS_COLD,
  },
  runtimeState: ErrorStatusSchema,
  /**
   * Runtime-state durability: **restored** — the previous observation is what
   * lets the first reading after a restart be a COMPARISON: a fault that was
   * already open must not announce itself a second time.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  volatileStateFields: ['lastFetchedAt'],
  /** The fault itself is carried by the attention alerts; no series is recorded. */
  history: 'none',
  vocabulary: {
    noun: t('Fault', 'Guasto'),
    order: 5265,
    state: [
      {
        kind: 'boolean',
        field: 'active',
        label: t('Fault', 'Guasto'),
        whenTrue: t('When {device} reports a fault', 'Quando {device} segnala un guasto'),
        whenFalse: t(
          'When the fault of {device} clears',
          'Quando il guasto di {device} si risolve',
        ),
        icon: 'triangle-alert',
      },
    ],
  },
} as const satisfies CapabilityDefinition

export type IErrorProvider = InferProvider<typeof errorCapability>
