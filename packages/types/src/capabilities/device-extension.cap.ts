/**
 * `device-extension` — ONE place to see and author what a device is extended
 * with by OTHER devices (D648).
 *
 * **A contract, not a store.** Every slot (today one: `linked-devices`) is
 * declared by the cap that owns the function (`extensionSlots` in its
 * `*.cap.ts`, D4) and SERVED by the addon that already owns its store, over
 * that store and its existing write path. This cap persists nothing and has no config method (guarded by
 * `scripts/check-extension-slots.ts`): D62 applied to the whole feature, and
 * D3 — no shadow registry.
 *
 * **Shape.** A device-scoped wrapper COLLECTION, the D554 shape `videoclips`
 * uses: `resolveCapMount` gives it the `device-scoped` mount and
 * `requireDeviceCollection` dispatches it. Its providers are the slot owners
 * (today device-manager alone), and a device's sources are its
 * bindings (step 0 of `getBindings`, derived, persisted nowhere).
 *
 *  - `listSources` — one row per provider, the D554 source-listing convention
 *    that lets a scalar call be routed by the prefix of its `slotRef`.
 *  - `listSlots` — fan-out, concatenated. A provider that throws becomes ONE
 *    `unreachable` row naming it, never an absence (D554.4, D315): "no
 *    extensions" is claimed only from an answer.
 *  - `listCandidates` / `setSlot` — scalar, routed by `slotRef`
 *    (`<source>:<slotId>`). An unclaimed ref is refused by name (D554.5).
 *
 * The slot's value travels as the generated discriminated union
 * (`ExtensionSlotValue`, keyed on `slot`), so a value under the wrong slot is
 * a schema error before it reaches any owner.
 *
 * **Associations only.** A slot LISTS other devices on its host. A host that
 * GAINS a capability from other devices is a composition (D663, amends D648:
 * the reserved `graft` shape, its `projects` and its `enabled` switch were
 * retired unimplemented).
 */
import { z } from 'zod'
import {
  EXTENSION_HOST_DEVICE_TYPES,
  ExtensionSlotIdSchema,
  ExtensionSlotValueSchema,
} from '../generated/extension-slots.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

/** Separator between the source and the slot id in a `slotRef`. It is the
 *  D554 routing separator: the dispatcher matches `<source>:` prefixes. */
export const EXTENSION_SLOT_REF_SEPARATOR = ':'

/** The contract method whose failure BECOMES a row, like `listSources`'s. */
export const EXTENSION_SLOT_LISTING_METHOD = 'listSlots'

export const ExtensionSourceAvailabilitySchema = z.discriminatedUnion('state', [
  z.object({ state: z.literal('ok') }),
  z.object({ state: z.literal('unreachable'), reason: z.string() }),
])
export type ExtensionSourceAvailability = z.infer<typeof ExtensionSourceAvailabilitySchema>

/** One provider of slots — the D554 source-listing row. */
export const ExtensionSourceSchema = z.object({
  /** The routing prefix of every `slotRef` this provider serves. */
  source: z.string(),
  label: z.string(),
  /** Stamped by the dispatcher from the registry (D557). */
  addonId: z.string().optional(),
  availability: ExtensionSourceAvailabilitySchema,
})
export type ExtensionSource = z.infer<typeof ExtensionSourceSchema>

/**
 * How one picked source stands. `missing` — no such device (deleted, or an id
 * that never existed); `foreign` — a device the slot's owner cannot read from
 * (a source owned by another addon); `unavailable` — it exists but is not a
 * valid source now (a container, which is never a pick). A source in any of
 * these states is SHOWN, never silently dropped or re-pointed.
 */
export const ExtensionSourceHealthSchema = z.enum(['ok', 'missing', 'foreign', 'unavailable'])
export type ExtensionSourceHealth = z.infer<typeof ExtensionSourceHealthSchema>

export const ExtensionSlotSourceSchema = z.object({
  deviceId: z.number().int(),
  /** The device's name, or null when it could not be resolved (`missing`). */
  name: z.string().nullable(),
  health: ExtensionSourceHealthSchema,
  detail: z.string().optional(),
})
export type ExtensionSlotSource = z.infer<typeof ExtensionSlotSourceSchema>

/**
 * A DIFFERENT authority that gates whether the slot's sources do anything —
 * reported read-only, named, never written through this contract (D62) — e.g.
 * a slot whose sources act only while a wrapper is bound to the host, a
 * binding that belongs to `deviceManager.setWrapperActive`. No slot reports
 * one today (`linked-devices` answers `null`). `unknown` means the gate could
 * not be read; it is not "inactive" (D315).
 */
export const ExtensionSlotActivationSchema = z.object({
  state: z.enum(['active', 'inactive', 'unknown']),
  authority: z.string(),
  detail: z.string().optional(),
})
export type ExtensionSlotActivation = z.infer<typeof ExtensionSlotActivationSchema>

/** One slot of one device, as its owner reads it from its own store. */
export const ExtensionSlotStateSchema = z.object({
  state: z.literal('ok'),
  /** `<source>:<slotId>` — the routing key for `listCandidates` / `setSlot`. */
  slotRef: z.string(),
  slot: ExtensionSlotIdSchema,
  /** Names the store written (D62), e.g. `device-manager:_linkedDeviceIds`. */
  authority: z.string(),
  activation: ExtensionSlotActivationSchema.nullable(),
  value: ExtensionSlotValueSchema,
  sources: z.array(ExtensionSlotSourceSchema),
  /**
   * Devices the owner links to the host ON ITS OWN, by structure, and that
   * are therefore not in `value` (D655): a camera's device-tree children, and
   * the child a picked container stands for (D356 — a container is never a
   * pick, its children are). Read-only; the editor shows them and may offer
   * per-device options on them (the linked-devices tracked-event opt-in).
   * Absent when the owner links nothing beyond the picks, and from an owner
   * older than D655.
   */
  impliedSources: z.array(ExtensionSlotSourceSchema).optional(),
})
export type ExtensionSlotState = z.infer<typeof ExtensionSlotStateSchema>

/**
 * A provider that could not answer `listSlots` at all. It could not name its
 * own slots, so the row names the ADDON and carries the refusal verbatim.
 * Written by the dispatcher, never by a provider.
 */
export const ExtensionSlotUnreachableSchema = z.object({
  state: z.literal('unreachable'),
  addonId: z.string(),
  reason: z.string(),
})
export type ExtensionSlotUnreachable = z.infer<typeof ExtensionSlotUnreachableSchema>

export const ExtensionSlotRowSchema = z.discriminatedUnion('state', [
  ExtensionSlotStateSchema,
  ExtensionSlotUnreachableSchema,
])
export type ExtensionSlotRow = z.infer<typeof ExtensionSlotRowSchema>

/** The row the dispatcher writes for a provider whose `listSlots` threw. */
export function unreachableExtensionSlotRow(
  addonId: string,
  reason: string,
): ExtensionSlotUnreachable {
  return { state: 'unreachable', addonId, reason }
}

/** One device the slot's editor may offer as a source. */
export const ExtensionCandidateSchema = z.object({
  deviceId: z.number().int(),
  name: z.string(),
  type: z.string(),
  location: z.string().nullable(),
  /** The container a child belongs to — "Spotlight 2" alone does not say which. */
  parentName: z.string().nullable(),
  /** Pre-marked by the owner's suggestion rule. NEVER saved on its own (D356). */
  suggested: z.boolean(),
  /** Why it is suggested ("same location"), null when it is not. */
  reason: z.string().nullable(),
})
export type ExtensionCandidate = z.infer<typeof ExtensionCandidateSchema>

export const ExtensionCandidatesSchema = z.object({
  candidates: z.array(ExtensionCandidateSchema),
})
export type ExtensionCandidates = z.infer<typeof ExtensionCandidatesSchema>

/**
 * What a write did. `none` — applied in place. `host` / `parent` — the owner
 * reloaded the host (or, for an accessory child, its parent) because the
 * write changed what the host REGISTERS. A slot never adds a capability to its
 * host — that is a composition (D663) — so today's owners answer `none`.
 */
export const ExtensionSetResultSchema = z.object({
  applied: z.literal(true),
  reload: z.enum(['none', 'host', 'parent']),
})
export type ExtensionSetResult = z.infer<typeof ExtensionSetResultSchema>

export const ExtensionSlotRefInputSchema = z.object({
  deviceId: z.number().int(),
  slotRef: z.string().min(1),
})
export type ExtensionSlotRefInput = z.infer<typeof ExtensionSlotRefInputSchema>

export const ExtensionSetSlotInputSchema = ExtensionSlotRefInputSchema.extend({
  value: ExtensionSlotValueSchema,
})
export type ExtensionSetSlotInput = z.infer<typeof ExtensionSetSlotInputSchema>

export const deviceExtensionCapability = {
  name: 'device-extension',
  scope: 'device',
  // Several owners per device, listed beside each other (the D554 shape).
  // `resolveCapMount` checks the device-wrapper rule first, so this is the
  // `device-scoped` mount dispatched by `requireDeviceCollection`.
  mode: 'collection',
  kind: 'wrapper',
  defaultActive: true,
  // Derived by codegen from the slots' own host types: the section appears
  // exactly where at least one slot is offered, and nowhere it would only
  // ever say "no extensions".
  deviceTypes: EXTENSION_HOST_DEVICE_TYPES,
  // An owned widget section (D14/D526) in the General tab, right after the
  // two hand-written sections it will replace (70, 71).
  deviceConfig: {
    ui: {
      kind: 'widget',
      widgetId: 'host/extensions-panel',
      tab: 'general',
      label: 'Extensions',
      order: 72,
    },
  },
  methods: {
    /** One row per slot owner — the D554 source listing `slotRef` routes by. */
    listSources: method(z.object({ deviceId: z.number().int() }), z.array(ExtensionSourceSchema)),
    /**
     * Every slot this device is offered, read by each owner from its own
     * store. A provider that throws is ONE `unreachable` row (D554.4).
     */
    listSlots: method(z.object({ deviceId: z.number().int() }), z.array(ExtensionSlotRowSchema)),
    /** The devices the slot's editor may offer, suggestions pre-marked (D356). */
    listCandidates: method(ExtensionSlotRefInputSchema, ExtensionCandidatesSchema),
    /**
     * Write one slot through its owner's EXISTING write path. The owner
     * validates (a container is never a linked device, a camera is never its
     * own source) and refuses by name before persisting.
     */
    setSlot: method(ExtensionSetSlotInputSchema, ExtensionSetResultSchema, {
      kind: 'mutation',
      auth: 'admin',
    }),
  },
} as const satisfies CapabilityDefinition

export type IDeviceExtensionProvider = InferProvider<typeof deviceExtensionCapability>
