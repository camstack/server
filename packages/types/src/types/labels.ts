import { z } from 'zod'

export const LabelDefinitionSchema = z.object({
  id: z.string(),
  name: z.string(),
  category: z.string().optional(),
  description: z.string().optional(),
  icon: z.string().optional(),
})

export type LabelDefinition = z.infer<typeof LabelDefinitionSchema>

/**
 * General raw-label → macro-label map. Deliberately loose (`mapping` values
 * are plain `string`) — it covers both video detection macros
 * (`person`/`vehicle`/`animal`/`package`, see `COCO_TO_MACRO`) and audio
 * classification macros (`speech`/`scream`/`crying`/…, see `YAMNET_TO_MACRO`),
 * which are disjoint vocabularies. Do NOT constrain this to
 * {@link CLASS_MAP_MACRO_TARGETS} — that set is scoped to the narrower,
 * wire-validated {@link DetectionCatalogClassMapSchema} below.
 */
export interface ClassMapDefinition {
  readonly mapping: Readonly<Record<string, string>>
  readonly preserveOriginal: boolean
}

/** Detection-macro targets a catalog `classMap` may resolve to. */
export const CLASS_MAP_MACRO_TARGETS = ['person', 'vehicle', 'animal', 'package'] as const

/**
 * The FIRST-LEVEL macro classes: those an object detector emits and that
 * an operator can select.
 *
 * They are the three offered by the `object-detection` step
 * (`addon-pipeline/src/detection-pipeline/registry/step-definitions.ts`,
 * `enabledMacroClasses`). `package` is in {@link CLASS_MAP_MACRO_TARGETS} and in
 * `MACRO_LABELS` — it is a true macro — but NOT here: it belongs to the step
 * `package-detection`, whose enablement is driven by zones, and offering the
 * same word twice has already made an operator turn on the COCO proxy
 * (suitcase/backpack/handbag) lasciando spento il detector dedicato.
 *
 * ONE list. Before today the same three were hand-written in the step's offer
 * and a second time as the union `FirstLevelMacro`
 * (`types/detection.ts`); a third copy for the recording trigger
 * (`RecordingTriggers.objectClasses`) would have made the later divergence
 * invisible.
 */
export const FIRST_LEVEL_MACRO_CLASSES = ['person', 'vehicle', 'animal'] as const
export type FirstLevelMacroClass = (typeof FIRST_LEVEL_MACRO_CLASSES)[number]

/**
 * True when `value` is a first-level macro. Type guard, not cast: a
 * `className` coming from the bus is any string until it passes through
 * qui.
 */
export function isFirstLevelMacroClass(value: string): value is FirstLevelMacroClass {
  return FIRST_LEVEL_MACRO_CLASSES.some((macro) => macro === value)
}

/**
 * Wire schema for a per-model CATALOG classMap override
 * (`ModelCatalogEntry.classMap` / `ModelConvertMetadata.classMap`) —
 * restricted to {@link CLASS_MAP_MACRO_TARGETS}, the only macros the
 * detection pipeline executor actually routes.
 *
 * This is deliberately a DIFFERENT, narrower shape than the general-purpose
 * `ClassMapDefinition` interface above (e.g. `IDetectionAddon.getClassMap()`
 * and the audio `YAMNET_TO_MACRO` catalog both use macro targets outside this
 * enum) — the two used to share the name `ClassMapDefinition`/
 * `ClassMapDefinitionSchema`, which made the schema-type-twin guard
 * (`scripts/check-schema-type-twins.ts`) flag them as a duplicated shape. They
 * are not: it is two different concepts colliding on a name. Keep this type
 * under its own name rather than reusing `ClassMapDefinition` — reusing it
 * would either narrow every `ClassMapDefinition` consumer to the four
 * detection macros (breaking `YAMNET_TO_MACRO`) or drop the validation this
 * schema exists for (see the "rejects a classMap whose target is not a
 * detection macro" test in `model-catalog-schema.test.ts`).
 */
export const DetectionCatalogClassMapSchema = z.object({
  mapping: z.record(z.string(), z.enum(CLASS_MAP_MACRO_TARGETS)),
  preserveOriginal: z.boolean(),
})
export type DetectionCatalogClassMap = z.infer<typeof DetectionCatalogClassMapSchema>
