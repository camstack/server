/**
 * Pure selectors over a local plugin catalog YOLO catalog projection.
 *
 * Options are derived only from manifesto entries that survive the filters
 * above them. No hardcoded T/S/M/C × format matrix — if an entry is absent,
 * the combination is not offered and cannot resolve.
 */
import { translate } from '../i18n/index.js'

export type PluginCatalogFamily = 'yolov9t' | 'yolov9s' | 'yolov9m' | 'yolov9c'
export type PluginCatalogVariant = 'relu' | 'relu_test'
export type PluginCatalogFormat = 'coreml' | 'onnx' | 'openvino' | 'tflite'

export type PluginCatalogSelection = Readonly<{
  family?: PluginCatalogFamily
  variant?: PluginCatalogVariant
  format?: PluginCatalogFormat
  precision?: string
  inputSize?: string
}>

export type PluginCatalogSelectorEntry = Readonly<{
  id: string
  family: PluginCatalogFamily | string
  variant: PluginCatalogVariant | string
  format: PluginCatalogFormat | string
  precision: string
  inputSize: string | Readonly<{ width: number; height: number }>
}>

export type PluginCatalogOption<T extends string = string> = Readonly<{
  value: T
  label: string
}>

export const PLUGIN_CATALOG_FAMILIES = ['yolov9t', 'yolov9s', 'yolov9m', 'yolov9c'] as const
export const PLUGIN_CATALOG_VARIANTS = ['relu', 'relu_test'] as const
export const PLUGIN_CATALOG_FORMATS = ['coreml', 'onnx', 'openvino', 'tflite'] as const
export const PLUGIN_CATALOG_SELECTION_LEVELS = [
  'family',
  'variant',
  'format',
  'precision',
  'inputSize',
] as const

const FAMILY_LABEL: Readonly<Record<PluginCatalogFamily, string>> = {
  yolov9t: 'T',
  yolov9s: 'S',
  yolov9m: 'M',
  yolov9c: 'C',
}

const VARIANT_LABEL: Readonly<Record<PluginCatalogVariant, string>> = {
  relu: 'Standard',
  relu_test: 'Test',
}

const FORMAT_LABEL: Readonly<Record<PluginCatalogFormat, string>> = {
  coreml: 'CoreML',
  onnx: 'ONNX',
  openvino: 'OpenVINO',
  tflite: 'TFLite',
}

function isFamily(value: string): value is PluginCatalogFamily {
  return (PLUGIN_CATALOG_FAMILIES as readonly string[]).includes(value)
}

function isVariant(value: string): value is PluginCatalogVariant {
  return (PLUGIN_CATALOG_VARIANTS as readonly string[]).includes(value)
}

function isFormat(value: string): value is PluginCatalogFormat {
  return (PLUGIN_CATALOG_FORMATS as readonly string[]).includes(value)
}

export function pluginCatalogInputSizeKey(
  size: string | Readonly<{ width: number; height: number }>,
): string {
  if (typeof size === 'string')
    return size.includes('x') || size.includes('×') ? size.replace('×', 'x') : size
  return `${size.width}x${size.height}`
}

function prettyInputSize(key: string): string {
  return key.replace('x', '×')
}

function asSelectorEntry(
  entry: PluginCatalogSelectorEntry,
): PluginCatalogSelectorEntry | undefined {
  if (!isFamily(entry.family) || !isVariant(entry.variant) || !isFormat(entry.format)) {
    return undefined
  }
  return entry
}

export function filterPluginCatalogEntries<T extends PluginCatalogSelectorEntry>(
  entries: readonly T[],
  selection: PluginCatalogSelection,
): readonly T[] {
  return entries.filter((raw) => {
    const entry = asSelectorEntry(raw)
    if (!entry) return false
    if (selection.family !== undefined && entry.family !== selection.family) return false
    if (selection.variant !== undefined && entry.variant !== selection.variant) return false
    if (selection.format !== undefined && entry.format !== selection.format) return false
    if (selection.precision !== undefined && entry.precision !== selection.precision) return false
    if (
      selection.inputSize !== undefined &&
      pluginCatalogInputSizeKey(entry.inputSize) !== selection.inputSize
    ) {
      return false
    }
    return true
  })
}

function uniqueInOrder<T extends string>(values: readonly T[]): readonly T[] {
  const seen = new Set<T>()
  const out: T[] = []
  for (const value of values) {
    if (seen.has(value)) continue
    seen.add(value)
    out.push(value)
  }
  return out
}

export function pluginCatalogFamilyOptions(
  entries: readonly PluginCatalogSelectorEntry[],
): readonly PluginCatalogOption<PluginCatalogFamily>[] {
  const present = new Set(
    entries
      .map((entry) => entry.family)
      .filter((family): family is PluginCatalogFamily => isFamily(family)),
  )
  return PLUGIN_CATALOG_FAMILIES.filter((family) => present.has(family)).map((family) => ({
    value: family,
    label: FAMILY_LABEL[family],
  }))
}

export function pluginCatalogVariantOptions(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): readonly PluginCatalogOption<PluginCatalogVariant>[] {
  const remaining = filterPluginCatalogEntries(entries, { family: selection.family })
  const present = new Set(
    remaining
      .map((entry) => entry.variant)
      .filter((variant): variant is PluginCatalogVariant => isVariant(variant)),
  )
  return PLUGIN_CATALOG_VARIANTS.filter((variant) => present.has(variant)).map((variant) => ({
    value: variant,
    label: VARIANT_LABEL[variant],
  }))
}

export function pluginCatalogFormatOptions(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): readonly PluginCatalogOption<PluginCatalogFormat>[] {
  const remaining = filterPluginCatalogEntries(entries, {
    family: selection.family,
    variant: selection.variant,
  })
  const present = new Set(
    remaining
      .map((entry) => entry.format)
      .filter((format): format is PluginCatalogFormat => isFormat(format)),
  )
  return PLUGIN_CATALOG_FORMATS.filter((format) => present.has(format)).map((format) => ({
    value: format,
    label: FORMAT_LABEL[format],
  }))
}

export function pluginCatalogPrecisionOptions(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): readonly PluginCatalogOption[] {
  const remaining = filterPluginCatalogEntries(entries, {
    family: selection.family,
    variant: selection.variant,
    format: selection.format,
  })
  return uniqueInOrder(remaining.map((entry) => entry.precision)).map((precision) => ({
    value: precision,
    label: precision,
  }))
}

export function pluginCatalogInputSizeOptions(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): readonly PluginCatalogOption[] {
  const remaining = filterPluginCatalogEntries(entries, {
    family: selection.family,
    variant: selection.variant,
    format: selection.format,
    precision: selection.precision,
  })
  return uniqueInOrder(remaining.map((entry) => pluginCatalogInputSizeKey(entry.inputSize))).map(
    (inputSize) => ({
      value: inputSize,
      label: prettyInputSize(inputSize),
    }),
  )
}

export function sanitizePluginCatalogSelection(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): PluginCatalogSelection {
  const family = selection.family
  const familyOk =
    family !== undefined &&
    pluginCatalogFamilyOptions(entries).some((option) => option.value === family)
  const next: {
    family?: PluginCatalogFamily
    variant?: PluginCatalogVariant
    format?: PluginCatalogFormat
    precision?: string
    inputSize?: string
  } = {}
  if (!familyOk) return next
  next.family = family

  const variant = selection.variant
  if (
    variant !== undefined &&
    pluginCatalogVariantOptions(entries, next).some((option) => option.value === variant)
  ) {
    next.variant = variant
  }

  const format = selection.format
  if (
    format !== undefined &&
    pluginCatalogFormatOptions(entries, next).some((option) => option.value === format)
  ) {
    next.format = format
  }

  const precision = selection.precision
  if (
    precision !== undefined &&
    pluginCatalogPrecisionOptions(entries, next).some((option) => option.value === precision)
  ) {
    next.precision = precision
  }

  const inputSize = selection.inputSize
  if (
    inputSize !== undefined &&
    pluginCatalogInputSizeOptions(entries, next).some((option) => option.value === inputSize)
  ) {
    next.inputSize = inputSize
  }
  return next
}

export function pickPluginCatalogLevel(
  selection: PluginCatalogSelection,
  level: keyof PluginCatalogSelection,
  value: string,
): PluginCatalogSelection {
  const idx = PLUGIN_CATALOG_SELECTION_LEVELS.indexOf(level)
  const kept: {
    family?: PluginCatalogFamily
    variant?: PluginCatalogVariant
    format?: PluginCatalogFormat
    precision?: string
    inputSize?: string
  } = {}
  for (let i = 0; i < idx; i++) {
    const key = PLUGIN_CATALOG_SELECTION_LEVELS[i]!
    const current = selection[key]
    if (current !== undefined) {
      Object.assign(kept, { [key]: current })
    }
  }
  return { ...kept, [level]: value }
}

export function applyUniquePluginCatalogDefaults(
  entries: readonly PluginCatalogSelectorEntry[],
  selection: PluginCatalogSelection,
): PluginCatalogSelection {
  let next = sanitizePluginCatalogSelection(entries, selection)
  const family = pluginCatalogFamilyOptions(entries)
  if (next.family === undefined && family.length === 1) next = { ...next, family: family[0]!.value }
  const variant = pluginCatalogVariantOptions(entries, next)
  if (next.variant === undefined && variant.length === 1)
    next = { ...next, variant: variant[0]!.value }
  const format = pluginCatalogFormatOptions(entries, next)
  if (next.format === undefined && format.length === 1) next = { ...next, format: format[0]!.value }
  const precision = pluginCatalogPrecisionOptions(entries, next)
  if (next.precision === undefined && precision.length === 1) {
    next = { ...next, precision: precision[0]!.value }
  }
  const inputSize = pluginCatalogInputSizeOptions(entries, next)
  if (next.inputSize === undefined && inputSize.length === 1) {
    next = { ...next, inputSize: inputSize[0]!.value }
  }
  return next
}

export function resolvePluginCatalogEntry<T extends PluginCatalogSelectorEntry>(
  entries: readonly T[],
  selection: PluginCatalogSelection,
): T | undefined {
  if (
    selection.family === undefined ||
    selection.variant === undefined ||
    selection.format === undefined ||
    selection.precision === undefined ||
    selection.inputSize === undefined
  ) {
    return undefined
  }
  const matches = filterPluginCatalogEntries(entries, selection)
  return matches.length === 1 ? matches[0] : undefined
}

export function pluginCatalogFamilyLabel(family: PluginCatalogFamily): string {
  return FAMILY_LABEL[family]
}

export function pluginCatalogVariantLabel(variant: PluginCatalogVariant): string {
  return VARIANT_LABEL[variant]
}

export function pluginCatalogFormatLabel(format: PluginCatalogFormat): string {
  return FORMAT_LABEL[format]
}

export function pluginCatalogArtifactTrace(selection: PluginCatalogSelection): string {
  const family = selection.family !== undefined ? FAMILY_LABEL[selection.family] : '—'
  const variant = selection.variant !== undefined ? VARIANT_LABEL[selection.variant] : '—'
  const runtime = selection.format !== undefined ? FORMAT_LABEL[selection.format] : '—'
  const precision = selection.precision ?? '—'
  const input = selection.inputSize !== undefined ? prettyInputSize(selection.inputSize) : '—'
  return `${family} → ${variant} → ${runtime} → ${precision} → ${input}`
}

export function pluginCatalogDriftOf(
  drift: readonly { readonly manifestId: string; readonly status: string }[],
  manifestId: string,
): string | undefined {
  return drift.find((row) => row.manifestId === manifestId)?.status
}

export function pluginCatalogImportBlockedReason(input: {
  readonly driftStatus?: string
  readonly imported: boolean
  /**
   * When false, Library could not be read — Import stays allowed (register is
   * idempotent). Only used so callers can pass through; never blocks alone.
   */
  readonly registryKnown?: boolean
  /** @deprecated Prefer `registryKnown`. */
  readonly availabilityKnown?: boolean
}): string | undefined {
  if (input.imported) return translate('blocked.imported')
  // registryKnown / availabilityKnown intentionally ignored for blocking:
  // a failed list must not freeze every Import button (upsert is safe).
  void input.registryKnown
  void input.availabilityKnown
  if (input.driftStatus === 'ok') return undefined
  if (input.driftStatus === 'missing') {
    return translate('blocked.missing')
  }
  if (input.driftStatus === 'size-changed') {
    return translate('blocked.sizeChanged')
  }
  if (input.driftStatus === 'unavailable') {
    return translate('blocked.unavailable')
  }
  return translate('blocked.unknown')
}

/**
 * "Imported" means the model is in the Library registry — the same list
 * Catalog inventory shows. Disk availability alone is not enough: orphan availability
 * after a registry wipe used to keep Sources stuck on "imported".
 */
export function isPluginCatalogImported(
  registeredIds: ReadonlySet<string> | readonly string[],
  manifestId: string,
): boolean {
  return 'has' in registeredIds ? registeredIds.has(manifestId) : registeredIds.includes(manifestId)
}
