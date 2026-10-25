/**
 * Every BUILT-IN model catalog CamStack can download from, in one walk (D661).
 *
 * Shared by `scripts/check-catalog-licence.ts` (the guard) and
 * `scripts/gen-model-licenses.ts` (the generator), so the two can never
 * disagree about which entries exist. Model Studio's two CURATED catalogs
 * (the pinned plugin catalog YOLOv9 manifest and the plus catalog public catalog) are
 * walked so the guard can require each entry to DECLARE a licence (Model
 * Studio shows it); the generator keeps them out of the public notice, since
 * they are imported on request from their publishers and never hosted by
 * CamStack. What an operator uploads or pulls from a plus catalog account is
 * theirs and is not walked.
 *
 * A new catalog array exported from `model-catalogs.ts` is picked up on its
 * own; a catalog in ANOTHER module has to be added here, and the guard's
 * entry-count floor is what notices when one silently is not.
 */
import type { ModelCatalogEntry } from '../../packages/types/src/types/models.js'
import * as detection from '../../packages/addon-pipeline/src/detection-pipeline/registry/model-catalogs.js'
import {
  CLIP_IMAGE_MODELS,
  CLIP_TEXT_MODELS,
} from '../../packages/addon-post-analysis/src/embedding-encoder/catalogs/embedding-models.js'
import { LLM_MODEL_CATALOG } from '../../packages/addon-ai/src/runtime/llm-model-catalog.js'
import { PLUGIN_CATALOG_YOLO_MANIFEST } from '../../packages/addon-model-studio/src/plugin-catalog/plugin-catalog-yolo-manifest.js'
import {
  buildPlusCatalogCatalogDescriptor,
  PLUS_CATALOG_PUBLIC_CATALOG,
} from '../../packages/addon-model-studio/src/plus-catalog/plus-catalog-catalog.js'

export type CatalogSource =
  | 'detection'
  | 'clip-image'
  | 'clip-text'
  | 'llm'
  | 'model-studio-plugin-catalog'
  | 'model-studio-plus-catalog'

export interface CatalogEntryRef {
  readonly source: CatalogSource
  readonly entry: ModelCatalogEntry
}

function isEntryArray(value: unknown): value is readonly ModelCatalogEntry[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((v) => typeof v === 'object' && v !== null && 'id' in v && 'formats' in v)
  )
}

/** Every entry of every built-in catalog, in catalog order (duplicates kept). */
export function builtInCatalogEntries(): readonly CatalogEntryRef[] {
  const tag =
    (source: CatalogSource) =>
    (entry: ModelCatalogEntry): CatalogEntryRef => ({ source, entry })
  return [
    ...Object.values(detection).filter(isEntryArray).flat().map(tag('detection')),
    ...CLIP_IMAGE_MODELS.map(tag('clip-image')),
    ...CLIP_TEXT_MODELS.map(tag('clip-text')),
    ...LLM_MODEL_CATALOG.map((m) => m.entry).map(tag('llm')),
    ...PLUGIN_CATALOG_YOLO_MANIFEST.map((m) => m.model).map(tag('model-studio-plugin-catalog')),
    ...PLUS_CATALOG_PUBLIC_CATALOG.map((c) => buildPlusCatalogCatalogDescriptor(c.id).entry).map(
      tag('model-studio-plus-catalog'),
    ),
  ]
}

export const HF_MIRROR_PREFIX = 'https://huggingface.co/camstack/camstack-models/resolve/main/'

/** The `<category>/<model>` folders of the CamStack HF mirror an entry downloads from. */
export function hostedFolders(entry: ModelCatalogEntry): readonly string[] {
  const urls = [
    ...Object.values(entry.formats).map((f) => f?.url ?? ''),
    ...(entry.extraFiles ?? []).map((f) => f.url),
  ]
  return [
    ...new Set(
      urls
        .filter((u) => u.startsWith(HF_MIRROR_PREFIX))
        .map((u) => u.slice(HF_MIRROR_PREFIX.length).split('/').slice(0, 2).join('/')),
    ),
  ]
}
