/**
 * A COMPOSITION: a device assembled from other devices' state (D659).
 *
 * The data half of the composed-devices spec §1. A composition is stored inside
 * a core block (`CoreBlock.source.kind === 'composition'`) and run by the shared
 * `composer` runner. It names a TARGET and, for each capability of the target, a
 * FIELD MAP: every state field has exactly one source.
 *
 * Sources are keyed by `(addonId, stableId)`, NEVER by numeric device id. A
 * resync reissues numeric ids, and a composition that stored them would be
 * orphaned by the first re-adoption (the linked-devices lesson). A `stableId` is
 * unique only within its owning addon, so the owner travels with it.
 *
 * Later slices EXTEND these unions and do not reshape them. The variants a later
 * slice implements are already in the wire shape, and `validateComposition`
 * refuses them BY NAME until then:
 *   feature `passthrough` → slice 3 · `commands` (`forward`) → slice 3 ·
 *   source `code` → slice 4. Target `existing` (customize a device) is slice 2 (D663).
 */
import { z } from 'zod'
import { DeviceRole, DeviceType } from '../device/device-type.js'
import { validateExpressionSource } from '../expression/expression-source.js'
import { EXPRESSION_IDENTIFIER_RE, MAX_EXPRESSION_SOURCE_LENGTH } from '../expression/limits.js'

/** The owner of every composed device: the `composer` builtin. */
export const COMPOSER_ADDON_ID = 'composer'
/**
 * The stored name of a block that customizes an EXISTING device starts with this
 * (`customizationBlockName`, `@camstack/types/node`). Never parsed to tell a
 * customization apart: `composition.target.kind === 'existing'` says that (D663).
 */
export const CUSTOMIZATION_BLOCK_NAME_PREFIX = 'customize:'
/** A composed device's stableId is this prefix plus the block id. */
export const COMPOSED_DEVICE_STABLE_ID_PREFIX = 'composed-'
/** A device with more capabilities than this is two devices. */
export const MAX_COMPOSITION_FEATURES = 16
export const MAX_COMPOSITION_FIELDS_PER_FEATURE = 32
/** Longest snippet a `code` source may carry (slice 4). */
export const MAX_COMPOSITION_CODE_LENGTH = 20_000

export const CompositionSourceRefSchema = z.object({
  /** The owning addon; `stableId` is unique only within it. */
  addonId: z.string().min(1),
  stableId: z.string().min(1),
})
export type CompositionSourceRef = z.infer<typeof CompositionSourceRefSchema>

/** One field of one capability of one source device. */
export const CompositionFieldReadSchema = z.object({
  source: CompositionSourceRefSchema,
  cap: z.string().min(1),
  /** Dotted path into the source cap's runtime-state slice. */
  fieldPath: z.string().min(1),
})
export type CompositionFieldRead = z.infer<typeof CompositionFieldReadSchema>

/** `from`: copy one source field verbatim. It is also an expression's `from` binding. */
export const CompositionFromSourceSchema = CompositionFieldReadSchema.extend({
  kind: z.literal('from'),
})
export type CompositionFromSource = z.infer<typeof CompositionFromSourceSchema>

/** A constant binding. No device is read. */
export const CompositionLiteralBindingSchema = z.object({
  kind: z.literal('literal'),
  value: z.union([z.string(), z.number(), z.boolean(), z.null()]),
})
export type CompositionLiteralBinding = z.infer<typeof CompositionLiteralBindingSchema>

export const CompositionBindingSchema = z.discriminatedUnion('kind', [
  CompositionFromSourceSchema,
  CompositionLiteralBindingSchema,
])
export type CompositionBinding = z.infer<typeof CompositionBindingSchema>

/**
 * `expression`: a formula over named bindings, in the salvaged expression
 * engine. Validated at parse by the SAME function every other consumer runs,
 * so the editor and the store cannot disagree.
 */
export const CompositionExpressionSourceSchema = z
  .object({
    kind: z.literal('expression'),
    expr: z.string().min(1).max(MAX_EXPRESSION_SOURCE_LENGTH),
    bindings: z.record(z.string().regex(EXPRESSION_IDENTIFIER_RE), CompositionBindingSchema),
  })
  .superRefine((src, ctx) => {
    const err = validateExpressionSource(src)
    if (err !== null) ctx.addIssue({ code: 'custom', message: err, path: ['expr'] })
  })
export type CompositionExpressionSource = z.infer<typeof CompositionExpressionSourceSchema>

/** `code`: RESERVED for slice 4 (own runner, one-way eject). */
export const CompositionCodeSourceSchema = z.object({
  kind: z.literal('code'),
  code: z.string().min(1).max(MAX_COMPOSITION_CODE_LENGTH),
})
export type CompositionCodeSource = z.infer<typeof CompositionCodeSourceSchema>

export const CompositionFieldSourceSchema = z.discriminatedUnion('kind', [
  CompositionFromSourceSchema,
  CompositionExpressionSourceSchema,
  CompositionCodeSourceSchema,
])
export type CompositionFieldSource = z.infer<typeof CompositionFieldSourceSchema>

/** `forward`: RESERVED for slice 3. Argument mapping arrives there as an additive optional `args`. */
export const CompositionForwardCommandSchema = z.object({
  kind: z.literal('forward'),
  source: CompositionSourceRefSchema,
  cap: z.string().min(1),
  method: z.string().min(1),
})
export type CompositionForwardCommand = z.infer<typeof CompositionForwardCommandSchema>

export const CompositionCommandTargetSchema = z.discriminatedUnion('kind', [
  CompositionForwardCommandSchema,
  CompositionCodeSourceSchema,
])
export type CompositionCommandTarget = z.infer<typeof CompositionCommandTargetSchema>

/** An item key inside an item-array cap (`consumables.items[<key>]`). */
export const COMPOSITION_ITEM_KEY_RE = /^[a-z0-9][a-z0-9-]{0,47}$/
export const MAX_COMPOSITION_ITEMS = 16
/** The item-array path of every item-array cap that exists (`consumables.items`). */
export const COMPOSITION_ITEM_ARRAY_PATH = 'items'

/**
 * One item of an item-array cap (D663), addressed through the cap's
 * `status.itemArray` descriptor. `fields` are paths INSIDE the item, nested
 * allowed (`remaining.value`); the key and label come from the entry itself.
 */
export const CompositionItemEntrySchema = z.object({
  label: z.string().min(1).max(80),
  fields: z.record(z.string().min(1), CompositionFieldSourceSchema),
})
export type CompositionItemEntry = z.infer<typeof CompositionItemEntrySchema>

export const CompositionFieldsFeatureSchema = z.object({
  kind: z.literal('fields'),
  cap: z.string().min(1),
  enabled: z.boolean().optional(),
  fields: z
    .record(z.string().min(1), CompositionFieldSourceSchema)
    .refine((fields) => Object.keys(fields).length <= MAX_COMPOSITION_FIELDS_PER_FEATURE, {
      message: `at most ${MAX_COMPOSITION_FIELDS_PER_FEATURE} fields per capability`,
    }),
  /**
   * Items of the cap's item array, keyed by item key (D663). Naming `items`
   * owns the WHOLE array field: the composed value holds exactly these items.
   */
  items: z
    .record(z.string().regex(COMPOSITION_ITEM_KEY_RE), CompositionItemEntrySchema)
    .refine((items) => Object.keys(items).length <= MAX_COMPOSITION_ITEMS, {
      message: `at most ${MAX_COMPOSITION_ITEMS} items`,
    })
    .optional(),
  /** RESERVED for slice 3; refused by the validator when non-empty. */
  commands: z.record(z.string().min(1), CompositionCommandTargetSchema).optional(),
})
export type CompositionFieldsFeature = z.infer<typeof CompositionFieldsFeatureSchema>

/** RESERVED for slice 3: a media / data-plane cap, whole, from one source. */
export const CompositionPassthroughFeatureSchema = z.object({
  kind: z.literal('passthrough'),
  cap: z.string().min(1),
  enabled: z.boolean().optional(),
  source: CompositionSourceRefSchema,
})
export type CompositionPassthroughFeature = z.infer<typeof CompositionPassthroughFeatureSchema>

export const CompositionFeatureSchema = z.discriminatedUnion('kind', [
  CompositionFieldsFeatureSchema,
  CompositionPassthroughFeatureSchema,
])
export type CompositionFeature = z.infer<typeof CompositionFeatureSchema>

/** Only an explicit `false` disables a feature; omitted preserves the existing wire default. */
export function compositionFeatureEnabled(feature: CompositionFeature): boolean {
  return feature.enabled !== false
}

/**
 * A NEW device. It has no `name` of its own: the block's name IS the device's
 * name (2026-08-08). A second copy here would be a second writer of one string (D62).
 */
export const CompositionNewTargetSchema = z.object({
  kind: z.literal('new'),
  type: z.enum(DeviceType),
  role: z.enum(DeviceRole).optional(),
})
export type CompositionNewTarget = z.infer<typeof CompositionNewTargetSchema>

/** Customize an EXISTING device: each feature adds a capability or replaces fields of a native one (D663). */
export const CompositionExistingTargetSchema = z.object({
  kind: z.literal('existing'),
  device: CompositionSourceRefSchema,
})
export type CompositionExistingTarget = z.infer<typeof CompositionExistingTargetSchema>

export const CompositionTargetSchema = z.discriminatedUnion('kind', [
  CompositionNewTargetSchema,
  CompositionExistingTargetSchema,
])
export type CompositionTarget = z.infer<typeof CompositionTargetSchema>

export const CompositionSchema = z
  .object({
    target: CompositionTargetSchema,
    features: z.array(CompositionFeatureSchema).min(1).max(MAX_COMPOSITION_FEATURES),
  })
  .superRefine((composition, ctx) => {
    const seen = new Set<string>()
    composition.features.forEach((feature, index) => {
      if (seen.has(feature.cap)) {
        ctx.addIssue({
          code: 'custom',
          message: `capability \`${feature.cap}\` is composed twice — one feature per capability`,
          path: ['features', index, 'cap'],
        })
      }
      seen.add(feature.cap)
    })
  })
export type Composition = z.infer<typeof CompositionSchema>

export function compositionSourceKey(ref: CompositionSourceRef): string {
  return `${ref.addonId}/${ref.stableId}`
}

export function compositionSliceKey(ref: CompositionSourceRef, cap: string): string {
  return `${compositionSourceKey(ref)}#${cap}`
}

export function compositionReadKey(read: CompositionFieldRead): string {
  return `${compositionSliceKey(read.source, read.cap)}.${read.fieldPath}`
}

export function composedDeviceStableId(blockId: string): string {
  return `${COMPOSED_DEVICE_STABLE_ID_PREFIX}${blockId}`
}

export function composedDeviceRef(blockId: string): CompositionSourceRef {
  return { addonId: COMPOSER_ADDON_ID, stableId: composedDeviceStableId(blockId) }
}

/** Every device field a source reads: `from` is one read, an expression is its `from` bindings. */
export function fieldReads(source: CompositionFieldSource): readonly CompositionFieldRead[] {
  switch (source.kind) {
    case 'from':
      return [{ source: source.source, cap: source.cap, fieldPath: source.fieldPath }]
    case 'expression':
      return Object.values(source.bindings).flatMap((binding) =>
        binding.kind === 'from'
          ? [{ source: binding.source, cap: binding.cap, fieldPath: binding.fieldPath }]
          : [],
      )
    case 'code':
      return []
  }
}

/** The ONE spelling of an item leaf as a field path: `items[desiccant].remaining.value`. */
export function compositionItemFieldPath(arrayPath: string, key: string, path: string): string {
  return `${arrayPath}[${key}].${path}`
}

export interface CompositionFeatureFieldEntry {
  readonly fieldPath: string
  readonly source: CompositionFieldSource
}

/**
 * Every written field of a feature, item leaves under their bracketed path.
 * `arrayPath` is `'items'` for every item-array cap that exists
 * (`consumables.cap.ts`); the graph has no cap lookup, so the default stands
 * and `planItems` asserts it agrees with the cap's descriptor.
 */
export function featureFieldEntries(
  feature: CompositionFieldsFeature,
  arrayPath = COMPOSITION_ITEM_ARRAY_PATH,
): readonly CompositionFeatureFieldEntry[] {
  return [
    ...Object.entries(feature.fields).map(([fieldPath, source]) => ({ fieldPath, source })),
    ...Object.entries(feature.items ?? {}).flatMap(([key, item]) =>
      Object.entries(item.fields).map(([path, source]) => ({
        fieldPath: compositionItemFieldPath(arrayPath, key, path),
        source,
      })),
    ),
  ]
}

export function featureSources(
  feature: CompositionFieldsFeature,
): readonly CompositionFieldSource[] {
  return featureFieldEntries(feature).map((e) => e.source)
}
