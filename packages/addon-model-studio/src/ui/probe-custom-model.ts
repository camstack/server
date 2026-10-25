/**
 * Best-effort sniff of a custom model file or URL — prefill only.
 * Never invents a postprocessor (D208): decode stays operator-owned.
 */
import type { ModelFormat } from '@camstack/types'
import { translate } from '../i18n/index.js'

export type ProbeCustomInput =
  | { readonly kind: 'file'; readonly filename: string; readonly bytes?: number }
  | { readonly kind: 'url'; readonly url: string }

export interface ProbeCustomResult {
  readonly format: ModelFormat | null
  readonly modelId: string
  readonly name: string
  /** Square side when guessable; otherwise the NVR-aligned default. */
  readonly inputSize: 320 | 640
  readonly sizeMB: number | null
  readonly hints: readonly string[]
}

const EXT_FORMAT: Readonly<Record<string, ModelFormat>> = {
  '.onnx': 'onnx',
  '.tflite': 'tflite',
  '.pt': 'pt',
  '.pth': 'pt',
  '.mlpackage': 'coreml',
  '.mlmodel': 'coreml',
  '.xml': 'openvino',
}

function extensionOf(path: string): string {
  const base = path.split(/[/?#]/).pop() ?? path
  const lower = base.toLowerCase()
  if (lower.endsWith('.mlpackage')) return '.mlpackage'
  const dot = lower.lastIndexOf('.')
  return dot >= 0 ? lower.slice(dot) : ''
}

function basenameStem(path: string): string {
  const base = path.split(/[/?#]/).pop() ?? path
  return base.replace(/\.(onnx|tflite|pt|pth|xml|mlmodel|mlpackage)$/i, '')
}

function sanitizeModelId(raw: string): string {
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  return cleaned.length > 0 ? cleaned : 'custom-model'
}

function guessInputSize(stem: string): 320 | 640 {
  if (/\b640\b/.test(stem) || /[_-]640([_-]|$)/.test(stem)) return 640
  if (/\b320\b/.test(stem) || /[_-]320([_-]|$)/.test(stem)) return 320
  return 320
}

function displayName(stem: string): string {
  const spaced = stem.replace(/[_-]+/g, ' ').trim()
  if (spaced.length === 0) return 'Custom model'
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase())
}

/**
 * Pure probe — extension → format, filename/URL → id/name/size hint.
 * Does not open the artifact; ONNX tensor dims stay the select default.
 */
export function probeCustomModel(input: ProbeCustomInput): ProbeCustomResult {
  const hints: string[] = []
  const path = input.kind === 'file' ? input.filename : input.url
  const ext = extensionOf(path)
  const format = EXT_FORMAT[ext] ?? null
  if (format === null && path.trim().length > 0) {
    hints.push(translate('probe.noFormat'))
  }

  const stem = basenameStem(path)
  const modelId = sanitizeModelId(stem)
  const name = displayName(stem)
  const inputSize = guessInputSize(stem)
  if (inputSize === 640) hints.push(translate('probe.size640'))
  else hints.push(translate('probe.size320'))

  let sizeMB: number | null = null
  if (input.kind === 'file' && typeof input.bytes === 'number' && input.bytes > 0) {
    sizeMB = Number((input.bytes / 1e6).toFixed(1))
  }

  hints.push(translate('probe.decode'))

  return { format, modelId, name, inputSize, sizeMB, hints }
}
