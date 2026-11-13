import { z } from 'zod'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'
import {
  NcConditionDescriptorSchema,
  NcConditionsSchema,
  NcScheduleSchema,
} from './notification-rules.cap.js'
import { OsdOverlayKindEnum } from './osd.cap.js'
import { NOT_A_DEVICE } from '../device/cap-vocabulary/system-reasons.js'

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
 * The text of a named template: a device template (D1021) —
 * `{{ camera.temperature | round(1) }}`, `{{ now | time('HH:mm') }}`,
 * `{% if camera.motion %}MOTION{% endif %}` — rendered by the ONE hub renderer
 * (`device-manager.renderDeviceTemplates`), never by this addon.
 *
 * Two names belong to the render rather than to a device:
 * - `now` is the clock; `time('HH:mm')` prints it in the server's zone.
 * - `camera` is the camera the overlay is on, so one template serves every
 *   camera. `camera.lastPerson` and `camera.lastPlate` are the most recent
 *   recognition persisted for it (empty text until there is one, with
 *   `| default('')`).
 */
export const OSD_TEMPLATE_TEXT_MAX = 1024

/**
 * A named template: the unit of reuse. A slot points at one by id; editing it
 * changes every slot that points at it, on every camera.
 */
export const OsdNamedTemplateSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.string().min(1).max(64),
  text: z.string().max(OSD_TEMPLATE_TEXT_MAX).default(''),
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
  /** A literal string, written as it is. */
  z.object({
    kind: z.literal('static'),
    text: z.string().max(64),
  }),
  /** A named template, rendered by the hub for this camera. */
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

/**
 * A template rendered for one camera without being saved: what the editor
 * previews. `text` is what the overlay would carry; a refused render has a
 * `reason` and an empty text.
 */
export const OsdTemplatePreviewSchema = z.object({
  ok: z.boolean(),
  text: z.string(),
  /** The refusal, or `ref: reason` per value that printed `—`. */
  notes: z.array(z.string()),
})

export type OsdTemplatePreview = z.infer<typeof OsdTemplatePreviewSchema>

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
    /**
     * Render a template text for a camera without saving it, with the same
     * context a slot gets (`camera`, `now`, the recognitions). The editor's
     * preview; no side effects.
     */
    previewTemplate: method(
      z.object({
        deviceId: z.number().int(),
        text: z.string().max(OSD_TEMPLATE_TEXT_MAX),
      }),
      OsdTemplatePreviewSchema,
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
    /** Drop a named template. Slots that still point at it render unreadable and keep their last text. */
    deleteTemplate: method(
      z.object({ templateId: z.string().min(1).max(64) }),
      z.object({ success: z.literal(true) }),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  vocabulary: { notOperatorFacing: NOT_A_DEVICE.PIPELINE },
} as const satisfies CapabilityDefinition

export type IOsdManagerProvider = InferProvider<typeof osdManagerCapability>
