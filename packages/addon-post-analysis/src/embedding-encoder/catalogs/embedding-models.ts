import type { ClipModelMeta, ModelCatalogEntry, ModelFormatEntry } from '@camstack/types'
import { hfModelUrl } from '@camstack/types'
import { SIGLIP2_APACHE, SIGLIP2_TEXT_APACHE } from './model-licenses.js'

const HF_REPO = 'camstack/camstack-models'
const hf = (path: string) => hfModelUrl(HF_REPO, path)

/**
 * SigLIP2's tokenizer (HF `tokenizers` format, Gemma SentencePiece, 256k,
 * lower-casing), hosted next to the text-encoder onnx and fetched as a sibling
 * file so it lands beside the model. It has its own file name on purpose: see
 * `ClipModelMeta.tokenizerFile`.
 */
export const SIGLIP2_TOKENIZER_FILE = 'camstack-siglip2-b16-224-tokenizer.json'

const ovFormat = (url: string, sizeMB: number): ModelFormatEntry => {
  const base = url.split('/').pop() ?? ''
  const files = base.endsWith('.xml') ? [base.replace(/\.xml$/, '.bin')] : undefined
  return { url, sizeMB, runtimes: ['python'], ...(files ? { files } : {}) }
}

/**
 * Files inside an .mlpackage directory bundle.
 * Must be fetched alongside the package root when isDirectory is true.
 */
const MLPACKAGE_FILES = [
  'Manifest.json',
  'Data/com.apple.CoreML/model.mlmodel',
  'Data/com.apple.CoreML/weights/weight.bin',
] as const

/**
 * SigLIP2 B/16-224 (D649). 768-d, so its OWN index; a 64-token Gemma
 * SentencePiece window padded with 0 (the hosted `tokenizer.json` lower-cases,
 * see `scripts/build-siglip2-model.py`). The floor is SIGLIP2_SEARCH_MIN_SCORE.
 */
const SIGLIP2_META: ClipModelMeta = {
  textModelId: 'siglip2-b16-224-text',
  embeddingDim: 768,
  vectorIndex: 'object-clip-siglip2-b16-224',
  tokenizerFile: SIGLIP2_TOKENIZER_FILE,
  contextLength: 64,
  padId: 0,
  searchMinScore: 0.1,
}

/**
 * NO onnx vision builds, deliberately (2026-08-21). The int8 ONNX vision
 * exports were measured misaligned with the text encoders (matched image↔text
 * cosine ≈ 0.01 vs ≈ 0.22 for the fp16 openvino/coreml builds) — see the
 * catalog note in `addon-pipeline/.../model-catalogs.ts`. The image-encode leg
 * that consumed them here (`embeddingEncoder.encode` → PythonRawTensorEngine)
 * is retired with them.
 *
 * SigLIP2 is the SOLE survivor: MobileCLIP S0/S1/S2 (Apple AMLR, non-commercial)
 * left the catalog and the cluster for good (D703).
 */
export const CLIP_IMAGE_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'siglip2-b16-224',
    license: SIGLIP2_APACHE,
    name: 'SigLIP2 B/16',
    description:
      'Google SigLIP2 base, patch 16, 224×224 — Apache-2.0 vision encoder, 768-dim (fp16 OpenVINO/CoreML)',
    inputSize: { width: 224, height: 224 },
    labels: [],
    inputNormalization: 'none',
    clip: SIGLIP2_META,
    formats: {
      openvino: ovFormat(hf('clip/siglip2/openvino/camstack-siglip2-b16-224-vision.xml'), 186),
      coreml: {
        url: hf('clip/siglip2/coreml/camstack-siglip2-b16-224-vision.mlpackage'),
        sizeMB: 185,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
    },
  },
]

/** The text tower of the one CLIP model (fp16 onnx, aligned with the fp16 vision space). */
export const CLIP_TEXT_MODELS: readonly ModelCatalogEntry[] = [
  {
    // fp16 weights with fp32 I/O: cosine 1.0000 against the torch fp32 tower
    // (scripts/build-siglip2-model.py). The graph slices `input_ids[:, :64]`,
    // so an encoder that still pads to 77 gets the same vector for any query
    // under 64 tokens. The int8 build (283 MB, min cos 0.93) is the size
    // fallback and is not hosted.
    id: 'siglip2-b16-224-text',
    license: SIGLIP2_TEXT_APACHE,
    name: 'SigLIP2 B/16 Text Encoder',
    description: 'Text encoder for SigLIP2 B/16, 768-dim, fp16 (565 MB)',
    inputSize: { width: 0, height: 0 },
    labels: [],
    formats: {
      onnx: {
        url: hf('clip/siglip2/onnx/camstack-siglip2-b16-224-text.onnx'),
        sizeMB: 565,
        // The Gemma SentencePiece tokenizer with a Lowercase normalizer, under
        // its own name, distinct from the generic `tokenizer.json`.
        files: [SIGLIP2_TOKENIZER_FILE],
      },
      openvino: ovFormat(hf('clip/siglip2/openvino/camstack-siglip2-b16-224-text.xml'), 565),
    },
  },
]
