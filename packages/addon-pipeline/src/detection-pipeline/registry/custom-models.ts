import {
  type CustomModelDescriptor,
  inferModelProvider,
  type ModelCatalogEntry,
} from '@camstack/types'

/**
 * Group a flat list of custom-model descriptors (as returned by the
 * `custom-model-registry` collection cap) into a `stepId → entries` map for
 * the picker / resolution union. Pure; order within a step preserved.
 */
export function groupCustomModelsByStep(
  descriptors: readonly CustomModelDescriptor[],
): Map<string, ModelCatalogEntry[]> {
  const byStep = new Map<string, ModelCatalogEntry[]>()
  for (const d of descriptors) {
    const arr = byStep.get(d.stepId) ?? []
    arr.push(d.entry)
    byStep.set(d.stepId, arr)
  }
  return byStep
}

/**
 * Union a step's static catalog models with operator-registered custom
 * models. On an `id` collision the static catalog entry wins — a custom
 * model can never shadow a built-in one.
 *
 * Pure + side-effect-free so it can be unit-tested in isolation and called
 * from the (free) `buildSchemaSlots` builder without any addon context.
 */
export function mergeCustomModels(
  staticModels: readonly ModelCatalogEntry[],
  customModels: readonly ModelCatalogEntry[],
): ModelCatalogEntry[] {
  const seen = new Set(staticModels.map((m) => m.id))
  const merged: ModelCatalogEntry[] = [...staticModels]
  for (const m of customModels) {
    if (seen.has(m.id)) continue // static wins
    seen.add(m.id)
    merged.push({ ...m, provider: inferModelProvider(m) })
  }
  return merged
}
