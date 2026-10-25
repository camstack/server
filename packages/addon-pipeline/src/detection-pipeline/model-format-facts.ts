/**
 * Two per-format facts `getSchema` reports beside `downloaded`, for Model
 * Studio → Installed (one row per model × format on a node).
 *
 * - {@link modelOnDiskState} — `current` / `stale` / `missing`. `downloaded`
 *   alone is `current`; it cannot tell a copy that is on disk but not proven
 *   at its catalog revision (D743/D744) from no copy at all, and those are
 *   different answers to "what does this node hold" — a stale copy is still
 *   bytes on the disk, still reclaimable, and is replaced on its next ensure.
 * - {@link formatPrecision} — the numeric precision of the BUILD, only when
 *   the build says so. An unsuffixed OpenVINO IR is FP16 for one family and
 *   FP32 for another (`scripts/build-camstack-models.py`), so this answers
 *   `undefined` rather than guess.
 *
 * Kept in the addon, not in `@camstack/system` / `@camstack/types`: both are
 * host-resolved at runtime, so a new value there would reach an addon only
 * with a server release, and this addon would fail to load on an older hub.
 */
import * as fs from 'node:fs'
// eslint-disable-next-line no-restricted-imports -- model-download helpers are a build-time dep (same waiver as provider.ts).
import { getModelFilePath, isModelDownloaded } from '@camstack/system/addon-utils'
import {
  HF_REPO,
  hfModelUrl,
  type ModelCatalogEntry,
  type ModelFormat,
  type ModelFormatPrecision,
  type ModelOnDiskState,
} from '@camstack/types'

/** What this node holds for one (model, format). */
export function modelOnDiskState(
  modelsDir: string,
  entry: ModelCatalogEntry,
  format: ModelFormat,
): ModelOnDiskState {
  if (entry.formats[format] === undefined) return 'missing'
  if (isModelDownloaded(modelsDir, entry, format)) return 'current'
  const modelPath = getModelFilePath(modelsDir, entry, format)
  return modelPath !== null && fs.existsSync(modelPath) ? 'stale' : 'missing'
}

const PRECISION_TOKEN = /(?:^|[-_.])(int8|fp16|fp32)(?=[-_.]|$)/i

/** The artefact's file name, without the directory. */
function artefactName(url: string): string {
  return url.split('/').pop() ?? url
}

/** Precision a token in the artefact name states (`…-int8.xml`, `…_int8_edgetpu.tflite`). */
function precisionFromName(name: string): ModelFormatPrecision | undefined {
  const match = PRECISION_TOKEN.exec(name)
  const token = match?.[1]?.toLowerCase()
  if (token === 'int8' || token === 'fp16' || token === 'fp32') return token
  return undefined
}

/**
 * The precision of one format's build, or `undefined` when nothing states it.
 * In order: a token in the file name; an `int8` variant group (every format of
 * an INT8 variant is quantised); an EdgeTPU build (the compiler accepts only
 * full-integer models); a Core ML build hosted on the CamStack mirror (every
 * CamStack Core ML export is FP16 — D743). Nothing else is assumed.
 */
export function formatPrecision(
  entry: ModelCatalogEntry,
  format: ModelFormat,
): ModelFormatPrecision | undefined {
  const formatEntry = entry.formats[format]
  if (formatEntry === undefined) return undefined
  const name = artefactName(formatEntry.url)
  const named = precisionFromName(name)
  if (named !== undefined) return named
  if (entry.group?.precision === 'int8') return 'int8'
  if (format === 'tflite' && /edgetpu/i.test(name)) return 'int8'
  if (format === 'coreml' && formatEntry.url.startsWith(hfModelUrl(HF_REPO, ''))) return 'fp16'
  return undefined
}
