/**
 * A CLIP registry for store tests whose fake vectors are a handful of floats.
 *
 * Built through the PRODUCTION `buildClipModelRegistry`, from catalog entries
 * shaped like the real ones: MobileCLIP ids in `object-clip`, SigLIP2 in its own
 * index — only the dimension is shrunk to what the fixture vectors carry, so a
 * test exercises the real index resolution rather than a hand-rolled stub.
 */
import type { ModelCatalogEntry } from '@camstack/types'
import {
  buildClipModelRegistry,
  type ClipModelRegistry,
} from '../../../shared/clip/clip-model-registry.js'

export const TEST_SIGLIP_INDEX = 'object-clip-siglip2-b16-224'

/**
 * A SECOND index for store tests that need two feature spaces side by side. It
 * is a fixture, nothing more: production declares no index of this name since
 * the MobileCLIP models left the catalog (D703, D871), and the ids that share it
 * here are opaque strings, not models.
 */
export const TEST_STAND_IN_INDEX = 'object-clip'

function entry(id: string, vectorIndex: string, dim: number): ModelCatalogEntry {
  return {
    id,
    name: id,
    description: id,
    formats: {},
    inputSize: { width: 224, height: 224 },
    labels: [],
    clip: {
      textModelId: `${id}-text`,
      embeddingDim: dim,
      vectorIndex,
      tokenizerFile: `${id}-tokenizer.json`,
      contextLength: 64,
      padId: 0,
      searchMinScore: 0.2,
    },
  }
}

/**
 * `legacyIds` (default: both MobileCLIP tiers, plus the literal `clip` some
 * cascade fixtures stamp) share `object-clip` at `dim`; `siglip2-b16-224` gets
 * its own index at `siglipDim` (default: `dim`).
 */
export function testClipRegistry(
  dim: number,
  options: { readonly legacyIds?: readonly string[]; readonly siglipDim?: number } = {},
): ClipModelRegistry {
  const legacy = options.legacyIds ?? ['mobileclip-s1', 'mobileclip-s2', 'clip']
  return buildClipModelRegistry([
    ...legacy.map((id) => entry(id, 'object-clip', dim)),
    entry('siglip2-b16-224', TEST_SIGLIP_INDEX, options.siglipDim ?? dim),
  ])
}
