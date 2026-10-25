/**
 * Local, revision-pinned plugin catalog YOLO catalog.
 *
 * Host, repository and revision are server-owned. The client never supplies
 * URL, path, labels, classMap or checksum — import resolves an entry by id.
 *
 * Built from Hugging Face `scrypted/plugin-models` at
 * `187402b20a3be0a7fab9bceee21d857ed6ae0064` (2026-03-08). File sizes and
 * LFS oids are copied from the verified tree fixture — never invented.
 * OpenVINO `.xml` and CoreML `Manifest.json` sha256 were computed from
 * those pinned resolve URLs (not `main`). An entry without a verified
 * sha256 on every file is not importable.
 *
 * Verified at this pin (34/34 families × formats):
 * - input 320×320: OpenVINO XML 12/12, CoreML 8/8, ONNX 8/8, TFLite 6/6;
 * - ONNX/OpenVINO/CoreML output [1,7,2100], labels person/vehicle/animal;
 * - TFLite (incl. EdgeTPU) output is the 6-tensor DFL split-head →
 *   `postprocessor: 'yolo-split-dfl'` (not the step-default `yolo`);
 * - plugin catalog default preprocess is RGB resize/stretch to the square.
 *   `settings.pad` is opt-in and not equivalent to CamStack letterbox,
 *   so every entry uses `preprocessMode: 'resize'`.
 */
import type { LabelDefinition, ModelCatalogEntry } from '@camstack/types'
import manifestData from './plugin-catalog-yolo-manifest-data.json' with { type: 'json' }
import { PLUGIN_CATALOG_YOLOV9_UNKNOWN } from '../model-licenses.js'

export const PLUGIN_CATALOG_SHA256_RE = /^[0-9a-f]{64}$/

export type PluginCatalogManifestFile = Readonly<{
  relativePath: string
  size: number
  sha256: string
}>

export type PluginCatalogManifestEntry = Readonly<{
  id: string
  label: string
  family: 'yolov9t' | 'yolov9s' | 'yolov9m' | 'yolov9c'
  variant: 'relu' | 'relu_test'
  format: 'coreml' | 'onnx' | 'openvino' | 'tflite'
  precision: string
  inputSize: Readonly<{ width: number; height: number }>
  files: readonly PluginCatalogManifestFile[]
  model: ModelCatalogEntry
}>

export const PLUGIN_CATALOG_HF_HOST = 'https://huggingface.co'
export const PLUGIN_CATALOG_HF_REPO = 'scrypted/plugin-models'
export const PLUGIN_CATALOG_HF_REVISION = '187402b20a3be0a7fab9bceee21d857ed6ae0064'

export const PLUGIN_CATALOG_YOLO_LABELS = ['person', 'vehicle', 'animal'] as const

export const PLUGIN_CATALOG_IDENTITY_CLASS_MAP: NonNullable<ModelCatalogEntry['classMap']> = {
  mapping: { person: 'person', vehicle: 'vehicle', animal: 'animal' },
  preserveOriginal: false,
}

const PLUGIN_CATALOG_LABEL_DEFS: readonly LabelDefinition[] = PLUGIN_CATALOG_YOLO_LABELS.map(
  (id) => ({
    id,
    name: id,
  }),
)

const MLPACKAGE_INNER_FILES = [
  'Manifest.json',
  'Data/com.apple.CoreML/model.mlmodel',
  'Data/com.apple.CoreML/weights/weight.bin',
] as const

const INPUT_SIZE = { width: 320, height: 320 } as const

type ManifestSpec = {
  readonly id: string
  readonly label: string
  readonly family: PluginCatalogManifestEntry['family']
  readonly variant: PluginCatalogManifestEntry['variant']
  readonly format: PluginCatalogManifestEntry['format']
  readonly precision: string
  readonly files: readonly PluginCatalogManifestFile[]
  readonly sizeMB: number
}

export function assertPluginCatalogFileSha256(
  value: string | undefined,
  relativePath: string,
): string {
  if (value === undefined || !PLUGIN_CATALOG_SHA256_RE.test(value)) {
    throw new Error(`Invalid sha256 for ${relativePath}: expected 64 lowercase hex`)
  }
  return value
}

export function assertPluginCatalogRelativePath(value: string): string {
  if (value.length === 0 || value.startsWith('/') || value.includes('\\') || value.includes('\0')) {
    throw new Error(`Unsafe plugin catalog relative path: ${value}`)
  }
  const segments = value.split('/')
  if (segments.some((segment) => segment.length === 0 || segment === '.' || segment === '..')) {
    throw new Error(`Unsafe plugin catalog relative path: ${value}`)
  }
  return value
}

export function buildPluginCatalogResolveUrl(relativePath: string): string {
  const safe = assertPluginCatalogRelativePath(relativePath)
  const encoded = safe
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/')
  return `${PLUGIN_CATALOG_HF_HOST}/${PLUGIN_CATALOG_HF_REPO}/resolve/${PLUGIN_CATALOG_HF_REVISION}/${encoded}`
}

function packageDirectory(files: readonly PluginCatalogManifestFile[]): string {
  const manifest = files.find((file) => file.relativePath.endsWith('/Manifest.json'))
  if (!manifest) throw new Error('CoreML entry is missing Manifest.json')
  return assertPluginCatalogRelativePath(manifest.relativePath.replace(/\/Manifest\.json$/, ''))
}

function buildModel(spec: ManifestSpec): ModelCatalogEntry {
  const tier = spec.family.slice(-1)
  const int8 =
    spec.precision === 'int8' ||
    spec.precision === 'uint8' ||
    spec.precision === 'integer_quant' ||
    spec.precision === 'full_integer_quant' ||
    spec.precision === 'edgetpu'
  const group = {
    family: 'yolov9',
    tier,
    resolution: 320,
    ...(spec.variant === 'relu_test' ? { optimization: 'test' as const } : {}),
    ...(int8 ? { precision: 'int8' as const } : {}),
  }
  // Registry identity is format-neutral; manifesto `spec.id` stays the download key.
  // Keep in lockstep with `pluginCatalogCanonicalId` / `pluginCatalogDisplayName`.
  const sizeLabel: Record<string, string> = { t: 'Tiny', s: 'Small', m: 'Medium', c: 'Compact' }
  const canonicalId = `scrypted-yolov9${tier}-${spec.variant}${int8 ? '-int8' : ''}-320`
  const nameParts = [`YOLOv9 ${sizeLabel[tier] ?? tier.toUpperCase()} @320`]
  if (spec.variant === 'relu_test') nameParts.push('(Test)')
  if (int8) nameParts.push('INT8')
  const name = nameParts.join(' ')
  const description = `${name} — imported from the local plugin catalog YOLO catalog.`
  if (spec.format === 'coreml') {
    const dir = packageDirectory(spec.files)
    return {
      id: canonicalId,
      name,
      description,
      formats: {
        coreml: {
          url: buildPluginCatalogResolveUrl(dir),
          sizeMB: spec.sizeMB,
          isDirectory: true,
          files: [...MLPACKAGE_INNER_FILES],
          runtimes: ['python'],
        },
      },
      inputSize: INPUT_SIZE,
      labels: PLUGIN_CATALOG_LABEL_DEFS,
      preprocessMode: 'resize',
      classMap: PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
      group,
      provider: 'scrypted',
      license: PLUGIN_CATALOG_YOLOV9_UNKNOWN,
    }
  }
  if (spec.format === 'openvino') {
    const xml = spec.files.find((file) => file.relativePath.endsWith('.xml'))
    const bin = spec.files.find((file) => file.relativePath.endsWith('.bin'))
    if (!xml || !bin) throw new Error(`OpenVINO entry ${spec.id} is missing xml/bin`)
    const binName = bin.relativePath.split('/').pop() ?? 'best-converted.bin'
    return {
      id: canonicalId,
      name,
      description,
      formats: {
        openvino: {
          url: buildPluginCatalogResolveUrl(xml.relativePath),
          sizeMB: spec.sizeMB,
          files: [binName],
          runtimes: ['python'],
        },
      },
      inputSize: INPUT_SIZE,
      labels: PLUGIN_CATALOG_LABEL_DEFS,
      preprocessMode: 'resize',
      classMap: PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
      group,
      provider: 'scrypted',
      license: PLUGIN_CATALOG_YOLOV9_UNKNOWN,
    }
  }
  const main = spec.files[0]
  if (!main) throw new Error(`Entry ${spec.id} has no files`)
  return {
    id: canonicalId,
    name,
    description,
    formats: {
      [spec.format]: {
        url: buildPluginCatalogResolveUrl(main.relativePath),
        sizeMB: spec.sizeMB,
        runtimes: spec.format === 'tflite' ? (['python'] as const) : undefined,
      },
    },
    inputSize: INPUT_SIZE,
    labels: PLUGIN_CATALOG_LABEL_DEFS,
    preprocessMode: 'resize',
    classMap: PLUGIN_CATALOG_IDENTITY_CLASS_MAP,
    group,
    provider: 'scrypted',
    license: PLUGIN_CATALOG_YOLOV9_UNKNOWN,
    // TFLite (incl. EdgeTPU) emits the 6-tensor DFL split-head, not the ONNX
    // [1,7,2100] pack the step-default `yolo` decoder expects.
    ...(spec.format === 'tflite' ? { postprocessor: 'yolo-split-dfl' as const } : {}),
  }
}

function freezeEntry(spec: ManifestSpec): PluginCatalogManifestEntry {
  const files = spec.files.map((file) =>
    Object.freeze({
      relativePath: assertPluginCatalogRelativePath(file.relativePath),
      size: file.size,
      sha256: assertPluginCatalogFileSha256(file.sha256, file.relativePath),
    }),
  )
  return Object.freeze({
    id: spec.id,
    label: spec.label,
    family: spec.family,
    variant: spec.variant,
    format: spec.format,
    precision: spec.precision,
    inputSize: INPUT_SIZE,
    files: Object.freeze(files),
    model: buildModel({ ...spec, files }),
  })
}

export const PLUGIN_CATALOG_YOLO_MANIFEST: readonly PluginCatalogManifestEntry[] = Object.freeze(
  (manifestData as readonly ManifestSpec[]).map(freezeEntry),
)

export function getPluginCatalogManifestEntry(
  manifestId: string,
): PluginCatalogManifestEntry | undefined {
  return PLUGIN_CATALOG_YOLO_MANIFEST.find((entry) => entry.id === manifestId)
}
