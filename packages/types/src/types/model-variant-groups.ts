/**
 * Variant grouping for the model selector.
 *
 * The catalog is a FLAT list of `ModelCatalogEntry` (ids like `yolo26s`,
 * `yolo26s-int8`) — that stays the source of truth for resolution, download and
 * persistence. This module is a PRESENTATION overlay: it folds the flat list
 * into a `family → tier → variant` tree so the UI can offer one grouped picker
 * ("YOLO26" → "Small" → "Int8") instead of a flat dropdown of every
 * size×quantization combination, and maps a grouped selection back to a flat
 * model id.
 *
 * Only entries carrying `group` and NOT flagged `legacy` participate; legacy /
 * ungrouped / custom models are never surfaced in the grouped selector (they
 * stay reachable via the flat id when explicitly pinned).
 */
import type { ModelFormat } from './models.js'

export type VariantPrecision = 'fp32' | 'int8'
export type VariantOptimization = 'standard' | 'test'

/**
 * Minimal structural shape the grouped selector needs. Both the full
 * `ModelCatalogEntry` (config UI) and the reduced `PipelineModelOption`
 * (pipeline/device steppers) satisfy it, so one grouped picker serves every
 * surface. `formats` is read only for "which formats ship" + a size hint, so a
 * loose `{ sizeMB }`-per-key map covers both the catalog's rich format entries
 * and the schema's `{ downloaded, sizeMB }` entries.
 */
export interface ModelVariantSource {
  readonly id: string
  readonly name: string
  readonly legacy?: boolean
  readonly group?: {
    readonly family: string
    readonly tier: string
    readonly precision?: VariantPrecision
    readonly optimization?: VariantOptimization
    readonly resolution?: number
  }
  readonly formats: Readonly<Record<string, { readonly sizeMB: number } | undefined>>
}

/** One selectable variant of a tier (a single flat catalog entry). */
export interface ModelVariantOption {
  readonly modelId: string
  readonly precision: VariantPrecision
  readonly optimization: VariantOptimization
  /**
   * Input resolution (square side, px). Every catalog entry states its own; a
   * legacy source that omits it is treated as the family's native (largest)
   * build. Reduced values (320 / 256) are the reduced-input latency variants.
   */
  readonly resolution?: number
  /** Short chip label: `Standard` | `Int8` | `Fast` | `Fast · Int8`. */
  readonly label: string
  /** Formats this variant ships (drives per-node availability). */
  readonly formats: readonly ModelFormat[]
  /** Smallest declared build size (MB) — a rough size hint for the chip. */
  readonly sizeMB: number
}

/** One size tier within a family (e.g. YOLO26 "Small"), with its variants. */
export interface ModelVariantTier {
  readonly tier: string
  readonly label: string
  /** The fp32/standard base model id — the tier's canonical selection. */
  readonly baseModelId: string
  readonly options: readonly ModelVariantOption[]
}

/** One model family (e.g. YOLO26), with its size tiers. */
export interface ModelVariantFamily {
  readonly family: string
  readonly label: string
  /** One short line on what picking this family means, when it is not obvious. */
  readonly hint?: string
  readonly tiers: readonly ModelVariantTier[]
}

const FORMAT_KEYS: readonly ModelFormat[] = ['onnx', 'coreml', 'openvino', 'tflite', 'pt']

/**
 * Display spelling of a family. Uppercasing the id is wrong for any family
 * whose name is not all-caps — it rendered `yolov9` as "YOLOV9", a word the
 * product uses nowhere else (the catalog, the docs and the model files all say
 * "YOLOv9").
 */
const FAMILY_LABEL: Readonly<Record<string, string>> = {
  yolo26: 'YOLO26',
  'yolo26-seg': 'YOLO26-seg',
  yolov9: 'YOLOv9',
}

function familyLabel(family: string): string {
  return FAMILY_LABEL[family] ?? family.toUpperCase()
}

/**
 * The picker's one-line hint for a family whose choice changes more than
 * accuracy and speed. A YOLO26-seg root detects like YOLO26 and also supplies
 * the Segmentation step its masks (D737).
 */
const FAMILY_HINT: Readonly<Record<string, string>> = {
  'yolo26-seg': 'detection + masks, slightly heavier',
}

/** `@640`, `@320×320`, `@ 256` — a resolution stated inside a model name. */
const RESOLUTION_IN_NAME = /\s*@\s*\d+\s*(?:[x×]\s*\d+)?/gi

/**
 * Strip a leading family label AND any stated resolution from a base model name
 * → clean tier label.
 *
 * The resolution strip is not cosmetic. The tier is chosen BEFORE the
 * resolution chip, and a family whose builds all state their input (our yolov9
 * ships only 320 and 640, no resolution-less build) made the tier inherit its
 * base entry's name verbatim: the ladder read "Tiny @640 / Small @640 / …" and
 * kept saying 640 while the operator had 320 selected below it.
 */
function tierLabel(family: string, baseName: string): string {
  const fl = familyLabel(family)
  // Base names read like "YOLO26 Small" / "YOLOv9 Tiny @640"; drop the family
  // word, then the resolution the separate axis already owns.
  const stripped = baseName
    .replace(new RegExp(`^${fl}\\s+`, 'i'), '')
    .replace(RESOLUTION_IN_NAME, '')
    .trim()
  return stripped.length > 0 ? stripped : baseName
}

function variantLabel(precision: VariantPrecision, optimization: VariantOptimization): string {
  const parts: string[] = []
  if (optimization === 'test') parts.push('Test')
  parts.push(precision === 'int8' ? 'Int8' : 'Standard')
  // "Standard" alone, else e.g. "Test · Int8".
  return parts.join(' · ')
}

function entryFormats(entry: ModelVariantSource): readonly ModelFormat[] {
  return FORMAT_KEYS.filter((f) => entry.formats[f] !== undefined)
}

function smallestSizeMB(entry: ModelVariantSource): number {
  const sizes = FORMAT_KEYS.map((f) => entry.formats[f]?.sizeMB).filter(
    (n): n is number => typeof n === 'number',
  )
  return sizes.length > 0 ? Math.min(...sizes) : 0
}

// The size ladder across families: yolov9 runs t < s < m < c (Compact is its
// LARGEST build, ~97 MB, not its smallest), yolo26 runs n < s < m < l < x.
// Tiers outside this list are appended alphabetically.
const TIER_ORDER = ['t', 'n', 's', 'm', 'c', 'l', 'x']
const PRECISION_ORDER: VariantPrecision[] = ['fp32', 'int8']

/**
 * Fold a flat catalog into the `family → tier → variant` tree. Deterministic
 * ordering: tiers by the canonical size ladder (unknown tiers appended
 * alphabetically), variants standard-before-int8 and test last.
 */
export function buildModelVariantGroups(
  models: readonly ModelVariantSource[],
): readonly ModelVariantFamily[] {
  // family → tier → entries
  const byFamily = new Map<string, Map<string, ModelVariantSource[]>>()
  for (const m of models) {
    if (m.legacy === true || m.group === undefined) continue
    const { family, tier } = m.group
    const tiers = byFamily.get(family) ?? new Map<string, ModelVariantSource[]>()
    const entries = tiers.get(tier) ?? []
    entries.push(m)
    tiers.set(tier, entries)
    byFamily.set(family, tiers)
  }

  const families: ModelVariantFamily[] = []
  for (const [family, tiers] of byFamily) {
    const tierList: ModelVariantTier[] = []
    for (const [tier, entries] of tiers) {
      const options: ModelVariantOption[] = entries
        .map((e): ModelVariantOption => {
          const precision: VariantPrecision = e.group?.precision ?? 'fp32'
          const optimization: VariantOptimization = e.group?.optimization ?? 'standard'
          return {
            modelId: e.id,
            precision,
            optimization,
            resolution: e.group?.resolution,
            label: variantLabel(precision, optimization),
            formats: entryFormats(e),
            sizeMB: smallestSizeMB(e),
          }
        })
        .toSorted((a, b) => {
          // Native resolution (undefined) first, then descending (320 > 256).
          if (a.resolution !== b.resolution) {
            return (b.resolution ?? Infinity) - (a.resolution ?? Infinity)
          }
          if (a.optimization !== b.optimization) return a.optimization === 'test' ? 1 : -1
          return PRECISION_ORDER.indexOf(a.precision) - PRECISION_ORDER.indexOf(b.precision)
        })
      // The tier's canonical (base) model = the fp32/standard option at the
      // LARGEST input it ships, else the first option — a tier is always
      // addressable even if it ships int8-only. Options are already sorted
      // resolution-descending, so `find` lands on the native build. It used to
      // require `resolution === undefined`, which no family declaring every
      // resolution explicitly can satisfy.
      const base =
        options.find((o) => o.precision === 'fp32' && o.optimization === 'standard') ?? options[0]
      if (base === undefined) continue
      const baseEntry = entries.find((e) => e.id === base.modelId)
      tierList.push({
        tier,
        label: baseEntry ? tierLabel(family, baseEntry.name) : tier.toUpperCase(),
        baseModelId: base.modelId,
        options,
      })
    }
    tierList.sort((a, b) => {
      const ia = TIER_ORDER.indexOf(a.tier)
      const ib = TIER_ORDER.indexOf(b.tier)
      if (ia !== -1 && ib !== -1) return ia - ib
      if (ia !== -1) return -1
      if (ib !== -1) return 1
      return a.tier.localeCompare(b.tier)
    })
    const hint = FAMILY_HINT[family]
    families.push({
      family,
      label: familyLabel(family),
      ...(hint !== undefined ? { hint } : {}),
      tiers: tierList,
    })
  }
  families.sort((a, b) => a.family.localeCompare(b.family))
  return families
}

/**
 * Map a grouped selection back to a flat catalog model id. Returns `null` when
 * no entry matches (the UI then falls back to the tier base / format default).
 * `precision`/`optimization` default to `fp32`/`standard` (the base build).
 */
export function resolveVariantModelId(
  models: readonly ModelVariantSource[],
  selection: {
    readonly family: string
    readonly tier: string
    readonly precision?: VariantPrecision
    readonly optimization?: VariantOptimization
    /** Omitted ⇒ the native build: the largest input this tier ships. */
    readonly resolution?: number
  },
): string | null {
  const precision = selection.precision ?? 'fp32'
  const optimization = selection.optimization ?? 'standard'
  const candidates = models.filter(
    (m) =>
      m.group !== undefined &&
      m.group.family === selection.family &&
      m.group.tier === selection.tier &&
      (m.group.precision ?? 'fp32') === precision &&
      (m.group.optimization ?? 'standard') === optimization,
  )
  if (selection.resolution !== undefined) {
    return candidates.find((m) => m.group?.resolution === selection.resolution)?.id ?? null
  }
  // No resolution asked for ⇒ the native build. Exact-matching `undefined`
  // would return null for any family that states every resolution, which is
  // now all of them.
  const native = candidates.toSorted(
    (a, b) => (b.group?.resolution ?? Infinity) - (a.group?.resolution ?? Infinity),
  )[0]
  return native?.id ?? null
}

/** Inverse: describe a flat model id as a grouped selection, or `null`. */
export function describeModelVariant(
  models: readonly ModelVariantSource[],
  modelId: string,
): {
  readonly family: string
  readonly tier: string
  readonly precision: VariantPrecision
  readonly optimization: VariantOptimization
  readonly resolution?: number
} | null {
  const entry = models.find((m) => m.id === modelId)
  if (entry?.group === undefined) return null
  return {
    family: entry.group.family,
    tier: entry.group.tier,
    precision: entry.group.precision ?? 'fp32',
    optimization: entry.group.optimization ?? 'standard',
    resolution: entry.group.resolution,
  }
}
