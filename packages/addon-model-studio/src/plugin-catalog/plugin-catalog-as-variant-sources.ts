/**
 * Project plugin catalog manifesto entries into `ModelVariantSource` for the
 * Catalog-style picker.
 *
 * plugin catalog HF layout (`scrypted/plugin-models`):
 *   `{format}/scrypted_yolov9{t|s|m|c}_relu[_test]/…`
 *
 * Same **family** (YOLOv9). Size letter = tier. `relu` vs `relu_test` are two
 * trainings of that family (our selectors label them Standard / Test) — NOT
 * CamStack's "Fast" optimization. The Variant pre-selector filters which
 * training is in the card; chips are only size + Int8.
 *
 * Runtime format (onnx / openvino / coreml / tflite) is the Import row.
 */
import type { ModelFormat, ModelVariantSource, VariantPrecision } from '@camstack/types'
import type { PluginCatalogCatalogEntryView } from '../ui/api.js'
import { pluginCatalogInputSizeKey } from './plugin-catalog-catalog-selectors.js'
import { pluginCatalogCanonicalId } from './plugin-catalog-canonical.js'

const FORMAT_SET = new Set<string>(['onnx', 'openvino', 'coreml', 'tflite', 'pt'])

const TIER_LABEL: Readonly<Record<string, string>> = {
  t: 'Tiny',
  s: 'Small',
  m: 'Medium',
  c: 'Compact',
}

function isModelFormat(value: string): value is ModelFormat {
  return FORMAT_SET.has(value)
}

function tierOfFamily(family: string): string {
  const m = /^yolov9([tsmc])$/i.exec(family)
  return m?.[1]?.toLowerCase() ?? family
}

/** int8-family artifacts → Int8 chip; fp16/float16/fp32 stay together. */
function precisionBucket(raw: string): VariantPrecision {
  const p = raw.toLowerCase()
  if (
    p === 'int8' ||
    p === 'uint8' ||
    p === 'integer_quant' ||
    p === 'full_integer_quant' ||
    p === 'edgetpu'
  ) {
    return 'int8'
  }
  return 'fp32'
}

function resolutionOf(entry: PluginCatalogCatalogEntryView): number | undefined {
  const key = pluginCatalogInputSizeKey(entry.inputSize)
  const m = /^(\d+)x(\d+)$/i.exec(key)
  if (!m) return undefined
  const w = Number(m[1])
  const h = Number(m[2])
  if (!Number.isFinite(w) || !Number.isFinite(h)) return undefined
  return w === h ? w : Math.max(w, h)
}

function entrySizeMB(entry: PluginCatalogCatalogEntryView): number {
  const fromModel = entry.model.formats[entry.format]?.sizeMB
  if (typeof fromModel === 'number' && fromModel > 0) return fromModel
  return entry.files.reduce((sum, file) => sum + file.size, 0) / 1e6
}

function displayName(tier: string, precision: VariantPrecision): string {
  const size = TIER_LABEL[tier] ?? tier.toUpperCase()
  return precision === 'int8' ? `YOLOv9 ${size} · Int8` : `YOLOv9 ${size}`
}

/** Merge key within one Variant (relu | relu_test) filter. */
function mergeKey(entry: PluginCatalogCatalogEntryView): string {
  return [
    'yolov9',
    tierOfFamily(entry.family),
    entry.variant,
    precisionBucket(entry.precision),
    String(resolutionOf(entry) ?? ''),
  ].join('|')
}

/**
 * Format-neutral chip id shown in GroupedModelSelector (no `-onnx`/`-coreml`).
 * Format-specific manifesto ids stay on each Import row via `pluginCatalogEntryForFormat`.
 */
export function pluginCatalogVariantSourceId(entry: PluginCatalogCatalogEntryView): string {
  return pluginCatalogCanonicalId(entry)
}

/**
 * Project entries (already filtered to one Variant by the caller) into
 * GroupedModelSelector sources. Test trainings stamp `optimization: 'test'`.
 */
export function pluginCatalogEntriesAsVariantSources(
  entries: readonly PluginCatalogCatalogEntryView[],
): readonly ModelVariantSource[] {
  const buckets = new Map<
    string,
    {
      sourceId: string
      formats: Record<string, { sizeMB: number }>
      group: NonNullable<ModelVariantSource['group']>
      name: string
    }
  >()

  for (const entry of entries) {
    if (!isModelFormat(entry.format)) continue
    const tier = tierOfFamily(entry.family)
    const precision = precisionBucket(entry.precision)
    const key = mergeKey(entry)
    const sizeMB = entrySizeMB(entry)
    const existing = buckets.get(key)
    if (existing) {
      const prev = existing.formats[entry.format]
      if (prev === undefined || sizeMB < prev.sizeMB) {
        existing.formats[entry.format] = { sizeMB }
      }
      continue
    }
    buckets.set(key, {
      sourceId: pluginCatalogVariantSourceId(entry),
      name: displayName(tier, precision),
      formats: { [entry.format]: { sizeMB } },
      group: {
        family: 'yolov9',
        tier,
        precision,
        ...(entry.variant === 'relu_test' ? { optimization: 'test' as const } : {}),
        ...(resolutionOf(entry) !== undefined ? { resolution: resolutionOf(entry) } : {}),
      },
    })
  }

  return [...buckets.values()].map((b) => ({
    id: b.sourceId,
    name: b.name,
    group: b.group,
    formats: b.formats,
  }))
}

export function pluginCatalogEntryForFormat(
  entries: readonly PluginCatalogCatalogEntryView[],
  variantSourceId: string,
  format: string,
): PluginCatalogCatalogEntryView | undefined {
  const byId = new Map(entries.map((e) => [e.id, e]))
  const direct = byId.get(variantSourceId)
  if (direct && direct.format === format) return direct

  const seed =
    direct ??
    entries.find((e) => e.id === variantSourceId) ??
    entries.find((e) => pluginCatalogVariantSourceId(e) === variantSourceId)
  if (!seed) return undefined
  const key = mergeKey(seed)
  const candidates = entries.filter((e) => mergeKey(e) === key && e.format === format)
  if (candidates.length === 0) return undefined
  return candidates.toSorted((a, b) => entrySizeMB(a) - entrySizeMB(b))[0]
}
