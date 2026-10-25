/**
 * The NO-KEY fallback of the plus catalog source (D214 addendum). With a
 * configured plus catalog key the source shows the REAL account catalog
 * (`GET /v1/model/list`, base + custom); without one, the only honest offer
 * is what is publicly downloadable — the plus catalog DEFAULT model:
 *
 *  - SSDLite MobileDet (EdgeTPU compiled), fetched by plus catalog's own build
 *    from `google-coral/test_data` (release-frogfish). Public, stable URL,
 *    characteristics verified at the source.
 *  - The CPU tflite build is public too but is NOT listed: our tflite pool
 *    runtime binds the EdgeTPU delegate at init, so a CPU-only tflite model
 *    has nowhere to run.
 *  - Nothing else is invented here: YOLO-NAS / YOLOv9 have no canonical
 *    public artifact (DeciAI license / user exports) — they exist in the
 *    ACCOUNT view once a key is configured, or come in via Upload.
 *
 * The registered descriptor carries the PUBLIC url — every node downloads it
 * on demand through the normal model-download path, so no Distribute needed.
 */
import {
  plusCatalogDefaultClassFloors,
  plusCatalogLabelFields,
  type CustomModelDescriptor,
  type ModelCatalogEntry,
  type ModelFormat,
  type ModelLicense,
  type PostprocessorType,
} from '@camstack/types'
import { CORAL_MOBILEDET_APACHE } from '../model-licenses.js'
import { plusCatalogVariantGroup } from './plus-catalog-import.js'

/**
 * plus catalog's COCO-91 labelmap (`labelmap.txt`, dev branch, verified
 * 2026-08-21), order = model class index. plus catalog deliberately maps index 7
 * (truck) to `car` — kept verbatim so behaviour matches plus catalog's.
 */
export const PLUS_CATALOG_COCO91_LABELS: readonly string[] = [
  'person', // 0
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'car', // 7 — plus catalog maps truck → car
  'boat',
  'traffic light',
  'fire hydrant', // 10
  'street sign',
  'stop sign',
  'parking meter',
  'bench',
  'bird', // 15
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow', // 20
  'elephant',
  'bear',
  'zebra',
  'giraffe',
  'hat', // 25
  'backpack',
  'umbrella',
  'shoe',
  'eye glasses',
  'handbag', // 30
  'tie',
  'suitcase',
  'frisbee',
  'skis',
  'snowboard', // 35
  'sports ball',
  'kite',
  'baseball bat',
  'baseball glove',
  'skateboard', // 40
  'surfboard',
  'tennis racket',
  'bottle',
  'plate',
  'wine glass', // 45
  'cup',
  'fork',
  'knife',
  'spoon',
  'bowl', // 50
  'banana',
  'apple',
  'sandwich',
  'orange',
  'broccoli', // 55
  'carrot',
  'hot dog',
  'pizza',
  'donut',
  'cake', // 60
  'chair',
  'couch',
  'potted plant',
  'bed',
  'mirror', // 65
  'dining table',
  'window',
  'desk',
  'toilet',
  'door', // 70
  'tv',
  'laptop',
  'mouse',
  'remote',
  'keyboard', // 75
  'cell phone',
  'microwave',
  'oven',
  'toaster',
  'sink', // 80
  'refrigerator',
  'blender',
  'book',
  'clock',
  'vase', // 85
  'scissors',
  'teddy bear',
  'hair drier',
  'toothbrush',
  'hair brush', // 90
]

// ---------------------------------------------------------------------------
// Downloadable registry view — DERIVED from the model defs above. The server
// import action and the availability records key on `id`, so it stays stable.
// ---------------------------------------------------------------------------

export interface PlusCatalogCatalogEntry {
  /** Registry id the model registers under (operator can see it in pickers). */
  readonly id: string
  readonly label: string
  readonly format: ModelFormat
  /** Verified public download URL. */
  readonly url: string
  readonly sizeMB: number
  /** Square input side (px). */
  readonly inputSize: number
  readonly postprocessor: PostprocessorType | undefined
  readonly labels: readonly string[]
  readonly notes: string
  /** The model's licence record (D661) — carried onto the registered entry. */
  readonly license: ModelLicense
}

export const PLUS_CATALOG_PUBLIC_CATALOG: readonly PlusCatalogCatalogEntry[] = [
  {
    id: 'frigate-mobiledet-edgetpu',
    label: 'plus catalog default — SSDLite MobileDet (EdgeTPU)',
    format: 'tflite',
    url: 'https://github.com/google-coral/test_data/raw/release-frogfish/ssdlite_mobiledet_coco_qat_postprocess_edgetpu.tflite',
    sizeMB: 5.4,
    inputSize: 320,
    postprocessor: 'ssd',
    labels: PLUS_CATALOG_COCO91_LABELS,
    license: CORAL_MOBILEDET_APACHE,
    notes:
      "plus catalog's default detection model (the one a stock plus catalog + Coral install runs). EdgeTPU-compiled full-integer TFLite, 320×320, TFLite_Detection_PostProcess output → ssd decode. Requires a Coral (tflite format) node.",
  },
]

/**
 * Build the registrable descriptor for a curated catalog entry. The URL is
 * the PUBLIC one — any node downloads it on demand; no Distribute needed.
 */
export function buildPlusCatalogCatalogDescriptor(
  catalogId: string,
  overrides?: { readonly modelId?: string; readonly name?: string },
): CustomModelDescriptor {
  const cat = PLUS_CATALOG_PUBLIC_CATALOG.find((e) => e.id === catalogId)
  if (!cat) {
    throw new Error(
      `Unknown plus catalog catalog id "${catalogId}" — available: ${PLUS_CATALOG_PUBLIC_CATALOG.map((e) => e.id).join(', ')}`,
    )
  }
  const entry: ModelCatalogEntry = {
    id: overrides?.modelId?.trim() || cat.id,
    name: overrides?.name?.trim() || cat.label,
    description: `${cat.notes} Imported from the plus catalog public catalog via Model Studio.`,
    formats: {
      [cat.format]: { url: cat.url, sizeMB: cat.sizeMB, runtimes: ['python'] as const },
    },
    inputSize: { width: cat.inputSize, height: cat.inputSize },
    labels: cat.labels.map((name) => ({ id: name, name })),
    ...plusCatalogLabelFields(cat.labels),
    defaultClassFloors: plusCatalogDefaultClassFloors('stock'),
    preprocessMode: 'letterbox',
    provider: 'frigate',
    license: cat.license,
    group: plusCatalogVariantGroup('mobiledet', cat.inputSize),
    ...(cat.postprocessor !== undefined ? { postprocessor: cat.postprocessor } : {}),
  }
  return { stepId: 'object-detection', entry }
}
