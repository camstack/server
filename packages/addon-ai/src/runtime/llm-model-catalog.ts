/**
 * Curated managed-model catalog (operator decision #4). Each entry carries BOTH
 * the LLM-facing picker view (`meta`) and the REUSED download-plane
 * `ModelCatalogEntry` (`entry`) so GGUFs ride `ensureModel` +
 * `model-distributor` untouched — no bespoke fetcher (spec §4.2).
 * Digests/sizes pinned via scratchpad/pin-llm-models.mjs (HF LFS `lfs.oid`,
 * which IS the file's sha256).
 *
 * ## Two tiers, and `minRamBytes` is what separates them
 *
 * The first three entries are sized to the WEAKEST runtime node (the N100
 * agent): 1-4 GB, Q4. `QWEN36_35B` is not — it is 23 GB and only a big node
 * can hold it. The catalog does not refuse to show it; `minRamBytes` is the
 * guidance, and the picker prints the size. Keeping the tiers in one list is
 * deliberate: an operator with a 64 GB box should not have to discover the
 * free-text field to run something real.
 *
 * ## This list is no longer the boundary of what can run
 *
 * Anything on Hugging Face is installable through `llm.resolveModelRef` +
 * `installModel` without a code change ({@link ./hf-ref.ts}). An entry here
 * buys exactly two things over typing the reference: a pinned digest nobody
 * has to re-verify, and a `contextSizeDefault`/`minRamBytes` somebody checked.
 * Add one only when both are true.
 */
import { createHash } from 'node:crypto'
import type {
  ManagedModelCatalogEntry,
  ManagedModelRef,
  ModelCatalogEntry,
  ModelExtraFile,
  ModelLicense,
} from '@camstack/types'
import {
  LLAMA_32_COMMUNITY,
  QWEN36_APACHE,
  QWEN_APACHE,
  QWEN_VL_APACHE,
} from './llm-model-licenses.js'

const GIB = 1024 * 1024 * 1024

export interface LlmManagedModel {
  /** LLM-facing picker view (the llm cap's listModelCatalog payload). */
  readonly meta: ManagedModelCatalogEntry
  /** The reused download-plane contract — rides ensureModel/model-distributor.
   *  inputSize/labels are detection-plane required fields with no GGUF meaning
   *  (zero/empty by convention). */
  readonly entry: ModelCatalogEntry
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024))
}

function textEntry(
  meta: ManagedModelCatalogEntry & { readonly sizeBytes: number },
  license: ModelLicense,
): LlmManagedModel {
  return {
    meta,
    entry: {
      id: meta.id,
      name: meta.label,
      description: `${meta.family} · ${meta.quantization}`,
      formats: { gguf: { url: meta.url, sizeMB: mb(meta.sizeBytes) } },
      inputSize: { width: 0, height: 0 },
      labels: [],
      license,
    },
  }
}

const QWEN: LlmManagedModel = textEntry(
  {
    id: 'llm-qwen2.5-1.5b-instruct-q4',
    label: 'Qwen2.5 1.5B Instruct',
    family: 'qwen2.5',
    purpose: 'text',
    url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF/resolve/main/qwen2.5-1.5b-instruct-q4_k_m.gguf',
    sha256: '6a1a2eb6d15622bf3c96857206351ba97e1af16c30d7a74ee38970e434e9407e',
    sizeBytes: 1_117_320_736,
    quantization: 'Q4_K_M',
    minRamBytes: 2 * GIB,
    contextSizeDefault: 4096,
  },
  QWEN_APACHE,
)

const LLAMA: LlmManagedModel = textEntry(
  {
    id: 'llm-llama3.2-3b-instruct-q4',
    label: 'Llama 3.2 3B Instruct',
    family: 'llama3.2',
    purpose: 'text',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF/resolve/main/Llama-3.2-3B-Instruct-Q4_K_M.gguf',
    sha256: '6c1a2b41161032677be168d354123594c0e6e67d2b9227c84f296ad037c728ff',
    sizeBytes: 2_019_377_696,
    quantization: 'Q4_K_M',
    minRamBytes: Math.round(3.5 * GIB),
    contextSizeDefault: 4096,
  },
  LLAMA_32_COMMUNITY,
)

const QWEN3VL2B_MODEL_BYTES = 1_107_410_624
const QWEN3VL2B_MMPROJ_BYTES = 819_395_232
const QWEN3VL2B_BASE = 'https://huggingface.co/unsloth/Qwen3-VL-2B-Instruct-GGUF/resolve/main'
const QWEN3VL2B_MMPROJ_URL = `${QWEN3VL2B_BASE}/mmproj-F16.gguf`
const QWEN3VL2B_URL = `${QWEN3VL2B_BASE}/Qwen3-VL-2B-Instruct-Q4_K_M.gguf`

/**
 * The light vision tier the operator asked for by weight class (~2 GB all in):
 * same Qwen3-VL family as the LM Studio 8B profile already in daily use, so
 * prompts and behaviour carry over — at a tenth of the 35B's disk and a RAM
 * floor a hub-adjacent node can always afford. This is the sensible default
 * for the NC confirm gates and summary judges.
 */
const QWEN3VL_2B: LlmManagedModel = {
  meta: {
    id: 'llm-qwen3-vl-2b-instruct-q4',
    label: 'Qwen3-VL 2B Instruct (vision, light)',
    family: 'qwen3-vl',
    purpose: 'vision',
    url: QWEN3VL2B_URL,
    sha256: '858fcf2a39dc73b26dd86592cb0a5f949b59d1edb365d1dea98e46b02e955e56',
    sizeBytes: QWEN3VL2B_MODEL_BYTES,
    quantization: 'Q4_K_M',
    minRamBytes: 3 * GIB,
    contextSizeDefault: 8192,
    mmprojUrl: QWEN3VL2B_MMPROJ_URL,
  },
  entry: {
    id: 'llm-qwen3-vl-2b-instruct-q4',
    license: QWEN_VL_APACHE,
    name: 'Qwen3-VL 2B Instruct (vision, light)',
    description: 'qwen3-vl · Q4_K_M · +mmproj',
    formats: { gguf: { url: QWEN3VL2B_URL, sizeMB: mb(QWEN3VL2B_MODEL_BYTES) } },
    inputSize: { width: 0, height: 0 },
    labels: [],
    extraFiles: [
      {
        url: QWEN3VL2B_MMPROJ_URL,
        filename: 'mmproj-F16.gguf',
        sizeMB: mb(QWEN3VL2B_MMPROJ_BYTES),
      },
    ],
  },
}

const QWEN3VL4B_MODEL_BYTES = 2_497_282_336
const QWEN3VL4B_MMPROJ_BYTES = 836_180_640
const QWEN3VL4B_BASE = 'https://huggingface.co/unsloth/Qwen3-VL-4B-Instruct-GGUF/resolve/main'
const QWEN3VL4B_MMPROJ_URL = `${QWEN3VL4B_BASE}/mmproj-F16.gguf`
const QWEN3VL4B_URL = `${QWEN3VL4B_BASE}/Qwen3-VL-4B-Instruct-Q4_K_M.gguf`

/**
 * The middle rung. It exists because the catalogue used to jump from 2B to a
 * 35B MoE, and the operator was running an 8B through an EXTERNAL LM Studio
 * endpoint precisely because nothing in between was offered here — the gap was
 * pushing the work outside the addon that is supposed to own it.
 *
 * At ~3.3 GB all in, this is also the only tier above 2B that a small
 * mini-PC-class node can hold, so the ladder is now 2B → 4B → 8B rather than
 * 2B → nothing.
 *
 * Same `qwen3vl_merger` projector as the 2B and the 8B: one prompt set and one
 * download shape cover all three. That is the reason this family was chosen
 * over its neighbours, not a benchmark — Gemma 4 and GLM-4.6V each want a
 * projector this addon has never exercised, for no verified gain at this size.
 */
const QWEN3VL_4B: LlmManagedModel = {
  meta: {
    id: 'llm-qwen3-vl-4b-instruct-q4',
    label: 'Qwen3-VL 4B Instruct (vision)',
    family: 'qwen3-vl',
    purpose: 'vision',
    url: QWEN3VL4B_URL,
    sha256: 'd4dcd426bfba75752a312b266b80fec8136fbaca13c62d93b7ac41fa67f0492b',
    sizeBytes: QWEN3VL4B_MODEL_BYTES,
    quantization: 'Q4_K_M',
    minRamBytes: 5 * GIB,
    contextSizeDefault: 8192,
    mmprojUrl: QWEN3VL4B_MMPROJ_URL,
  },
  entry: {
    id: 'llm-qwen3-vl-4b-instruct-q4',
    license: QWEN_VL_APACHE,
    name: 'Qwen3-VL 4B Instruct (vision)',
    description: 'qwen3-vl · Q4_K_M · +mmproj',
    formats: { gguf: { url: QWEN3VL4B_URL, sizeMB: mb(QWEN3VL4B_MODEL_BYTES) } },
    inputSize: { width: 0, height: 0 },
    labels: [],
    extraFiles: [
      {
        url: QWEN3VL4B_MMPROJ_URL,
        filename: 'mmproj-F16.gguf',
        sizeMB: mb(QWEN3VL4B_MMPROJ_BYTES),
      },
    ],
  },
}

const QWEN3VL8B_MODEL_BYTES = 5_027_785_568
const QWEN3VL8B_MMPROJ_BYTES = 1_159_030_336
const QWEN3VL8B_BASE = 'https://huggingface.co/unsloth/Qwen3-VL-8B-Instruct-GGUF/resolve/main'
const QWEN3VL8B_MMPROJ_URL = `${QWEN3VL8B_BASE}/mmproj-F16.gguf`
const QWEN3VL8B_URL = `${QWEN3VL8B_BASE}/Qwen3-VL-8B-Instruct-Q4_K_M.gguf`

/**
 * The tier the operator already trusts, brought in-house.
 *
 * This is the same weight class as the `qwen/qwen3-vl-8b` served by an external
 * LM Studio endpoint on the Mac: as a `managed-local` profile the addon owns
 * the runtime and `nodePin` puts the INFERENCE on that node, instead of the hub
 * calling out over HTTP to a process nobody here supervises.
 *
 * ~6.2 GB resident is a real bite on a 16 GB machine shared with the rest of
 * CamStack — that is what `minRamBytes` is for, and it is why the 4B above
 * exists rather than this being the only new rung.
 */
const QWEN3VL_8B: LlmManagedModel = {
  meta: {
    id: 'llm-qwen3-vl-8b-instruct-q4',
    label: 'Qwen3-VL 8B Instruct (vision)',
    family: 'qwen3-vl',
    purpose: 'vision',
    url: QWEN3VL8B_URL,
    sha256: '108e7ff92b78eefd3db4741885104acba514255c11b617d3c7b197a5f46efe89',
    sizeBytes: QWEN3VL8B_MODEL_BYTES,
    quantization: 'Q4_K_M',
    minRamBytes: 8 * GIB,
    contextSizeDefault: 8192,
    mmprojUrl: QWEN3VL8B_MMPROJ_URL,
  },
  entry: {
    id: 'llm-qwen3-vl-8b-instruct-q4',
    license: QWEN_VL_APACHE,
    name: 'Qwen3-VL 8B Instruct (vision)',
    description: 'qwen3-vl · Q4_K_M · +mmproj',
    formats: { gguf: { url: QWEN3VL8B_URL, sizeMB: mb(QWEN3VL8B_MODEL_BYTES) } },
    inputSize: { width: 0, height: 0 },
    labels: [],
    extraFiles: [
      {
        url: QWEN3VL8B_MMPROJ_URL,
        filename: 'mmproj-F16.gguf',
        sizeMB: mb(QWEN3VL8B_MMPROJ_BYTES),
      },
    ],
  },
}

const QWEN36_MODEL_BYTES = 22_134_528_992
const QWEN36_MMPROJ_BYTES = 899_283_680
const QWEN36_BASE = 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF/resolve/main'
const QWEN36_MMPROJ_URL = `${QWEN36_BASE}/mmproj-F16.gguf`
const QWEN36_URL = `${QWEN36_BASE}/Qwen3.6-35B-A3B-UD-Q4_K_M.gguf`

/**
 * The big tier. A 35B MoE with 3B active — it answers at a useful speed for
 * its size, which is why it is worth 23 GB of disk, but only on a node that
 * can hold it: `minRamBytes` is the weights plus a 32 k context, and it is
 * roughly four times what any other entry here asks for.
 *
 * `UD-Q4_K_M`, not `Q4_K_M`: this repo publishes 24 quantizations and NONE of
 * them is a plain `Q4_K_M` (they are Unsloth Dynamic). That is the same trap
 * `hf-ref.ts` refuses to walk into on the operator's behalf, and the reason
 * this entry names a file rather than a family.
 *
 * The `qwen3_5_moe` architecture landed in llama.cpp in 2026-02/03, well
 * before the pinned `LLAMA_SERVER_VERSION` (b10025, 2026-07-15), so the text
 * path is supported by the binary we ship.
 */
const QWEN36_35B: LlmManagedModel = {
  meta: {
    id: 'llm-qwen3.6-35b-a3b-ud-q4',
    label: 'Qwen3.6 35B-A3B (vision)',
    family: 'qwen3.6',
    purpose: 'vision',
    url: QWEN36_URL,
    sha256: 'ac0e2c1189e055faa36eff361580e79c5bd6f8e76bffb4ce547f167d53e31a61',
    sizeBytes: QWEN36_MODEL_BYTES,
    quantization: 'UD-Q4_K_M',
    minRamBytes: 26 * GIB,
    contextSizeDefault: 32768,
    mmprojUrl: QWEN36_MMPROJ_URL,
  },
  entry: {
    id: 'llm-qwen3.6-35b-a3b-ud-q4',
    license: QWEN36_APACHE,
    name: 'Qwen3.6 35B-A3B (vision)',
    description: 'qwen3.6 · UD-Q4_K_M · +mmproj',
    formats: { gguf: { url: QWEN36_URL, sizeMB: mb(QWEN36_MODEL_BYTES) } },
    inputSize: { width: 0, height: 0 },
    labels: [],
    extraFiles: [
      {
        url: QWEN36_MMPROJ_URL,
        filename: 'mmproj-F16.gguf',
        sizeMB: mb(QWEN36_MMPROJ_BYTES),
      },
    ],
  },
}

export const LLM_MODEL_CATALOG: readonly LlmManagedModel[] = [
  QWEN,
  LLAMA,
  QWEN3VL_2B,
  QWEN3VL_4B,
  QWEN3VL_8B,
  QWEN36_35B,
]

export function catalogById(id: string): LlmManagedModel | null {
  return LLM_MODEL_CATALOG.find((m) => m.meta.id === id) ?? null
}

export interface RefResolution {
  readonly entry: ModelCatalogEntry
  readonly localPathOverride?: string
}

/** url/path refs → a synthesized ModelCatalogEntry so the SAME download plane
 *  serves custom models. `path` refs skip download (localPathOverride). */
export function entryForRef(ref: ManagedModelRef): RefResolution | null {
  if (ref.kind === 'catalog') {
    const model = catalogById(ref.catalogId)
    return model === null ? null : { entry: model.entry }
  }
  if (ref.kind === 'url') {
    const id = `llm-custom-${createHash('sha1').update(ref.url).digest('hex').slice(0, 12)}`
    // `extraFiles` on the ref is the whole reason a custom VISION model works:
    // without it the mmproj never lands and llama-server starts blind. Shards
    // ride the same list — for a split GGUF, `url` is shard 1 and the rest are
    // extras, which is exactly what llama.cpp expects to find beside it.
    const extraFiles: readonly ModelExtraFile[] = (ref.extraFiles ?? []).map((f) => ({
      url: f.url,
      filename: f.filename,
      sizeMB: mb(f.sizeBytes),
    }))
    return {
      entry: {
        id,
        name: ref.label ?? id,
        description: 'custom GGUF',
        formats: {
          gguf: { url: ref.url, sizeMB: ref.sizeBytes === undefined ? 0 : mb(ref.sizeBytes) },
        },
        inputSize: { width: 0, height: 0 },
        labels: [],
        ...(extraFiles.length > 0 ? { extraFiles } : {}),
      },
    }
  }
  // path
  const id = `llm-path-${createHash('sha1').update(ref.path).digest('hex').slice(0, 12)}`
  return {
    entry: {
      id,
      name: id,
      description: 'pre-provisioned GGUF',
      formats: { gguf: { url: '', sizeMB: 0 } },
      inputSize: { width: 0, height: 0 },
      labels: [],
    },
    localPathOverride: ref.path,
  }
}
