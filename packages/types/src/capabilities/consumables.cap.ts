import { z } from 'zod'
import { method, type CapabilityDefinition, type InferProvider } from './capability-definition.js'
import type { CapabilityCustomizeSpec } from './customize-spec.js'
import { DeviceType } from '../device/device-type.js'

/**
 * Generic device-consumables capability — the ONE place a device reports what
 * it uses up or fills: wear parts (vacuum filters/brushes, cartridges,
 * descaling cycles), supplies it draws from (a vacuum's clean-water tank and
 * detergent, a dishwasher's salt and rinse aid) and waste it collects (a dirty
 * water tank, a dust bin). Each item carries its remaining life or fill and an
 * optional "Replaced" reset action. Device-agnostic: any provider that knows
 * its device tracks consumables registers it; the provider names each item
 * verbatim and says which `kind` it is.
 *
 * The admin UI renders it as ONE collapsible section directly under the
 * device page's hero card (`placement: 'hero'`), for every device bound to
 * this cap — never drawn by a device type's hero card itself (D915).
 *
 * Like `childLayout`, the cap is INERT until a provider sets items: no
 * provider populates it by guessing (no HA inference). The UI renders a
 * "No consumables reported" placeholder when `items` is empty.
 */

/**
 * What an item IS, which decides which direction is bad:
 *  - `wear`   — a part that wears out (a brush, a filter); low life is bad.
 *  - `supply` — something the device draws from (clean water, detergent,
 *    salt, rinse aid); low or empty is bad.
 *  - `waste`  — something the device fills (dirty water, a dust bin); full is
 *    bad.
 * Absent = `wear`.
 */
export const ConsumableKindSchema = z.enum(['wear', 'supply', 'waste'])
export type ConsumableKind = z.infer<typeof ConsumableKindSchema>

/**
 * What an item LOOKS like, which decides how a client draws it — independent
 * of `kind`, which decides which direction is bad:
 *  - `part`    — a part that wears (a brush, a filter, a mop pad): a wear bar,
 *    remaining time and a reset.
 *  - `tank`    — a container of liquid (clean water, dirty water): a fill gauge.
 *  - `product` — something bought and refilled (detergent, salt, rinse aid):
 *    a stepped level and "refill".
 *  - `bin`     — a container that collects waste (a dust bin): a fill gauge
 *    that warns when full.
 * Absent = derived from the kind ({@link consumableFormOf}).
 */
export const ConsumableFormSchema = z.enum(['part', 'tank', 'product', 'bin'])
export type ConsumableForm = z.infer<typeof ConsumableFormSchema>

/** The provider's own discrete verdict on an item. */
export const ConsumableStatusSchema = z.enum(['ok', 'low', 'empty', 'full', 'replace'])
export type ConsumableStatus = z.infer<typeof ConsumableStatusSchema>

/**
 * The level vocabulary every client draws a consumable in (badge tone, bar
 * colour): derived from an item by its kind, level and status. `null` beside
 * it means unknown (D393).
 */
export const ConsumableLevelSchema = z.enum(['ok', 'low', 'empty', 'full'])
export type ConsumableLevel = z.infer<typeof ConsumableLevelSchema>

/** The kind of an item, with the documented default for an absent one. */
export function consumableKindOf(item: { readonly kind?: ConsumableKind }): ConsumableKind {
  return item.kind ?? 'wear'
}

/** The kind's default form: wear → part, waste → bin, supply → product. */
const FORM_OF_KIND: Readonly<Record<ConsumableKind, ConsumableForm>> = {
  wear: 'part',
  waste: 'bin',
  supply: 'product',
}

/** The form of an item: its own when the provider names one, else its kind's default. */
export function consumableFormOf(item: {
  readonly kind?: ConsumableKind
  readonly form?: ConsumableForm
}): ConsumableForm {
  return item.form ?? FORM_OF_KIND[consumableKindOf(item)]
}

/** Units a remaining-life counter is reported in. Closed: the panel renders
 *  each. */
export const ConsumableRemainingUnitSchema = z.enum(['days', 'hours', 'cycles'])
export type ConsumableRemainingUnit = z.infer<typeof ConsumableRemainingUnitSchema>

/** Remaining life as a COUNT, not a percentage (the PetKit desiccant reports
 *  days). `value` null = unknown (D393). */
export const ConsumableRemainingSchema = z.object({
  value: z.number().min(0).nullable(),
  unit: ConsumableRemainingUnitSchema,
})
export type ConsumableRemaining = z.infer<typeof ConsumableRemainingSchema>

/** A single consumable item. Either a continuous `level` (remaining
 *  life %, or fill % for a `supply` / `waste` item) or a discrete `status`
 *  may be known — both may be null when a provider only knows the item
 *  exists. `level` and `status` are not mutually exclusive; a provider may
 *  report both. */
export const ConsumableItemSchema = z.object({
  /** Stable id, e.g. 'main-brush'. */
  key: z.string().min(1),
  /** Display name. */
  label: z.string().min(1),
  /** Remaining life % (`wear`) or fill % (`supply`, `waste`) when known (0..100). */
  level: z.number().min(0).max(100).nullable(),
  /** The provider's discrete verdict when known (binary mode). */
  status: ConsumableStatusSchema.nullable(),
  /** What the item is — decides whether low or full is bad. Absent = `wear`. */
  kind: ConsumableKindSchema.optional(),
  /** How the item is drawn (part, tank, product, bin). Absent = derived from `kind`. */
  form: ConsumableFormSchema.optional(),
  /** Ms epoch of the last replace, when known. */
  lastResetAt: z.number().nullable(),
  /** Whether `reset()` is meaningful for this item. */
  resettable: z.boolean(),
  /** Remaining life as a count (days/hours/cycles), when a provider reports
   *  it that way instead of — or alongside — `level`. Absent = not reported. */
  remaining: ConsumableRemainingSchema.optional(),
})

export const ConsumablesStatusSchema = z.object({
  items: z.array(ConsumableItemSchema),
  lastChangedAt: z.number(),
})

export type ConsumableItem = z.infer<typeof ConsumableItemSchema>
export type ConsumablesStatus = z.infer<typeof ConsumablesStatusSchema>

/** Synthesize seed for a link-built status (no native provider).
 *
 *  ⚠ NO LIVE CALLER since 2026-08-08 (device-links deleted; see
 *  `CapabilityStatusSchema.empty`). The wiring guidance below was written for
 *  exactly the case the operator is asking about again — a Dreame's HA
 *  consumable-life sensors — so it is kept for that conversation, not because
 *  anything reads it today. */
const EMPTY_STATUS: ConsumablesStatus = { items: [], lastChangedAt: 0 }

/** Seed for a NEW link-built consumable item. `key`/`label` are overwritten
 *  with the link's `itemKey` (see `status.itemArray`), so the placeholder
 *  empty strings never survive into a validated item. Link-built items are
 *  not resettable — there is no native provider to receive `reset()`.
 *
 *  Wiring guidance (HA vacuum consumable-life sensors):
 *  - a percent-remaining source (`numeric-sensor`, unit '%') → `level` via
 *    `identity` (or `linear` scale 1 offset 0 clamp [0,100] to be safe);
 *  - an hours-remaining source (e.g. Dreame 'Main Brush Time Left', unit 'h')
 *    → `level` via `linear` with scale = 100 / max-hours for that item
 *    (e.g. main brush 300 h → scale 0.3333) + clamp [0,100];
 *  - a discrete source (`enum-sensor`, e.g. mop pad 'installed') → `status`
 *    via `enum-map` (e.g. { installed: 'ok', missing: 'replace' }).
 *  A numeric→'replace' THRESHOLD (level < 10 → 'replace') is NOT expressible
 *  with the current transform kinds — leave `status` null (valid) until the
 *  expression transform lands. */
/** Generic Customize target for one consumable item (D936). Native rows stay read-only. */
const consumablesCustomize = {
  version: 1,
  targets: [
    {
      id: 'items',
      cardinality: 'keyedArray',
      vocabulary: { cap: 'consumables' },
      deviceTypes: Object.values(DeviceType),
      apply: 'add',
      path: 'items',
      keyField: 'key',
      labelField: 'label',
      itemSchema: ConsumableItemSchema,
      nativeItems: 'read-only',
      sourceReport: { status: 'assignment-status' },
      fields: [
        {
          path: 'level',
          sources: [
            {
              kind: 'numeric',
              transforms: [
                { kind: 'identity' },
                {
                  kind: 'linear',
                  defaultScale: 1,
                  defaultOffset: 0,
                  clampMin: 0,
                  clampMax: 100,
                },
              ],
            },
          ],
        },
        {
          path: 'remaining.value',
          sources: [{ kind: 'numeric', transforms: [{ kind: 'identity' }] }],
          literals: [
            { path: 'remaining.unit', values: [...ConsumableRemainingUnitSchema.options] },
          ],
        },
        {
          path: 'status',
          sources: [
            {
              kind: 'enum',
              transforms: [
                {
                  kind: 'enum-map',
                  outputValues: [...ConsumableStatusSchema.options],
                  unmapped: null,
                },
              ],
            },
          ],
        },
      ],
      traits: [
        { path: 'kind', values: [...ConsumableKindSchema.options], defaultValue: 'wear' },
        { path: 'form', values: [...ConsumableFormSchema.options], defaultValue: 'part' },
      ],
      companions: [
        { kind: 'clock', path: 'lastChangedAt', when: 'add' },
        { kind: 'clock', path: 'lastFetchedAt', when: 'add' },
      ],
      advancedExpression: true,
    },
  ],
} satisfies CapabilityCustomizeSpec

const EMPTY_ITEM: ConsumableItem = {
  key: '',
  label: '',
  level: null,
  status: null,
  lastResetAt: null,
  resettable: false,
}

export const consumablesCapability = {
  name: 'consumables',
  scope: 'device',
  deviceNative: true,
  mode: 'singleton',
  // Device-agnostic — any device may expose consumables, so the cap
  // binds on EVERY DeviceType. Derived from the enum (not a hand-listed
  // subset) so a provider on any device type — vacuums/mowers included — can
  // register it and no future device type silently fails to bind or drifts
  // out of sync with `device-type.ts`.
  deviceTypes: Object.values(DeviceType),
  deviceConfig: {
    // ONE section directly under the device's hero card, for every device
    // bound to this cap — not a tab of its own, and no hero card draws a
    // consumable itself (D915).
    ui: {
      kind: 'widget',
      widgetId: 'host/consumables-panel',
      tab: 'consumables',
      placement: 'hero',
      label: 'Consumables',
      order: 5,
    },
  },
  methods: {
    /** Mark a consumable as replaced — resets its remaining life. Only
     *  meaningful when the item's `resettable` is true. */
    reset: method(
      z.object({ deviceId: z.number().int().nonnegative(), key: z.string().min(1) }),
      z.void(),
      { kind: 'mutation', auth: 'admin' },
    ),
  },
  /**
   * A composed consumable (item added to a device with no native consumables
   * provider) refuses `reset` by name: "Only meaningful when the item's
   * `resettable` is true" — a composed item is never resettable until
   * commands (`forward`) arrive in slice 3 (D663).
   */
  composedMethods: {
    reset: {
      kind: 'refuse',
      reason: 'a composed consumable is not resettable until commands (forward) arrive — slice 3',
    },
  },
  status: {
    schema: ConsumablesStatusSchema,
    kind: 'push',
    // Device-link synthesize seed: a device with consumables LINKS but no
    // native provider builds its status from this base.
    empty: EMPTY_STATUS,
    // Item-array wiring target: links sharing a `target.itemKey` build ONE
    // consumable item (level/status/label per key), upserted into `items`.
    itemArray: {
      path: 'items',
      keyField: 'key',
      labelField: 'label',
      itemSchema: ConsumableItemSchema,
      emptyItem: EMPTY_ITEM,
    },
  },
  // Per the cap checklist, runtimeState carries the bridge helper's
  // freshness field. The status surface stays the plain schema; only the
  // persistent slice gains `lastFetchedAt` so future poll-backed
  // providers can use the runtime-state bridge unchanged.
  runtimeState: ConsumablesStatusSchema.extend({ lastFetchedAt: z.number() }),

  /**
   * Runtime-state durability: **restored** — nothing else holds the value
   * (D642). A consumable can often be read only in a device's wake window (the
   * Dreame mower's CMS counters answer only while it charges), so a restart
   * that wiped the slice left the panel empty and the alerts blind until the
   * next wake — 2026-09-26, mower 503 idle with `items: []`. A restored item is
   * the previous observation, not a claim about now; the provider overwrites it
   * the moment it reads the device again.
   *
   * See `RuntimeStateDurability`. Enforced by
   * `scripts/check-runtime-state-durability.ts`.
   */
  durability: 'restored',
  /**
   * History (D850, D917): one series per (item field, item `key`) — the item key
   * is the series scope, the item `label` names it. A vacuum tank's fill, a
   * brush's remaining life and a dishwasher's salt are each recorded the moment
   * their provider reports them; an item that appears later gets its series.
   */
  customize: consumablesCustomize,
  history: {
    fields: {},
    items: {
      path: 'items',
      key: 'key',
      label: 'label',
      fields: {
        level: { kind: 'gauge', unit: '%', deadband: 2, displayName: 'Level' },
        status: { kind: 'enum', displayName: 'Status' },
        'remaining.value': {
          kind: 'gauge',
          unitFrom: 'remaining.unit',
          deadband: 1,
          displayName: 'Remaining',
        },
      },
    },
  },
  /** Clocks, not content: a re-read that changed no item costs no commit. */
  volatileStateFields: ['lastChangedAt', 'lastFetchedAt'],
} as const satisfies CapabilityDefinition

export type IConsumablesProvider = InferProvider<typeof consumablesCapability>
