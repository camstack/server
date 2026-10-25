/**
 * Default `RuntimeModelOps` — the ONLY place the reused object-detection model
 * mechanism is imported (the documented `@camstack/system/addon-utils`
 * build-time-dep waiver that addon-post-analysis/addon-pipeline already use).
 * GGUFs ride the SHARED `downloadFile` (atomic `.downloading` + rename, HF
 * token headers, redirect following) — no bespoke fetcher (spec §4.2).
 *
 * ## Why this drives the file loop instead of calling `ensureModel`
 *
 * `ensureModel` downloads `extraFiles` FIRST and passes them NO progress
 * callback. That is invisible for a 40 kB labels JSON and unacceptable here: a
 * GGUF install is a 22 GB main file, up to N shards, and a 0.9 GB mmproj, and
 * under `ensureModel` every byte outside the main file moves in silence. A
 * multi-GB download that reports nothing reads as a hung node — the repo rule
 * is that a branch doing real work says so.
 *
 * So the loop is here, over the SAME `downloadFile`. What is gained: bytes
 * aggregated across the whole install, the name of the file currently moving,
 * and files already on disk excluded from the total rather than counted as
 * instantly-complete.
 */
// eslint-disable-next-line import/no-extraneous-dependencies -- build-time dep, host-provided at runtime

import { existsSync, statSync } from 'node:fs'
import * as path from 'node:path'
import {
  deleteModelFromDisk,
  downloadFile,
  getModelFilePath,
  isModelDownloaded,
} from '@camstack/system/addon-utils'
import type { ModelCatalogEntry } from '@camstack/types'
import type { RuntimeModelOps } from './runtime-provider.js'

const GGUF = 'gguf' as const
const BYTES_PER_MB = 1024 * 1024

interface PlannedFile {
  readonly url: string
  readonly destPath: string
  readonly filename: string
  /** From the catalog's `sizeMB`, so ±1 MB — a bar, not an invoice. */
  readonly expectedBytes: number
}

/**
 * Main file first, then shards/mmproj. Deliberate: a gated or mistyped URL
 * fails on the file that matters before 0.9 GB of projector is spent on it.
 */
export function planFiles(modelsDir: string, entry: ModelCatalogEntry): readonly PlannedFile[] {
  const out: PlannedFile[] = []
  const formatEntry = entry.formats[GGUF]
  if (formatEntry !== undefined) {
    const filename = formatEntry.url.split('/').pop() ?? `${entry.id}.${GGUF}`
    out.push({
      url: formatEntry.url,
      destPath: path.join(modelsDir, filename),
      filename,
      expectedBytes: formatEntry.sizeMB * BYTES_PER_MB,
    })
  }
  for (const extra of entry.extraFiles ?? []) {
    out.push({
      url: extra.url,
      destPath: path.join(modelsDir, extra.filename),
      filename: extra.filename,
      expectedBytes: extra.sizeMB * BYTES_PER_MB,
    })
  }
  return out
}

export function createDefaultModelOps(modelsDir: string): RuntimeModelOps {
  return {
    ensure: async (entry: ModelCatalogEntry, onProgress) => {
      const formatEntry = entry.formats[GGUF]
      if (formatEntry === undefined) {
        throw new Error(`model ${entry.id} declares no gguf format`)
      }
      const plan = planFiles(modelsDir, entry)
      const missing = plan.filter((f) => !existsSync(f.destPath))
      const totalBytes = missing.reduce((sum, f) => sum + f.expectedBytes, 0)

      let carried = 0
      for (const [index, file] of missing.entries()) {
        onProgress({
          file: file.filename,
          fileIndex: index + 1,
          fileCount: missing.length,
          downloadedBytes: carried,
          ...(totalBytes > 0 ? { totalBytes } : {}),
        })
        await downloadFile(file.url, file.destPath, (downloaded) => {
          onProgress({
            file: file.filename,
            fileIndex: index + 1,
            fileCount: missing.length,
            downloadedBytes: carried + downloaded,
            ...(totalBytes > 0 ? { totalBytes } : {}),
          })
        })
        carried += existsSync(file.destPath) ? statSync(file.destPath).size : file.expectedBytes
      }

      const main = getModelFilePath(modelsDir, entry, GGUF)
      if (main === null) throw new Error(`no gguf path for model ${entry.id}`)
      return main
    },
    isDownloaded: (entry) => isModelDownloaded(modelsDir, entry, GGUF),
    pathFor: (entry) => {
      const p = getModelFilePath(modelsDir, entry, GGUF)
      if (p === null) throw new Error(`no gguf path for model ${entry.id}`)
      return p
    },
    delete: async (entry) => {
      deleteModelFromDisk(modelsDir, entry, GGUF)
    },
    extraFilePath: (_entry, filename) => path.join(modelsDir, filename),
  }
}
