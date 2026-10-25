import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import {
  NcConditionDescriptorSchema,
  NcConditionsSchema,
  NcScheduleSchema,
} from './notification-rules.cap.js'
import { OsdOverlayKindEnum } from './osd.cap.js'

/**
 * `osd-manager` — the ORCHESTRATOR over the device-scope `osd` cap.
 *
 * The `osd` cap is the firmware contract: it probes a camera's overlay
 * SLOTS and writes literal text into one. It has no idea WHERE that text
 * comes from, and it must not — a driver that grew a "show the temperature
 * here" feature would grow it once per vendor.
 *
 * This cap owns the other half: a per-(camera, slot) BINDING that says
 * which value feeds the slot, how it is formatted, and under which
 * conditions it is shown at all. Named TEMPLATES combine many device
 * fields into one overlay string (plugin catalog OSD Manager parity).
 */

/**
 * How a parser token expands one binding. Not stored on the binding —
 * the parser picks the mode per insert (`{alias.value}` / `.unit` / `.full`).
 */
export const OsdTemplateTokenKindSchema = z.enum(['value', 'unit', 'full'])
export type OsdTemplateTokenKind = z.infer<typeof OsdTemplateTokenKindSchema>

/** @deprecated Use `OsdTemplateTokenKind` — kept for generated import churn. */
export const OsdTemplateFormatSchema = z.enum(['value+unit', 'value', 'unit'])
/** @deprecated Use `OsdTemplateTokenKind`. */
export type OsdTemplateFormat = z.infer<typeof OsdTemplateFormatSchema>

/**
 * How the operator reached the leaf device. `deviceId` is ALWAYS the
 * OSD-supported leaf that is read; `containerId` is set when the pick
 * went through a container (gateway) first.
 */
export const OsdTemplatePickSchema = z.object({
  containerId: z.number().int().optional(),
  deviceId: z.number().int(),
})

export type OsdTemplatePick = z.infer<typeof OsdTemplatePickSchema>

/**
 * One named binding inside a multi-device template: device path + unit
 * selection + precision. The parser expands `{alias}`, `{alias.value}`,
 * `{alias.unit}`, or `{alias.full}` from the same binding — there is no
 * per-binding format lock.
 */
export const OsdTemplateBindingSchema = z.object({
  /** Token stem in the parser, e.g. `t` → `{t}` / `{t.value}`. Unique within the template. */
  alias: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[A-Za-z][A-Za-z0-9_-]*$/, 'alias must start with a letter'),
  pick: OsdTemplatePickSchema,
  capName: z.string().min(1).max(64),
  valuePath: z.string().min(1).max(64),
  /** Convert TO this unit at render (`tryConvertUnit`). Absent = source unit. */
  displayUnit: z.string().max(16).optional(),
  maxDecimals: z.number().int().min(0).max(4).default(1),
  /** Raw value → display text (same shape as slot binding). Empty string hides. */
  valueMap: z.record(z.string(), z.string()).optional(),
})

export type OsdTemplateBinding = z.infer<typeof OsdTemplateBindingSchema>

/**
 * A named template: bindings (alias → leaf field) + a parser that
 * references `{alias}` / `{alias.value}` / `{alias.unit}` / `{alias.full}`.
 */
export const OsdNamedTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  bindings: z.array(OsdTemplateBindingSchema).max(32).default([]),
  /** Parser with alias placeholders, e.g. `{t.value} {t.unit} / {h}`. */
  parser: z.string().max(256).default(''),
})

export type OsdNamedTemplate = z.infer<typeof OsdNamedTemplateSchema>

/** Where a slot's value comes from. */
export const OsdSourceSchema = z.discriminatedUnion('kind', [
  /**
   * Drive the slot with blank text (clears the overlay on write). Replaces the
   * old "Clear binding" UI — the binding stays so the manager keeps owning the
   * slot and can re-render empty when conditions open.
   */
  z.object({
    kind: z.literal('none'),
  }),
  /** A literal string. The `template` still applies (`${value}` = the text). */
  z.object({
    kind: z.literal('static'),
    text: z.string().max(64),
  }),
  /**
   * Wall clock, rendered by US rather than by the firmware's own
   * timestamp overlay — so it can be combined with other text in one
   * slot, and so it obeys the same gate as every other binding.
   */
  z.object({
    kind: z.literal('clock'),
    /** Token pattern: `YYYY MM DD HH mm ss`. Everything else is literal. */
    pattern: z.string().min(1).max(32).default('HH:mm'),
    /** IANA zone. Omitted = the server's zone. */
    timezone: z.string().min(1).max(64).optional(),
  }),
  /**
   * A leaf of some device's cap-keyed runtime state — the generic case.
   * `deviceId` omitted means "this camera", which keeps a binding
   * copyable between cameras without rewriting it.
   */
  z.object({
    kind: z.literal('device-state'),
    deviceId: z.number().int().optional(),
    capName: z.string().min(1).max(64),
    /** Dot path inside the slice, e.g. `detected`, `value`, `mode`. */
    valuePath: z.string().min(1).max(64),
    /** Convert TO this unit at render. Absent = no conversion. */
    displayUnit: z.string().max(16).optional(),
  }),
  /**
   * The most recent recognition persisted by Pipeline Analytics for this
   * camera. Unlike device-state, this survives addon/camera restarts and is
   * refreshed immediately by track-lifecycle events.
   */
  z.object({
    kind: z.literal('latest-recognition'),
    recognition: z.enum(['person', 'plate']),
  }),
  /**
   * Evaluate a named template's parser against live states of every
   * referenced device (plugin catalog OverlayType.Template).
   */
  z.object({
    kind: z.literal('template'),
    templateId: z.string().min(1).max(64),
  }),
])

export type OsdSource = z.infer<typeof OsdSourceSchema>

export const OsdSlotBindingSchema = z.object({
  /** Off = the manager stops driving this slot. It does NOT clear it. */
  enabled: z.boolean().default(true),
  source: OsdSourceSchema,
  /** `${value}` and `${unit}` are substituted; every occurrence. */
  template: z.string().max(96).default('${value}'),
  /**
   * Decimal places for a numeric value. `0` yields an integer — the
   * documented workaround for firmwares that reject `.` in overlay text.
   */
  maxDecimals: z.number().int().min(0).max(4).default(1),
  /** Raw value → display text, e.g. `{"true":"MOTION","false":""}`. */
  valueMap: z.record(z.string(), z.string()).optional(),
  /** Time windows in which the slot is shown. Absent = always. */
  schedule: NcScheduleSchema.optional(),
  /**
   * Display gate, in the notification centre's condition vocabulary.
   * Only the keys reported by `getConditionSupport` are accepted.
   */
  conditions: NcConditionsSchema.optional(),
})

export type OsdSlotBinding = z.infer<typeof OsdSlotBindingSchema>

/** One camera slot, as the operator sees it: firmware truth + our binding. */
export const OsdSlotViewSchema = z.object({
  slotId: z.string(),
  kind: OsdOverlayKindEnum,
  /** Firmware refuses text edits (a timestamp, the channel name). */
  readOnly: z.boolean(),
  cameraEnabled: z.boolean(),
  cameraText: z.string().optional(),
  binding: OsdSlotBindingSchema.nullable(),
})

export type OsdSlotView = z.infer<typeof OsdSlotViewSchema>

/**
 * What happened to one slot on one render pass. `unchanged` exists so the
 * operator can tell "we are driving this and the value is steady" from
 * "we never got there" — and so the loop can prove it is not rewriting
 * identical text to the camera every tick.
 */
export const OsdRenderOutcomeEnum = z.enum([
  'written',
  'unchanged',
  'gated',
  'unreadable',
  'disabled',
  'unbound',
  'failed',
])
export type OsdRenderOutcome = z.infer<typeof OsdRenderOutcomeEnum>

export const OsdRenderResultSchema = z.object({
  slotId: z.string(),
  outcome: OsdRenderOutcomeEnum,
  /** The text the slot should carry. Empty = the slot is switched off. */
  text: z.string(),
  /** Why, whenever the outcome is not a plain write. Never silent. */
  reason: z.string().optional(),
})

export type OsdRenderResult = z.infer<typeof OsdRenderResultSchema>

export const OsdSourceValueTypeEnum = z.enum(['number', 'boolean', 'string', 'enum'])
export type OsdSourceValueType = z.infer<typeof OsdSourceValueTypeEnum>

/**
 * One bindable value, derived from a cap's `runtimeState` schema — never
 * hand-listed. The editor renders from this, so a cap that ships a new
 * state field becomes bindable with no UI change.
 */
export const OsdSourceOptionSchema = z.object({
  deviceId: z.number().int(),
  deviceName: z.string(),
  capName: z.string(),
  valuePath: z.string(),
  label: z.string(),
  valueType: OsdSourceValueTypeEnum,
  /** Present for `enum`; the editor offers these as `valueMap` keys. */
  enumValues: z.array(z.string()).readonly().optional(),
})

export type OsdSourceOption = z.infer<typeof OsdSourceOptionSchema>

export const osdManagerCapability = {
  name: 'osd-manager',
  scope: 'system',
  mode: 'singleton',
  methods: {
    /**
     * The camera's slots, each with its binding. `supported: false` when
     * the camera publishes no `osd` cap — the page then says so instead
     * of rendering an empty list that reads as "no overlays configured".
     */
    getDeviceOsd: method(
      z.object({ deviceId: z.number().int() }),
      z.object({
        supported: z.boolean(),
        slots: z.array(OsdSlotViewSchema),
      }),
      { auth: 'admin' },
    ),
    /**
     * Every value bindable on this camera: its own state leaves first,
     * then every other device's. Derived from the cap definitions, so it
     * cannot drift from what the resolver can actually read.
     */
    getSourceCatalog: method(
      z.object({ deviceId: z.number().int() }),
      z.object({ sources: z.array(OsdSourceOptionSchema) }),
      { auth: 'admin' },
    ),
    /**
     * The condition ids this gate can answer, alongside the FULL notification
     * condition catalog. Both, in one call, on purpose: an editor that showed
     * the catalog without the supported set would offer conditions that
     * `setSlotBinding` then rejects.
     */
    getConditionSupport: method(
      z.object({}),
      z.object({
        supported: z.array(z.string()),
        catalog: z.array(NcConditionDescriptorSchema),
      }),
      { auth: 'admin' },
    ),
    /**
     * Persist a binding and render it immediately, returning the slot as
     * it now stands. Throws when the binding names an unsupported
     * condition, an unknown cap, or a value path that cap does not have.
     */
    setSlotBinding: method(
      z.object({
        deviceId: z.number().int(),
        slotId: z.string().min(1),
        binding: OsdSlotBindingSchema,
      }),
      z.object({ slot: OsdSlotViewSchema, render: OsdRenderResultSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Forget the binding. The slot keeps whatever text it last carried. */
    clearSlotBinding: method(
      z.object({ deviceId: z.number().int(), slotId: z.string().min(1) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Toggle the camera firmware overlay on/off (`osd.setOverlay` `enabled`).
     * Distinct from the binding's own `enabled` flag — this is what the
     * operator sees on the live picture (e.g. Reolink camera name layer).
     */
    setSlotCameraEnabled: method(
      z.object({
        deviceId: z.number().int(),
        slotId: z.string().min(1),
        enabled: z.boolean(),
      }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Replace one camera's binding configuration from another. Writable source
     * slots are mapped by ordinal onto writable target slots so different
     * provider slot ids do not make the copied configuration disappear.
     */
    copyDeviceConfiguration: method(
      z.object({
        sourceDeviceId: z.number().int(),
        targetDeviceId: z.number().int(),
      }),
      z.object({
        copied: z.number().int().nonnegative(),
        skipped: z.number().int().nonnegative(),
      }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /**
     * Render without writing. `binding` overrides the stored one so an
     * editor can preview an unsaved change. Mutation kind only to carry
     * the binding object safely; no side effects.
     */
    previewSlot: method(
      z.object({
        deviceId: z.number().int(),
        slotId: z.string().min(1),
        binding: OsdSlotBindingSchema.optional(),
      }),
      OsdRenderResultSchema,
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Force a render pass over one camera now, instead of at the next tick. */
    renderDevice: method(
      z.object({ deviceId: z.number().int() }),
      z.object({ results: z.array(OsdRenderResultSchema) }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Every named multi-device template. */
    listTemplates: method(z.object({}), z.object({ templates: z.array(OsdNamedTemplateSchema) }), {
      auth: 'admin',
    }),
    /**
     * Create or replace a named template by `id`. Returns the stored record
     * after Zod normalisation.
     */
    upsertTemplate: method(
      z.object({ template: OsdNamedTemplateSchema }),
      z.object({ template: OsdNamedTemplateSchema }),
      { kind: 'mutation', auth: 'admin' },
    ),
    /** Drop a named template. Bindings that still reference it render unreadable. */
    deleteTemplate: method(
      z.object({ templateId: z.string().min(1).max(64) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
} as const satisfies CapabilityDefinition

export type IOsdManagerProvider = InferProvider<typeof osdManagerCapability>
