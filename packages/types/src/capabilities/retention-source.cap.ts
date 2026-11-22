import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

/**
 * `retention-source` — the one place the operator reads every retention knob
 * of the system (D1084). A collection cap: each addon that keeps data for a
 * bounded time registers a provider and lists its OWN knobs; the hub's collection
 * fan-out concatenates the answers, so there is no central list to forget to edit
 * and the admin UI (Data → Retention, the device page) hardcodes none.
 *
 * A knob never stores anything here. It is a read of a setting the owner already
 * has, plus the way to write it back: `write` names the existing settings call
 * (`addonSettings.updateScopedSettings` for a cluster knob, `updateDeviceSettings`
 * for a device override). The owner stays the only authority for the value.
 *
 * `scope: 'cluster'` — one value for the system. `scope: 'device'` — a cluster
 * default that a device may override: without `deviceId` the knob is listed with
 * the cluster default; with `deviceId` only the device-scoped knobs of that device
 * are listed, each saying whether it is `inherited` or overridden.
 */

export const RetentionScopeSchema = z.enum(['cluster', 'device'])
export type RetentionScope = z.infer<typeof RetentionScopeSchema>

export const RetentionUnitSchema = z.enum(['days', 'hours', 'count'])
export type RetentionUnit = z.infer<typeof RetentionUnitSchema>

/** How to write a knob back: the settings call that already owns it. */
export const RetentionWriteSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('updateScopedSettings'),
    addonId: z.string().min(1),
    cap: z.string().min(1),
    scope: z.enum(['cluster', 'node']),
    key: z.string().min(1),
  }),
  z.object({
    method: z.literal('updateDeviceSettings'),
    addonId: z.string().min(1),
    key: z.string().min(1),
  }),
])
export type RetentionWrite = z.infer<typeof RetentionWriteSchema>

export const RetentionKnobSchema = z.object({
  /** Stable id: `<addonId>:<key>`. */
  id: z.string().min(1),
  /** The addon that owns, reads and enforces the knob. */
  owner: z.string().min(1),
  /** Settings key inside the owner. */
  key: z.string().min(1),
  /** i18n key of the label (`retention.<owner>.<key>`). */
  labelKey: z.string().min(1),
  /** English fallback when the key has no translation. */
  label: z.string().min(1),
  /** Groups knobs of one subject on the page (`history`, `events`, `logs`, …). */
  group: z.string().min(1),
  unit: RetentionUnitSchema,
  /** What the owner uses when nothing is set. */
  defaultValue: z.number().nullable(),
  /** The effective value now (a device listing: the device's own, else the inherited one). `null`: unknown. */
  value: z.number().nullable(),
  min: z.number().optional(),
  max: z.number().optional(),
  /** `0` means keep forever for this knob. */
  zeroMeansForever: z.boolean(),
  scope: RetentionScopeSchema,
  /** Device listing only: the device the answer is about. */
  deviceId: z.number().int().optional(),
  /** Device-scoped knob: `true` while the device follows the cluster value. */
  inherited: z.boolean().optional(),
  /** Device-scoped knob: the cluster value the device would inherit. */
  inheritedValue: z.number().nullable().optional(),
  write: RetentionWriteSchema,
})
export type RetentionKnob = z.infer<typeof RetentionKnobSchema>

export const retentionSourceCapability = {
  name: 'retention-source',
  scope: 'system',
  mode: 'collection',
  internal: true,
  methods: {
    /** List the retention knobs this addon owns; with `deviceId`, the device-scoped ones for that device. */
    listRetentionKnobs: method(
      z.object({ deviceId: z.number().int().positive().optional() }),
      z.array(RetentionKnobSchema).readonly(),
      { auth: 'admin' },
    ),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.INTERNAL },
} as const satisfies CapabilityDefinition

export type IRetentionSourceProvider = InferProvider<typeof retentionSourceCapability>
