/**
 * Format-neutral registry identity for plugin catalog YOLO manifesto rows.
 *
 * Manifest ids stay per-artifact (`…-onnx`, `…-openvino-fp32`, …). The Library /
 * pipeline / availability key is one id per (variant × size × precision × res)
 * with `formats{}` accumulated — same contract as CamStack `yolov9m-320`.
 */
import type { CustomModelDescriptor, ModelCatalogEntry, ModelFormat } from '@camstack/types'
import {
  getPluginCatalogManifestEntry,
  PLUGIN_CATALOG_YOLO_MANIFEST,
  type PluginCatalogManifestEntry,
} from './plugin-catalog-yolo-manifest.js'

const TFLITE_PREFERENCE: readonly string[] = [
  'edgetpu',
  'int8',
  'full_integer_quant',
  'integer_quant',
  'float16',
  'float32',
]

function tierOfFamily(family: string): string {
  const m = /^yolov9([tsmc])$/i.exec(family)
  return m?.[1]?.toLowerCase() ?? family
}

function precisionIsInt8(precision: string): boolean {
  const p = precision.toLowerCase()
  return (
    p === 'int8' ||
    p === 'uint8' ||
    p === 'integer_quant' ||
    p === 'full_integer_quant' ||
    p === 'edgetpu'
  )
}

/**
 * Canonical registry id for a manifesto row (or an already-canonical id).
 * Examples: `scrypted-yolov9m-relu-320`, `scrypted-yolov9m-relu_test-320-int8`.
 */
export function pluginCatalogCanonicalId(entry: {
  readonly family: string
  readonly variant: string
  readonly precision: string
  readonly inputSize: { readonly width: number; readonly height: number }
}): string {
  const tier = tierOfFamily(entry.family)
  const res =
    entry.inputSize.width === entry.inputSize.height
      ? entry.inputSize.width
      : Math.max(entry.inputSize.width, entry.inputSize.height)
  let id = `scrypted-yolov9${tier}-${entry.variant}`
  if (precisionIsInt8(entry.precision)) id += '-int8'
  id += `-${res}`
  return id
}

export function pluginCatalogCanonicalIdFromManifestId(manifestId: string): string | null {
  const entry = getPluginCatalogManifestEntry(manifestId)
  if (!entry) {
    // Already canonical, or unknown.
    if (PLUGIN_CATALOG_YOLO_MANIFEST.some((m) => pluginCatalogCanonicalId(m) === manifestId))
      return manifestId
    return null
  }
  return pluginCatalogCanonicalId(entry)
}

/** Resolve a pipeline pin that may still be a per-format manifesto id. */
export function resolvePluginCatalogModelId(modelId: string): string {
  return pluginCatalogCanonicalIdFromManifestId(modelId) ?? modelId
}

export function pluginCatalogDisplayName(entry: {
  readonly family: string
  readonly variant: string
  readonly precision: string
  readonly inputSize: { readonly width: number; readonly height: number }
}): string {
  const tier = tierOfFamily(entry.family)
  const sizeLabel: Record<string, string> = { t: 'Tiny', s: 'Small', m: 'Medium', c: 'Compact' }
  const size = sizeLabel[tier] ?? tier.toUpperCase()
  const res =
    entry.inputSize.width === entry.inputSize.height
      ? entry.inputSize.width
      : Math.max(entry.inputSize.width, entry.inputSize.height)
  const parts = [`YOLOv9 ${size} @${res}`]
  if (entry.variant === 'relu_test') parts.push('(Test)')
  if (precisionIsInt8(entry.precision)) parts.push('INT8')
  return parts.join(' ')
}

/**
 * Among manifesto rows that share a canonical id and format `tflite`, pick the
 * EdgeTPU-preferred artifact (edgetpu > int8/quant > float*).
 */
export function preferredPluginCatalogTfliteEntry(
  canonicalId: string,
): PluginCatalogManifestEntry | undefined {
  const candidates = PLUGIN_CATALOG_YOLO_MANIFEST.filter(
    (m) => m.format === 'tflite' && pluginCatalogCanonicalId(m) === canonicalId,
  )
  if (candidates.length === 0) return undefined
  return candidates.toSorted((a, b) => {
    const ia = TFLITE_PREFERENCE.indexOf(a.precision.toLowerCase())
    const ib = TFLITE_PREFERENCE.indexOf(b.precision.toLowerCase())
    return (ia === -1 ? 99 : ia) - (ib === -1 ? 99 : ib)
  })[0]
}

/** Manifest entries that contribute a format to this canonical chip. */
export function pluginCatalogManifestEntriesForCanonical(
  canonicalId: string,
): readonly PluginCatalogManifestEntry[] {
  return PLUGIN_CATALOG_YOLO_MANIFEST.filter((m) => pluginCatalogCanonicalId(m) === canonicalId)
}

/**
 * Which manifesto id to import for a format on a chip. TFLite uses the
 * preferred EdgeTPU build; other formats take the smallest matching artifact.
 */
export function pluginCatalogManifestIdForFormat(
  canonicalId: string,
  format: ModelFormat,
): string | undefined {
  if (format === 'tflite') {
    return preferredPluginCatalogTfliteEntry(canonicalId)?.id
  }
  const candidates = PLUGIN_CATALOG_YOLO_MANIFEST.filter(
    (m) => m.format === format && pluginCatalogCanonicalId(m) === canonicalId,
  )
  if (candidates.length === 0) return undefined
  return candidates.toSorted(
    (a, b) => a.files.reduce((s, f) => s + f.size, 0) - b.files.reduce((s, f) => s + f.size, 0),
  )[0]?.id
}

/** Merge a newly imported format into an existing registry entry (same id). */
export function mergePluginCatalogDescriptorFormats(
  existing: CustomModelDescriptor | undefined,
  incoming: CustomModelDescriptor,
): CustomModelDescriptor {
  if (existing === undefined || existing.entry.id !== incoming.entry.id) return incoming
  return {
    stepId: incoming.stepId,
    entry: {
      ...existing.entry,
      ...incoming.entry,
      formats: { ...existing.entry.formats, ...incoming.entry.formats },
      group: incoming.entry.group ?? existing.entry.group,
      provider: 'scrypted',
      name: incoming.entry.name,
    },
  }
}

/**
 * Fold legacy per-format registry rows into canonical multi-format entries.
 * Keeps the first name/group; unions formats. Returns aliases for availability.
 */
export function migratePluginCatalogCustomModels(list: readonly CustomModelDescriptor[]): {
  readonly next: readonly CustomModelDescriptor[]
  /** old manifesto id → canonical id */
  readonly aliases: Readonly<Record<string, string>>
} {
  const aliases: Record<string, string> = {}
  const byCanonical = new Map<string, CustomModelDescriptor>()
  const others: CustomModelDescriptor[] = []

  for (const d of list) {
    const canon = pluginCatalogCanonicalIdFromManifestId(d.entry.id)
    if (canon === null) {
      // Not a known manifesto id — keep if already looks canonical or leave.
      if (d.entry.id.startsWith('scrypted-yolov9') && d.entry.provider === 'scrypted') {
        const prev = byCanonical.get(d.entry.id)
        byCanonical.set(d.entry.id, mergePluginCatalogDescriptorFormats(prev, d))
      } else {
        others.push(d)
      }
      continue
    }
    if (d.entry.id !== canon) aliases[d.entry.id] = canon
    const prev = byCanonical.get(canon)
    const seed =
      getPluginCatalogManifestEntry(d.entry.id) ??
      PLUGIN_CATALOG_YOLO_MANIFEST.find((m) => pluginCatalogCanonicalId(m) === canon)
    const stamped: CustomModelDescriptor = {
      stepId: d.stepId,
      entry: {
        ...d.entry,
        id: canon,
        provider: 'scrypted',
        name:
          seed !== undefined ? pluginCatalogDisplayName(seed) : (prev?.entry.name ?? d.entry.name),
        ...(seed !== undefined ? { group: buildCanonicalGroup(seed) } : {}),
      },
    }
    byCanonical.set(canon, mergePluginCatalogDescriptorFormats(prev, stamped))
  }

  return { next: [...others, ...byCanonical.values()], aliases }
}

export function buildCanonicalGroup(entry: {
  readonly family: string
  readonly variant: string
  readonly precision: string
  readonly inputSize: { readonly width: number; readonly height: number }
}): NonNullable<ModelCatalogEntry['group']> {
  const tier = tierOfFamily(entry.family)
  const res =
    entry.inputSize.width === entry.inputSize.height
      ? entry.inputSize.width
      : Math.max(entry.inputSize.width, entry.inputSize.height)
  return {
    family: 'yolov9',
    tier,
    resolution: res,
    ...(entry.variant === 'relu_test' ? { optimization: 'test' as const } : {}),
    ...(precisionIsInt8(entry.precision) ? { precision: 'int8' as const } : {}),
  }
}
