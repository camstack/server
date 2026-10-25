import type { ModelCatalogEntry, ModelFormat, IAddonModelManager } from '@camstack/types'
import * as path from 'node:path'
import { downloadFile, ensureModel, isModelDownloaded } from './model-downloader.js'

/**
 * A catalog-bound face over the shared downloader.
 *
 * Downloading, completeness and the revision contract (D743) are
 * `ensureModel` / `isModelDownloaded`'s — this class only resolves a model id
 * (and a default format) against its catalog and keys progress by model id.
 * It used to carry its own copy of the download loop, which never learnt the
 * revision; one rule now lives in one place.
 *
 * Addons use this via `context.models.ensure(modelId, format)`.
 */
export class ModelDownloadService implements IAddonModelManager {
  private readonly catalog: ReadonlyMap<string, ModelCatalogEntry>

  constructor(
    private readonly modelsDir: string,
    catalog: readonly ModelCatalogEntry[],
    private readonly onProgress?: (modelId: string, downloaded: number, total: number) => void,
  ) {
    const map = new Map<string, ModelCatalogEntry>()
    for (const entry of catalog) {
      map.set(entry.id, entry)
    }
    this.catalog = map
  }

  /**
   * Ensure a model (and its extra files) is downloaded and current.
   * Returns the local filesystem path to the model file/directory.
   */
  async ensure(modelId: string, format?: ModelFormat): Promise<string> {
    const entry = this.catalog.get(modelId)
    if (!entry) {
      throw new Error(`ModelDownloadService: unknown model "${modelId}"`)
    }
    const selectedFormat = format ?? this.pickDefaultFormat(entry)
    if (!entry.formats[selectedFormat]) {
      throw new Error(`ModelDownloadService: model "${modelId}" has no ${selectedFormat} format`)
    }
    const onProgress = this.onProgress
    return ensureModel(
      this.modelsDir,
      entry,
      selectedFormat,
      onProgress ? (downloaded, total) => onProgress(modelId, downloaded, total ?? 0) : undefined,
    )
  }

  /**
   * Ensure extra files for a model are downloaded.
   * Returns the local paths of all extra files.
   */
  async ensureExtraFiles(modelId: string): Promise<readonly string[]> {
    const entry = this.catalog.get(modelId)
    if (!entry) {
      throw new Error(`ModelDownloadService: unknown model "${modelId}"`)
    }

    const extras = entry.extraFiles
    if (!extras || extras.length === 0) return []

    const paths: string[] = []
    for (const extra of extras) {
      const destPath = path.join(this.modelsDir, extra.filename)
      await downloadFile(extra.url, destPath)
      paths.push(destPath)
    }
    return paths
  }

  /** Absolute path to the shared models directory. */
  getModelsDir(): string {
    return this.modelsDir
  }

  /** True when the model is on disk, complete, and at its revision (D743). */
  isDownloaded(modelId: string, format?: ModelFormat): boolean {
    const entry = this.catalog.get(modelId)
    if (!entry) return false
    return isModelDownloaded(this.modelsDir, entry, format ?? this.pickDefaultFormat(entry))
  }

  /** Get the catalog entry for a model by ID. */
  getEntry(modelId: string): ModelCatalogEntry | undefined {
    return this.catalog.get(modelId)
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private pickDefaultFormat(entry: ModelCatalogEntry): ModelFormat {
    // Prefer onnx, then others in order
    const priority: ModelFormat[] = ['onnx', 'coreml', 'openvino', 'tflite', 'pt']
    for (const fmt of priority) {
      if (entry.formats[fmt]) return fmt
    }
    // Fallback: first available format
    const first = Object.keys(entry.formats)[0] as ModelFormat | undefined
    if (first) return first
    throw new Error(`ModelDownloadService: model "${entry.id}" has no formats`)
  }
}
