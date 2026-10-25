/**
 * Consolidated model catalogs for the detection pipeline.
 * Each step references models from here — single source of truth.
 */
import type { LabelDefinition, ModelCatalogEntry, ModelFormatEntry } from '@camstack/types'
import { COCO_80_LABELS, hfModelUrl } from '@camstack/types'
import {
  AIY_BIRDS_APACHE,
  ANIMAL_CLASSIFIER_APACHE,
  APPLE_SOUNDANALYSIS,
  AURAFACE_APACHE,
  CORAL_COCO_APACHE,
  DBRO_YOLOV9_EDGETPU_GPL,
  FAST_PLATE_OCR_MIT,
  licensed,
  OPEN_LPR_YOLOX_APACHE,
  RFDETR_APACHE,
  SIGLIP2_APACHE,
  U2NET_APACHE,
  ULTRALYTICS_AGPL,
  ULTRALYTICS_YOLOV9_AGPL,
  VEHICLE_TYPE_V1_NC,
  YAMNET_APACHE,
  YUNET_MIT,
} from './model-licenses.js'

const HF_REPO = 'camstack/camstack-models'
const hf = (path: string) => hfModelUrl(HF_REPO, path)

/**
 * Build an OpenVINO format entry (always python runtime).
 *
 * OpenVINO IR is a two-file bundle: a `.xml` topology + a sibling `.bin`
 * weights file with the same basename. We declare the `.bin` in `files` so
 * the (format-agnostic) downloader fetches it alongside the `.xml` — without
 * the weights, OpenVINO compile fails with "Empty weights data in bin file".
 * A plain `.onnx` run through the OpenVINO runtime (e.g. yamnet) has no
 * sibling, so none is added.
 */
const ovFormat = (url: string, sizeMB: number): ModelFormatEntry => {
  const base = url.split('/').pop() ?? ''
  const files = base.endsWith('.xml') ? [base.replace(/\.xml$/, '.bin')] : undefined
  return { url, sizeMB, runtimes: ['python'], ...(files ? { files } : {}) }
}

/**
 * Build a precision-variant catalog entry (OpenVINO-only) derived from a base
 * detection model. fp16 halves the weights (Intel iGPU/NPU sweet spot); int8 is
 * NNCF post-training-quantized (~4× smaller, fastest on CPU/iGPU at a small
 * accuracy cost). The IRs live next to the base `.xml` on HF as
 * `camstack-<id>-<precision>.xml`. Lets an operator scale the model to the node
 * (e.g. yolo26x-int8 on a 265K, yolo26n-int8 on an N100).
 */
const ovPrecisionVariant = (
  baseId: string,
  ovDir: string,
  baseName: string,
  precision: 'fp16' | 'int8',
  sizeMB: number,
  legacy = false,
): ModelCatalogEntry => ({
  id: `${baseId}-${precision}`,
  name: `${baseName} (${precision.toUpperCase()})`,
  description:
    precision === 'int8'
      ? `${baseName} — OpenVINO INT8 variant for Intel iGPU/CPU; scale by hardware. On the Intel NPU it loses recall — use the base model there`
      : `${baseName} — OpenVINO ${precision.toUpperCase()} variant for Intel iGPU/NPU; scale by hardware`,
  inputSize: { width: 640, height: 640 },
  labels: [],
  preprocessMode: 'letterbox',
  license: licensed(ULTRALYTICS_AGPL, {
    modifications:
      precision === 'int8'
        ? 'exported to OpenVINO IR, then OpenVINO NNCF INT8 post-training quantisation'
        : 'OpenVINO FP16 export',
  }),
  formats: {
    openvino: ovFormat(hf(`${ovDir}/camstack-${baseId}-${precision}.xml`), sizeMB),
  },
  ...(legacy ? { legacy: true } : {}),
  // Group int8 variants under their family+tier so the selector nests them as
  // the "Int8" variant of the base tier. fp16 variants are legacy (hidden) and
  // carry no group. `family`/`tier` derive from the base id (`yolo26n` →
  // family `yolo26`, tier `n`).
  ...(precision === 'int8'
    ? {
        group: {
          family: baseId.slice(0, -1),
          tier: baseId.slice(-1),
          precision: 'int8' as const,
          // Stated, not implied: an entry that omits its resolution forces the
          // selector to ASSUME a family's native size, and that assumption is
          // what put "@640" on tier cards that also ship 320.
          resolution: 640,
        },
      }
    : {}),
})

const MLPACKAGE_FILES = [
  'Manifest.json',
  'Data/com.apple.CoreML/model.mlmodel',
  'Data/com.apple.CoreML/weights/weight.bin',
] as const

const YOLO26_TIER_NAME: Record<string, string> = {
  n: 'Nano',
  s: 'Small',
  m: 'Medium',
  l: 'Large',
}

const YOLOV9_TIER_NAME: Record<string, string> = {
  t: 'Tiny',
  s: 'Small',
  m: 'Medium',
  c: 'Compact',
}

/**
 * The Ultralytics YOLOv9 family (COCO-pretrained Ultralytics weights,
 * re-exported by CamStack — not trained by us) — the default NPU-detection line.
 * It runs on the Intel NPU ("AI Boost"), and its INT8 builds are as accurate
 * there as on the CPU. YOLO26 runs on the NPU too since OpenVINO 2025.4
 * (measured 2026-10-07): its base IRs match the CPU, its INT8 IRs lose recall
 * there (see `yolo26Reduced`). Empirically: the yolov9t-320-int8 export = ~298 fps on the
 * NPU vs yolo26n = 103 on the iGPU (~2.9×). t/s/m/c × {320,640}; each size ships
 * a base entry (onnx + coreml + openvino **fp16**) + an OpenVINO **int8** entry
 * (the NPU/iGPU-optimal config). CoreML (fp16) runs on the Mac ANE — the
 * apple-ane default detector (`default-detection-model.ts`).
 *
 * The CoreML packages were FP32 until 2026-10-07 and ran on the Mac GPU, never
 * the ANE. The FP16 re-export replaced them IN PLACE (same file names); the
 * revision every mirror artefact carries (the sha256 of its weight file, from
 * the downloader's generated table) makes a node holding the FP32 copy fetch
 * the FP16 one (D743, D744).
 */
const yolov9Reduced = (
  tier: string,
  res: number,
  sizes: {
    onnx: number
    coreml: number
    ovFp16: number
    ovInt8: number
  },
): ModelCatalogEntry[] => {
  const name = YOLOV9_TIER_NAME[tier] ?? tier.toUpperCase()
  return [
    {
      id: `yolov9${tier}-${res}`,
      group: { family: 'yolov9', tier, resolution: res },
      name: `YOLOv9 ${name} @${res}`,
      description: `YOLOv9 ${name} @${res}×${res} (Ultralytics) — OpenVINO fp16, runs on Intel NPU + iGPU.`,
      inputSize: { width: res, height: res },
      labels: [],
      preprocessMode: 'letterbox',
      license: licensed(ULTRALYTICS_YOLOV9_AGPL, {
        modifications: `exported at ${res}×${res} to ONNX, OpenVINO IR FP16 and CoreML`,
      }),
      formats: {
        onnx: {
          url: hf(`objectDetection/yolov9/onnx/camstack-yolov9${tier}-${res}.onnx`),
          sizeMB: sizes.onnx,
        },
        coreml: {
          url: hf(`objectDetection/yolov9/coreml/camstack-yolov9${tier}-${res}.mlpackage`),
          sizeMB: sizes.coreml,
          isDirectory: true,
          files: [...MLPACKAGE_FILES],
          runtimes: ['python'],
        },
        openvino: ovFormat(
          hf(`objectDetection/yolov9/openvino/camstack-yolov9${tier}-${res}-fp16.xml`),
          sizes.ovFp16,
        ),
      },
    },
    {
      id: `yolov9${tier}-${res}-int8`,
      group: {
        family: 'yolov9',
        tier,
        precision: 'int8' as const,
        resolution: res,
      },
      name: `YOLOv9 ${name} @${res} (INT8)`,
      description: `YOLOv9 ${name} @${res} — OpenVINO INT8 for the Intel NPU / iGPU. The NPU's fastest config (Ultralytics YOLOv9 weights).`,
      inputSize: { width: res, height: res },
      labels: [],
      preprocessMode: 'letterbox',
      license: licensed(ULTRALYTICS_YOLOV9_AGPL, {
        modifications: `exported at ${res}×${res} to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation`,
      }),
      formats: {
        openvino: ovFormat(
          hf(`objectDetection/yolov9/openvino/camstack-yolov9${tier}-${res}-int8.xml`),
          sizes.ovInt8,
        ),
      },
    },
  ]
}

/**
 * The publisher's 17-class labelmap (`labels-coco17.txt`), in logit order:
 * the first 9 COCO ids plus bird … bear, so the step's COCO class map applies
 * as it does to every COCO detector.
 */
const COCO17_IDS: readonly string[] = [
  'person',
  'bicycle',
  'car',
  'motorcycle',
  'airplane',
  'bus',
  'train',
  'truck',
  'boat',
  'bird',
  'cat',
  'dog',
  'horse',
  'sheep',
  'cow',
  'elephant',
  'bear',
]

const COCO17_LABELS: readonly LabelDefinition[] = COCO17_IDS.map((id) => {
  const label = COCO_80_LABELS.find((l) => l.id === id)
  if (label === undefined) throw new Error(`COCO17 label "${id}" is not a COCO-80 id`)
  return label
})

/**
 * YOLOv9-s compiled for the Coral Edge TPU (community build, record
 * `DBRO_YOLOV9_EDGETPU_GPL`): INT8, uint8 input, int8 class logits `[1, N, 17]`
 * + DFL boxes `[1, N, 64]` with the strides 8/16/32 concatenated (the v1.5
 * build adds a `[1, N, 1]` max-score tensor) — decoded by `yolo-split-dfl`.
 * Mirrored unchanged on our Hugging Face repo from the publisher's release
 * (`release`); the revision comes from the mirror's table (D744), and the
 * corresponding source sits in
 * `source/yolov9-edgetpu-dbro/`. The 320 build is the tflite default (D908); the
 * 512 build is selectable. Floors: their own rows in
 * `OBJECT_DETECTION_CLASS_FLOORS`.
 */
const yolov9EdgeTpuEntry = (
  res: number,
  release: string,
  file: string,
  sizeMB: number,
  note: string,
): ModelCatalogEntry => ({
  id: `yolov9s-${res}-edgetpu`,
  // Ungrouped, like the Coral SSD: a tflite-only build is offered where the
  // node's format is tflite, not as a tier of the YOLOv9 family picker.
  name: `YOLOv9 Small @${res} (Coral)`,
  description: `YOLOv9-s @${res}×${res}, fine-tuned to 17 COCO classes, INT8 compiled for the Coral Edge TPU (community release ${release}). ${note}`,
  inputSize: { width: res, height: res },
  labels: COCO17_LABELS,
  preprocessMode: 'letterbox',
  postprocessor: 'yolo-split-dfl',
  license: DBRO_YOLOV9_EDGETPU_GPL,
  formats: {
    tflite: {
      url: hf(`objectDetection/yolov9/tflite/${file}`),
      sizeMB,
      runtimes: ['python'],
    },
  },
})

const yolov9EdgeTpu: readonly ModelCatalogEntry[] = [
  yolov9EdgeTpuEntry(
    320,
    'v1.0',
    'yolov9-s-relu6-best_320_int8_edgetpu.tflite',
    7.8,
    'Every op on the TPU; ~10 ms/frame as published.',
  ),
  yolov9EdgeTpuEntry(
    512,
    'v1.5',
    'yolov9-s-relu6-tpumax_512_int8_edgetpu.tflite',
    7.8,
    'Finds smaller subjects than @320; ~21 ms/frame as published.',
  ),
]

/**
 * Reduced-input YOLO26 variants (2026-07-11). A lower square input (320 / 256)
 * is the biggest, cheapest latency lever measured across every runtime — Mac
 * ANE, Intel Ultra NPU, and especially the N100 — at a small-object accuracy
 * cost. Each resolution ships a base (fp32) entry (onnx + coreml + openvino)
 * grouped under `{family, tier, resolution}`, plus an OpenVINO INT8 entry (best
 * on Intel/N100) grouped with `precision:'int8'`. The grouped selector surfaces
 * `resolution` as a variant axis alongside precision.
 *
 * Intel NPU (OpenVINO 2025.4, measured 2026-10-07): every YOLO26 IR compiles
 * and runs. The base IRs are as accurate as the CPU; the INT8 IRs lose recall
 * there (`yolo26s-int8` 0.58 on the NPU vs 0.70 on CPU/iGPU, `yolo26m-int8`
 * 0.78 vs 0.83), so on an NPU the base IR is the one to run.
 */
const yolo26Reduced = (
  tier: string,
  res: number,
  sizes: { onnx: number; coreml: number; ovFp32: number; ovInt8: number },
): ModelCatalogEntry[] => {
  const name = YOLO26_TIER_NAME[tier] ?? tier.toUpperCase()
  return [
    {
      id: `yolo26${tier}-${res}`,
      group: { family: 'yolo26', tier, resolution: res },
      name: `YOLO26 ${name} @${res}`,
      description: `YOLO26 ${name}, reduced ${res}×${res} input — faster on ANE / hub NPU / N100 at a small-object accuracy cost`,
      inputSize: { width: res, height: res },
      labels: [],
      preprocessMode: 'letterbox',
      license: licensed(ULTRALYTICS_AGPL, {
        modifications: `re-exported at ${res}×${res} to ONNX, OpenVINO IR and CoreML`,
      }),
      formats: {
        onnx: {
          url: hf(`objectDetection/yolo26/onnx/camstack-yolo26${tier}-${res}.onnx`),
          sizeMB: sizes.onnx,
        },
        // A STATIC (batch 1) export since 2026-10-07: the batch-flexible one
        // aborted the process that loaded it (D742).
        coreml: {
          url: hf(`objectDetection/yolo26/coreml/camstack-yolo26${tier}-${res}.mlpackage`),
          sizeMB: sizes.coreml,
          isDirectory: true,
          files: [...MLPACKAGE_FILES],
          runtimes: ['python'],
        },
        openvino: ovFormat(
          hf(`objectDetection/yolo26/openvino/camstack-yolo26${tier}-${res}.xml`),
          sizes.ovFp32,
        ),
      },
    },
    {
      id: `yolo26${tier}-${res}-int8`,
      group: {
        family: 'yolo26',
        tier,
        precision: 'int8' as const,
        resolution: res,
      },
      name: `YOLO26 ${name} @${res} (INT8)`,
      description: `YOLO26 ${name} @${res} — OpenVINO INT8 for Intel iGPU/CPU; the N100's fastest config. On the Intel NPU it loses recall — use the base model there`,
      inputSize: { width: res, height: res },
      labels: [],
      preprocessMode: 'letterbox',
      license: licensed(ULTRALYTICS_AGPL, {
        modifications: `re-exported at ${res}×${res} to OpenVINO IR; OpenVINO NNCF INT8 post-training quantisation`,
      }),
      formats: {
        openvino: ovFormat(
          hf(`objectDetection/yolo26/openvino/camstack-yolo26${tier}-${res}-int8.xml`),
          sizes.ovInt8,
        ),
      },
    },
  ]
}

// ---------------------------------------------------------------------------
// Object Detection — YOLOv9
// ---------------------------------------------------------------------------

/** Variant family of the YOLO26 builds with an instance-segmentation head. */
export const YOLO26_SEG_FAMILY = 'yolo26-seg'

/** What choosing a seg build as the root means, in the catalog's own words. */
const YOLO26_SEG_ROOT_NOTE =
  'As the root model it detects like YOLO26 and also supplies the Segmentation step its masks (detection + masks, slightly heavier).'

const OBJECT_DETECTION_MODEL_ENTRIES: readonly ModelCatalogEntry[] = [
  // Legacy YOLOv9 base (yolov9t/s/c @640) removed 2026-07-20 — replaced by the
  // Ultralytics yolov9Reduced family (t/s/m/c × {320,640} × {int8,fp16}) further below.
  // ── YOLO26 — latest generation (2025) ──
  {
    id: 'yolo26n',
    license: ULTRALYTICS_AGPL,
    group: { family: 'yolo26', tier: 'n', resolution: 640 },
    name: 'YOLO26 Nano',
    description:
      'YOLO26 Nano — latest generation ultra-lightweight detector with attention mechanism',
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    formats: {
      onnx: {
        url: hf('objectDetection/yolo26/onnx/camstack-yolo26n.onnx'),
        sizeMB: 10,
      },
      coreml: {
        url: hf('objectDetection/yolo26/coreml/camstack-yolo26n.mlpackage'),
        sizeMB: 5,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('objectDetection/yolo26/openvino/camstack-yolo26n.xml'), 9),
    },
  },
  {
    id: 'yolo26s',
    license: ULTRALYTICS_AGPL,
    group: { family: 'yolo26', tier: 's', resolution: 640 },
    name: 'YOLO26 Small',
    description: 'YOLO26 Small — balanced speed/accuracy with attention-based architecture',
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    formats: {
      onnx: {
        url: hf('objectDetection/yolo26/onnx/camstack-yolo26s.onnx'),
        sizeMB: 37,
      },
      coreml: {
        url: hf('objectDetection/yolo26/coreml/camstack-yolo26s.mlpackage'),
        sizeMB: 18,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('objectDetection/yolo26/openvino/camstack-yolo26s.xml'), 36),
    },
  },
  {
    id: 'yolo26m',
    license: ULTRALYTICS_AGPL,
    group: { family: 'yolo26', tier: 'm', resolution: 640 },
    name: 'YOLO26 Medium',
    description: 'YOLO26 Medium — high accuracy general-purpose detector',
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    formats: {
      onnx: {
        url: hf('objectDetection/yolo26/onnx/camstack-yolo26m.onnx'),
        sizeMB: 78,
      },
      coreml: {
        url: hf('objectDetection/yolo26/coreml/camstack-yolo26m.mlpackage'),
        sizeMB: 39,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('objectDetection/yolo26/openvino/camstack-yolo26m.xml'), 78),
    },
  },
  {
    id: 'yolo26l',
    license: ULTRALYTICS_AGPL,
    group: { family: 'yolo26', tier: 'l', resolution: 640 },
    name: 'YOLO26 Large',
    description: 'YOLO26 Large — maximum accuracy for demanding deployments',
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    formats: {
      onnx: {
        url: hf('objectDetection/yolo26/onnx/camstack-yolo26l.onnx'),
        sizeMB: 95,
      },
      coreml: {
        url: hf('objectDetection/yolo26/coreml/camstack-yolo26l.mlpackage'),
        sizeMB: 48,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('objectDetection/yolo26/openvino/camstack-yolo26l.xml'), 95),
    },
  },
  {
    id: 'yolo26x',
    license: ULTRALYTICS_AGPL,
    legacy: true, // audit 2026-07-09: superseded/redundant — kept resolvable, hidden from selection
    name: 'YOLO26 XLarge',
    description: 'YOLO26 XLarge — highest accuracy, attention-based architecture',
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    formats: {
      onnx: {
        url: hf('objectDetection/yolo26/onnx/camstack-yolo26x.onnx'),
        sizeMB: 213,
      },
      coreml: {
        url: hf('objectDetection/yolo26/coreml/camstack-yolo26x.mlpackage'),
        sizeMB: 107,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('objectDetection/yolo26/openvino/camstack-yolo26x.xml'), 213),
    },
  },
  // ── Coral USB Edge TPU — CamStack's one offered SSD ──
  // EdgeTPU-compiled `.tflite` (runtime `edgetpu`, format `tflite`). Emits the
  // SSD `TFLite_Detection_PostProcess` 4-tensor layout → per-model
  // `postprocessor: 'ssd'` (step default is `yolo`). `ssd.py` owns the Coral
  // COCO-90 label map. Rival Coral SSDs (EfficientDet-Lite0, SSDLite MobileDet)
  // were deleted (D703 follow-up): one licence-clean survivor, selectable, and
  // `defaultModelIdByFormat.tflite`. plus catalog still offers MobileDet via its own
  // catalog import; plugin catalog YOLO TFLite needs a separate decoder (not this entry).
  {
    id: 'ssd-mobilenet-v2-coco-edgetpu',
    license: CORAL_COCO_APACHE,
    name: 'SSD MobileNet V2 (Coral)',
    description:
      'SSD MobileNet V2 COCO — EdgeTPU-compiled full-integer TFLite, 300×300; runs on the Coral USB Edge TPU (~11 ms/frame)',
    inputSize: { width: 300, height: 300 },
    labels: [],
    preprocessMode: 'letterbox',
    postprocessor: 'ssd',
    formats: {
      tflite: {
        url: 'https://github.com/google-coral/test_data/raw/master/ssd_mobilenet_v2_coco_quant_postprocess_edgetpu.tflite',
        sizeMB: 6.6,
        runtimes: ['python'],
      },
    },
  },
  // ── YOLOv9-s on the Coral — the Coral default (D908, D912) ──
  ...yolov9EdgeTpu,
  // ── YOLO26-seg — the COCO detector plus a mask per object (D737) ──
  // The same 80 COCO classes, boxes decoded exactly as the plain detector's
  // (`yolo-seg` shares `yolo`'s box decode), plus one instance mask per kept
  // detection. Selectable as the camera root; it then supplies the
  // `segmentation` step from its own masks. Never an automatic default — the
  // format and hardware defaults name plain detectors only.
  {
    id: 'yolo26n-seg',
    license: licensed(ULTRALYTICS_AGPL, {
      modifications: 'exported to ONNX, OpenVINO IR and CoreML',
    }),
    group: { family: YOLO26_SEG_FAMILY, tier: 'n', resolution: 640 },
    name: 'YOLO26-seg Nano',
    description: `YOLO26 Nano with its instance-segmentation head — ultra-lightweight. ${YOLO26_SEG_ROOT_NOTE}`,
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    postprocessor: 'yolo-seg',
    formats: {
      onnx: {
        url: hf('segmentation/yolo26-seg/onnx/camstack-yolo26n-seg.onnx'),
        sizeMB: 11,
      },
      coreml: {
        url: hf('segmentation/yolo26-seg/coreml/camstack-yolo26n-seg.mlpackage'),
        sizeMB: 6,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('segmentation/yolo26-seg/openvino/camstack-yolo26n-seg.xml'), 11),
    },
  },
  {
    id: 'yolo26s-seg',
    license: licensed(ULTRALYTICS_AGPL, {
      modifications: 'exported to ONNX, OpenVINO IR and CoreML',
    }),
    group: { family: YOLO26_SEG_FAMILY, tier: 's', resolution: 640 },
    name: 'YOLO26-seg Small',
    description: `YOLO26 Small with its instance-segmentation head — balanced. ${YOLO26_SEG_ROOT_NOTE}`,
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    postprocessor: 'yolo-seg',
    formats: {
      onnx: {
        url: hf('segmentation/yolo26-seg/onnx/camstack-yolo26s-seg.onnx'),
        sizeMB: 40,
      },
      coreml: {
        url: hf('segmentation/yolo26-seg/coreml/camstack-yolo26s-seg.mlpackage'),
        sizeMB: 20,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('segmentation/yolo26-seg/openvino/camstack-yolo26s-seg.xml'), 40),
    },
  },
  {
    id: 'yolo26m-seg',
    license: licensed(ULTRALYTICS_AGPL, {
      modifications: 'exported to ONNX, OpenVINO IR and CoreML',
    }),
    group: { family: YOLO26_SEG_FAMILY, tier: 'm', resolution: 640 },
    name: 'YOLO26-seg Medium',
    description: `YOLO26 Medium with its instance-segmentation head — high accuracy. ${YOLO26_SEG_ROOT_NOTE}`,
    inputSize: { width: 640, height: 640 },
    labels: [],
    preprocessMode: 'letterbox',
    postprocessor: 'yolo-seg',
    formats: {
      onnx: {
        url: hf('segmentation/yolo26-seg/onnx/camstack-yolo26m-seg.onnx'),
        sizeMB: 90,
      },
      coreml: {
        url: hf('segmentation/yolo26-seg/coreml/camstack-yolo26m-seg.mlpackage'),
        sizeMB: 45,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('segmentation/yolo26-seg/openvino/camstack-yolo26m-seg.xml'), 90),
    },
  },
  // Legacy plugin catalog-ReLU YOLOv9 detectors removed 2026-07-20 (kept only the Ultralytics v9 re-exports + yolo26).

  // --- Precision variants (OpenVINO fp16 + NNCF int8) — scale by hardware ---
  // fp16 IRs are CONSOLIDATE→legacy: the OpenVINO GPU plugin runs fp32 IR in
  // fp16 by default, so an fp16 IR saves only disk, not inference — folded into
  // the base. int8 (NNCF) is a real throughput win → KEEP for the curated
  // bases. yolov9t / yolo26x variants are legacy because their base models are
  // legacy (superseded nano / non-NVR ceiling).
  ovPrecisionVariant('yolo26n', 'objectDetection/yolo26/openvino', 'YOLO26 Nano', 'fp16', 5, true),
  ovPrecisionVariant('yolo26n', 'objectDetection/yolo26/openvino', 'YOLO26 Nano', 'int8', 3),
  ovPrecisionVariant(
    'yolo26s',
    'objectDetection/yolo26/openvino',
    'YOLO26 Small',
    'fp16',
    19,
    true,
  ),
  ovPrecisionVariant('yolo26s', 'objectDetection/yolo26/openvino', 'YOLO26 Small', 'int8', 10),
  ovPrecisionVariant(
    'yolo26m',
    'objectDetection/yolo26/openvino',
    'YOLO26 Medium',
    'fp16',
    41,
    true,
  ),
  ovPrecisionVariant('yolo26m', 'objectDetection/yolo26/openvino', 'YOLO26 Medium', 'int8', 21),
  ovPrecisionVariant(
    'yolo26l',
    'objectDetection/yolo26/openvino',
    'YOLO26 Large',
    'fp16',
    50,
    true,
  ),
  ovPrecisionVariant('yolo26l', 'objectDetection/yolo26/openvino', 'YOLO26 Large', 'int8', 25),
  // ── Reduced-input variants (2026-07-11) — resolution axis in the grouped selector ──
  ...yolo26Reduced('n', 320, {
    onnx: 10.47,
    coreml: 5.05,
    ovFp32: 10.05,
    ovInt8: 3.29,
  }),
  ...yolo26Reduced('n', 256, {
    onnx: 10.47,
    coreml: 5.05,
    ovFp32: 10.05,
    ovInt8: 3.29,
  }),
  ...yolo26Reduced('s', 320, {
    onnx: 38.82,
    coreml: 19.23,
    ovFp32: 38.4,
    ovInt8: 10.43,
  }),
  ...yolo26Reduced('s', 256, {
    onnx: 38.82,
    coreml: 19.23,
    ovFp32: 38.4,
    ovInt8: 10.43,
  }),
  ...yolo26Reduced('m', 320, {
    onnx: 83.31,
    coreml: 41.07,
    ovFp32: 82.09,
    ovInt8: 21.47,
  }),
  ...yolo26Reduced('m', 256, {
    onnx: 83.31,
    coreml: 41.07,
    ovFp32: 82.09,
    ovInt8: 21.47,
  }),
  ...yolo26Reduced('l', 320, {
    onnx: 101.74,
    coreml: 49.97,
    ovFp32: 99.85,
    ovInt8: 26.31,
  }),
  ...yolo26Reduced('l', 256, {
    onnx: 101.74,
    coreml: 49.97,
    ovFp32: 99.85,
    ovInt8: 26.31,
  }),
  // The Ultralytics YOLOv9 family (COCO-pretrained Ultralytics weights, re-exported
  // by CamStack — not trained by us) — the default NPU-detection line.
  ...yolov9Reduced('t', 320, {
    onnx: 8,
    coreml: 4.3,
    ovFp16: 4,
    ovInt8: 3,
  }),
  ...yolov9Reduced('t', 640, {
    onnx: 8,
    coreml: 4.4,
    ovFp16: 4,
    ovInt8: 3,
  }),
  ...yolov9Reduced('s', 320, {
    onnx: 27,
    coreml: 14.1,
    ovFp16: 14,
    ovInt8: 8,
  }),
  ...yolov9Reduced('s', 640, {
    onnx: 27,
    coreml: 14.1,
    ovFp16: 14,
    ovInt8: 8,
  }),
  ...yolov9Reduced('m', 320, {
    onnx: 76,
    coreml: 38.6,
    ovFp16: 38,
    ovInt8: 20,
  }),
  ...yolov9Reduced('m', 640, {
    onnx: 76,
    coreml: 38.6,
    ovFp16: 38,
    ovInt8: 20,
  }),
  ...yolov9Reduced('c', 320, {
    onnx: 97,
    coreml: 48.7,
    ovFp16: 49,
    ovInt8: 25,
  }),
  ...yolov9Reduced('c', 640, {
    onnx: 97,
    coreml: 48.7,
    ovFp16: 49,
    ovInt8: 25,
  }),
  ovPrecisionVariant(
    'yolo26x',
    'objectDetection/yolo26/openvino',
    'YOLO26 XLarge',
    'fp16',
    112,
    true,
  ),
  ovPrecisionVariant(
    'yolo26x',
    'objectDetection/yolo26/openvino',
    'YOLO26 XLarge',
    'int8',
    56,
    true,
  ),
] as const

/**
 * The per-class confidence-floor DEFAULTS of each object-detection model
 * (D738), keyed by model id. Applied onto the catalog entries below as
 * `defaultClassFloors`; this is the ONLY place a model's floor is written. A
 * model absent here runs at the step slider's global default
 * (`ObjectDetectionStep.getConfigSchema`: person 0.65, vehicle 0.50, animal
 * 0.50).
 *
 * Measured 2026-10-07 (`docs/benchmarks/model-floors.json`, which also holds
 * precision/recall per class): the floor is the lowest score at which the model
 * makes no more false positives than the production root (`yolov9m-320-int8` at
 * 0.65 / 0.50 / 0.50) on the same 409 hub frames, against an ensemble
 * pseudo-ground-truth, rounded to 0.05, minimum 0.25. Floors carry about
 * +/-0.05-0.10 of noise. Where a floor hinges on a single high-score false
 * positive, the next-lower value the measurement gives is used instead (marked
 * below). A re-measurement replaces the JSON and these rows together; a spec
 * holds them equal.
 *
 * Re-derived 2026-10-09 for the INT8 IRs re-quantised by D818
 * (`docs/benchmarks/2026-10-09-int8-recipe.md`, 400 hub frames, same rule and
 * budget): only classes that moved beyond the noise changed —
 * `yolov9m-320-int8` animal, `yolov9s-640-int8` animal, and `yolo26l-int8`,
 * now measured.
 *
 * `package` is not calibrated (7 objects in the set) and stays at its global
 * default. Every catalog model NOT listed here (the 256 builds, yolo26l float, yolo26x,
 * the seg builds, the fp16 legacy IRs) is untuned and runs at the global
 * defaults.
 */
const OBJECT_DETECTION_CLASS_FLOORS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'ssd-mobilenet-v2-coco-edgetpu': { person: 0.6, vehicle: 0.35, animal: 0.4 },
  yolo26m: { person: 0.4, vehicle: 0.25, animal: 0.3 },
  'yolo26m-320': { person: 0.7, vehicle: 0.3, animal: 0.4 },
  'yolo26m-320-int8': { person: 0.6, vehicle: 0.4, animal: 0.3 },
  'yolo26l-int8': { person: 0.5, vehicle: 0.4, animal: 0.4 },
  'yolo26m-int8': { person: 0.4, vehicle: 0.35, animal: 0.45 },
  yolo26n: { person: 0.65, vehicle: 0.4, animal: 0.5 },
  'yolo26n-320': { person: 0.6, vehicle: 0.6, animal: 0.4 },
  'yolo26n-320-int8': { person: 0.45, vehicle: 0.55, animal: 0.35 },
  'yolo26n-int8': { person: 0.55, vehicle: 0.3, animal: 0.4 },
  yolo26s: { person: 0.4, vehicle: 0.45, animal: 0.4 },
  'yolo26s-320': { person: 0.6, vehicle: 0.45, animal: 0.45 },
  'yolo26s-320-int8': { person: 0.5, vehicle: 0.55, animal: 0.45 },
  'yolo26s-int8': { person: 0.4, vehicle: 0.3, animal: 0.4 },
  'yolov9c-320': { person: 0.7, vehicle: 0.45, animal: 0.45 },
  'yolov9c-320-int8': { person: 0.7, vehicle: 0.5, animal: 0.25 },
  'yolov9c-640': { person: 0.55, vehicle: 0.45, animal: 0.3 },
  'yolov9c-640-int8': { person: 0.45, vehicle: 0.4, animal: 0.3 },
  // vehicle 0.5 (measured 0.75, which hinges on one high-score FP)
  'yolov9m-320': { person: 0.7, vehicle: 0.5, animal: 0.55 },
  'yolov9m-320-int8': { person: 0.65, vehicle: 0.4, animal: 0.35 },
  'yolov9m-640': { person: 0.6, vehicle: 0.4, animal: 0.55 },
  'yolov9m-640-int8': { person: 0.55, vehicle: 0.4, animal: 0.7 },
  'yolov9s-320': { person: 0.7, vehicle: 0.55, animal: 0.4 },
  // vehicle 0.45 (measured 0.7, which hinges on one high-score FP)
  'yolov9s-320-int8': { person: 0.7, vehicle: 0.45, animal: 0.4 },
  'yolov9s-640': { person: 0.7, vehicle: 0.4, animal: 0.6 },
  'yolov9s-640-int8': { person: 0.5, vehicle: 0.3, animal: 0.6 },
  'yolov9t-320': { person: 0.55, vehicle: 0.45, animal: 0.3 },
  'yolov9t-320-int8': { person: 0.55, vehicle: 0.4, animal: 0.3 },
  'yolov9t-640': { person: 0.65, vehicle: 0.5, animal: 0.5 },
  'yolov9t-640-int8': { person: 0.6, vehicle: 0.55, animal: 0.55 },
  // The Coral YOLOv9-s builds (D908). NOT in model-floors.json: taken from
  // `docs/benchmarks/2026-10-22-coral-pcie-amd-phoenix.md` (91 operator frames,
  // true-positive median score 0.48-0.61 against 0.63-0.83 for the other
  // YOLOs; the benchmark recommends 0.3-0.4). The global 0.65 person floor
  // halves their recall. Animal sits at the lowest median (0.48-0.49).
  'yolov9s-320-edgetpu': { person: 0.4, vehicle: 0.4, animal: 0.3 },
  'yolov9s-512-edgetpu': { person: 0.4, vehicle: 0.4, animal: 0.3 },
}

/**
 * The floor on the DETECTION score below which a root detector's own fine
 * label (a species, a vehicle type — the D736 root supply) is not taken (D741).
 * Keyed by root model, then by the supplied step. Below it the detection keeps
 * its macro class with no fine label; it is never dropped. A floor of 1 means
 * "never take this label from this root". A root or step absent here has no
 * extra floor — the macro floor alone gates the label, as before D741.
 *
 * Measured 2026-10-07 (`docs/benchmarks/classifier-floors.json`): the
 * lowest detection score from which the root's species was right ~90% of the
 * time, against a two-model zero-shot reference on 219 animal crops dominated
 * by one dog. Unlisted roots behave alike — ~0.89-0.90 at the macro floor for
 * 640 roots, ~0.74 for 320 roots. Vehicle types needed no extra floor on any
 * root (0.99-1.00 at the macro floor). The Coral SSD named the species wrongly
 * three times in four.
 */
const ROOT_SUPPLIED_LABEL_FLOORS: Readonly<Record<string, Readonly<Record<string, number>>>> = {
  'yolov9m-320-int8': { 'animal-classifier': 0.75 },
  'yolov9m-640-int8': { 'animal-classifier': 0.7 },
  'yolov9c-640-int8': { 'animal-classifier': 0.75 },
  yolo26s: { 'animal-classifier': 0.45 },
  yolo26m: { 'animal-classifier': 0.7 },
  'yolo26s-int8': { 'animal-classifier': 0.55 },
  'ssd-mobilenet-v2-coco-edgetpu': { 'animal-classifier': 1 },
}

/** Stamp each entry's row of `floors` on it as `suppliedLabelFloors`. Fresh objects only. */
function withSuppliedLabelFloors(
  entries: readonly ModelCatalogEntry[],
  floors: Readonly<Record<string, Readonly<Record<string, number>>>>,
): readonly ModelCatalogEntry[] {
  return entries.map((entry) => {
    const row = floors[entry.id]
    return row === undefined ? entry : { ...entry, suppliedLabelFloors: { ...row } }
  })
}

/** Ids in {@link OBJECT_DETECTION_CLASS_FLOORS} — a test proves each names a catalog entry. */
export const OBJECT_DETECTION_CLASS_FLOOR_MODEL_IDS: readonly string[] = Object.keys(
  OBJECT_DETECTION_CLASS_FLOORS,
)

/** Stamp each entry's row of `floors` on it as `defaultClassFloors`. Fresh objects only. */
function withDefaultClassFloors(
  entries: readonly ModelCatalogEntry[],
  floors: Readonly<Record<string, Readonly<Record<string, number>>>>,
): readonly ModelCatalogEntry[] {
  return entries.map((entry) => {
    const row = floors[entry.id]
    return row === undefined ? entry : { ...entry, defaultClassFloors: { ...row } }
  })
}

/**
 * Object-detection IRs that need f32 inference on an Intel GPU
 * (`gpuInferencePrecision`). At the GPU's default f16 the YOLO26 FP32 IRs of
 * the larger tiers return no valid detection — measured 2026-10-07 on the Core
 * Ultra iGPU and the N100: `yolo26s` (640) 0 true / 146 false positives,
 * `yolo26m` and `yolo26m-320` NaN scores; at f32 they match the CPU, at ~60%
 * more GPU latency. `yolo26n`, `yolo26n-320` and `yolo26s-320` were measured
 * correct at f16 and are NOT listed. The rest of the list is the same pattern
 * not yet measured (tier m / l / x at any input, tier s at 640, the seg builds
 * of those tiers): f32 costs latency, f16 risks a detector that silently finds
 * nothing. INT8 IRs and every YOLOv9 IR are correct at the device default.
 */
const OPENVINO_GPU_F32_MODEL_IDS: ReadonlySet<string> = new Set([
  // measured
  'yolo26s',
  'yolo26m',
  'yolo26m-320',
  // same tiers, not measured
  'yolo26m-256',
  'yolo26l',
  'yolo26l-320',
  'yolo26l-256',
  'yolo26x',
  'yolo26s-seg',
  'yolo26m-seg',
])

/** Stamp `gpuInferencePrecision: 'f32'` on the listed entries. Fresh objects only. */
function withGpuF32(
  entries: readonly ModelCatalogEntry[],
  ids: ReadonlySet<string>,
): readonly ModelCatalogEntry[] {
  return entries.map((entry) =>
    ids.has(entry.id) ? { ...entry, gpuInferencePrecision: 'f32' as const } : entry,
  )
}

/** Ids in {@link OPENVINO_GPU_F32_MODEL_IDS} — a test proves each names a catalog entry. */
export const OPENVINO_GPU_F32_MODEL_ID_LIST: readonly string[] = [...OPENVINO_GPU_F32_MODEL_IDS]

export const OBJECT_DETECTION_MODELS: readonly ModelCatalogEntry[] = withSuppliedLabelFloors(
  withGpuF32(
    withDefaultClassFloors(OBJECT_DETECTION_MODEL_ENTRIES, OBJECT_DETECTION_CLASS_FLOORS),
    OPENVINO_GPU_F32_MODEL_IDS,
  ),
  ROOT_SUPPLIED_LABEL_FLOORS,
)

// ---------------------------------------------------------------------------
// Face Detection — YuNet
// ---------------------------------------------------------------------------

export const FACE_DETECTION_MODELS: readonly ModelCatalogEntry[] = [
  {
    // The licence-clean face detector (D645): OpenCV Zoo's YuNet, weights MIT.
    // The only face-detection entry (SCRFD, whose InsightFace weights are
    // non-commercial, left the catalog). Measured on 204 COCO faces (2026-09-26
    // spike): 196 found, the same as fixed SCRFD, at 6-7 ms vs 33 ms; its 5 landmarks come out in the
    // order `face-align.ts` expects, so the aligned crop needs no change.
    id: 'yunet-2023mar',
    license: YUNET_MIT,
    name: 'YuNet 2023mar',
    description:
      'YuNet (OpenCV Zoo, 2023mar) — tiny face detector with 5 keypoints, MIT weights (WIDER FACE AP 0.884/0.866/0.750). ~0.2 MB. Trained on WIDER FACE (CC BY-NC-ND images).',
    inputSize: { width: 640, height: 640 },
    labels: [{ id: 'face', name: 'Face' }],
    preprocessMode: 'letterbox',
    // Anchor-free, one prior per cell, `sqrt(cls·obj)` scores — the step's
    // `scrfd` decoder finds 0 faces on this graph. See `python/postprocessors/yunet.py`.
    postprocessor: 'yunet',
    // D662: its OWN floor, not the step's SCRFD-calibrated 0.5. Measured on the
    // 1074 faces the hub buffered 2026-09-27 08:00–15:35Z (70 crops per band,
    // judged by eye): junk ~85% at 0.50–0.67, ~70% at 0.67–0.78, ~35% at
    // 0.78–0.84, ~15% at 0.84–0.87, ~10% at 0.87–0.89, ~5% ≥ 0.89. 0.85 keeps
    // the bands where most crops are faces; every auto-recognition that day
    // already scored ≥ 0.85. D645 measured recall (196/204 COCO faces) and
    // never false positives on person crops — which is how 0.5 shipped.
    //
    // 0.70 since D741: re-measured 2026-10-07 on native crops of 131 person
    // tracks against an SCRFD-10G + RetinaFace-R50 reference, with the
    // face-inside-its-person guard in place: precision 1.0 / recall 0.83 at
    // 0.70, against recall 0.53 at 0.85 (0.85 dropped ~40% of clear frontal
    // faces); below 0.65 false faces return (back of a head, pillows, leaves).
    // The 0.85 stays where it was earning its keep — the face EMBEDDING
    // (`face-embedding` `defaultMinParentScore`), so the gallery and the
    // matcher see exactly the faces they saw before.
    defaultConfidence: 0.7,
    // NO `inputNormalization`, deliberately. Upstream wants BGR 0..255; the
    // pool's plain RGB `/255` is turned into that by `Mul(255)` +
    // `Gather([2,1,0])` BAKED into all three published graphs
    // (`scripts/build-yunet-model.py`), so every backend — ONNX, the OpenVINO
    // PPP fold, the CoreML multiArray path — applies the contract exactly once.
    // A pool normalisation here would apply it twice.
    //
    // Licence: weights MIT ("Copyright (c) 2020 Shiqi Yu", opencv_zoo
    // models/face_detection_yunet/LICENSE), training code BSD-3-Clause
    // (ShiqiYu/libfacedetection.train). Training data is WIDER FACE, whose
    // images are CC BY-NC-ND — the caveat every public face detector carries,
    // SCRFD included. The HF folder carries the model card with the MIT text.
    formats: {
      onnx: {
        url: hf('faceDetection/yunet/onnx/camstack-yunet-2023mar.onnx'),
        sizeMB: 0.23,
      },
      coreml: {
        url: hf('faceDetection/yunet/coreml/camstack-yunet-2023mar.mlpackage'),
        sizeMB: 0.2,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('faceDetection/yunet/openvino/camstack-yunet-2023mar.xml'), 0.36),
      // The Coral build of THIS model (D710): the bake folded into the first
      // Conv (a Gather is no Edge TPU op), full-integer int8, uint8 input at
      // scale 1/255 — the raw pixels the edgetpu preprocess feeds ARE the
      // RGB [0,1] tensor, so the "no inputNormalization" contract holds. All
      // 81 ops on the TPU, 0.11 MiB of parameters; but at 640 its activations
      // leave the cache 3.34 MiB, so beside the root SSD it either swaps
      // (separately compiled) or makes the ROOT stream 2.93 MiB per frame
      // (co-compiled). Its place is a Coral that does not run the root
      // (D724): on a root Coral the node keeps face-detection jumping.
      // scripts/build-yunet-edgetpu.py.
      tflite: {
        url: hf('faceDetection/yunet/tflite/camstack-yunet-2023mar_edgetpu.tflite'),
        sizeMB: 0.7,
        runtimes: ['python'],
      },
    },
  },
] as const

// ---------------------------------------------------------------------------
// Face Embedding — AuraFace
// ---------------------------------------------------------------------------

export const FACE_EMBEDDING_MODELS: readonly ModelCatalogEntry[] = [
  {
    // The permissively-licensed recogniser: AuraFace v1 by fal.ai
    // (`fal/AuraFace-v1` on HF), an iResNet-100 trained with additive angular
    // margin (ArcFace) on commercially-usable data and released Apache-2.0 —
    // the answer to the old `arcface-r100`'s UNKNOWN terms AND to its half-depth
    // backbone (that entry has left the catalog). THE ONLY ONE, and the default since D651. `identity-samples` rows are matched
    // only against samples sharing the probe's `modelId`, so a switch is
    // followed by the re-embed pass (`face-reembed-pass.ts`), which moves every
    // sample with a stored template into this model's space.
    //
    // ONLY `glintr100.onnx` was taken from that repo. The other four files in
    // the pack (`scrfd_10g_bnkps`, `1k3d68`, `2d106det`, `genderage`) are
    // verbatim InsightFace weights under the non-commercial InsightFace terms,
    // whatever the repo-level Apache-2.0 tag says.
    id: 'auraface-r100',
    license: AURAFACE_APACHE,
    name: 'AuraFace R100',
    description:
      'AuraFace v1 (fal.ai) — iResNet-100 ArcFace face recognition embeddings (512-d), Apache-2.0. Benchmarks published by fal: LFW 99.65, CFP-FP 95.19, AgeDB 96.10, CALFW 94.70, CPLFW 90.93. Genuinely a ResNet-100 (65 M params) — roughly twice the depth of the former `arcface-r100` entry, which was a ResNet34.',
    inputSize: { width: 112, height: 112 },
    // NCHW: the upstream export is a PyTorch `[N,3,112,112]` graph (unlike the
    // tf2onnx `arcface-r100` once shipped here, which was NHWC).
    labels: [{ id: 'embedding', name: 'Face Embedding' }],
    preprocessMode: 'resize',
    faceAlignment: true,
    // Upstream expects `(x-127.5)/127.5` ([-1,1]); the pool feeds `/255`
    // ([0,1]) and has no enum for the difference. Unlike the former `arcface-r100` — whose
    // BatchNorms absorb the affine shift — this graph CANNOT: its first op is a
    // Conv and its first BatchNorm sits after a PReLU, so nothing soaks up the
    // offset (measured: cosine 0.70–0.77 against the correctly-fed embedding —
    // i.e. a broken recogniser). So `y = 2x - 1` is BAKED INTO THE GRAPH as a
    // `Mul`/`Sub` pair ahead of the first Conv, identically in all three
    // formats: the published artefacts consume the pool's `/255` tensor
    // directly and reproduce upstream bit-for-bit (cosine 1.000000, max abs
    // diff 0.0). Never re-publish these from the raw `glintr100.onnx` without
    // re-applying it — `scripts/build-auraface-model.py` is the whole
    // download → bake → convert → cross-engine-verify pass.
    formats: {
      onnx: {
        url: hf('faceRecognition/auraface/onnx/camstack-auraface-r100.onnx'),
        sizeMB: 261,
      },
      coreml: {
        url: hf('faceRecognition/auraface/coreml/camstack-auraface-r100.mlpackage'),
        sizeMB: 131,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('faceRecognition/auraface/openvino/camstack-auraface-r100.xml'), 131),
    },
  },
] as const

// ---------------------------------------------------------------------------
// Plate Detection — open-lpr YOLOX-tiny (the step's only model, D719)
// ---------------------------------------------------------------------------
//
// `tflite` is the Coral build of the same model (D710 addendum): the Focus stem
// rewritten as the equivalent 6x6/s2 Conv, which compiles (274/274 ops on the
// TPU). Beside the root SSD it is loaded from the co-compiled set
// `root-plate-bird` (D724), where the root keeps its whole cache.

export const PLATE_DETECTION_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'yolox-tiny-plate',
    // open-lpr's `plate_yolox_tiny_640.onnx` (tag detector-2026.10.1), with the
    // pool's RGB /255 input and the YOLOv8 output layout baked into the graph,
    // so the shipped `yolo` postprocessor decodes it unchanged. Recipe, pinned
    // hashes and the cross-runtime check: scripts/build-yolox-plate-model.py.
    license: OPEN_LPR_YOLOX_APACHE,
    name: 'YOLOX-tiny — License Plate',
    description: 'YOLOX-tiny licence-plate detector trained by the open-lpr project (Apache-2.0)',
    inputSize: { width: 640, height: 640 },
    labels: [{ id: 'plate', name: 'License Plate' }],
    preprocessMode: 'letterbox',
    postprocessor: 'yolo',
    formats: {
      onnx: {
        url: hf('plateDetection/yolox-tiny-plate/onnx/camstack-yolox-tiny-plate.onnx'),
        sizeMB: 19.3,
      },
      coreml: {
        url: hf('plateDetection/yolox-tiny-plate/coreml/camstack-yolox-tiny-plate.mlpackage'),
        sizeMB: 9.8,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(
        hf('plateDetection/yolox-tiny-plate/openvino/camstack-yolox-tiny-plate.xml'),
        10,
      ),
      // The Coral build of THIS model (D710): Focus -> one 6x6/s2 Conv (the
      // strided Slices were what edgetpu_compiler refused), the bake folded
      // into it, and the graph cut before YOLOX's grid decode — it emits the
      // raw head (`reg_s`, `score_s`), which `yolo.py` decodes by name. Full
      // integer int8, uint8 input at 1/255. All 274 ops on the TPU, 5.55 MiB
      // of parameters alone. scripts/build-yolox-plate-edgetpu.py.
      tflite: {
        url: hf('plateDetection/yolox-tiny-plate/tflite/camstack-yolox-tiny-plate_edgetpu.tflite'),
        sizeMB: 6.9,
        runtimes: ['python'],
      },
    },
  },
] as const

// ---------------------------------------------------------------------------
// Package Detection — custom parcel detectors (dedicated, not the COCO proxy)
// ---------------------------------------------------------------------------
//
// The `package-detection` step's models. Both emit a single `package` class,
// so the downstream drop detector (`PackageDropDetector`) is model-agnostic —
// it gates on `className ∈ ['package']` regardless of which model produced it.
//
// - `rfdetr-package` (DEFAULT, operator decision 2026-08-07 — supersedes the
//   2026-07-17 yolov8n decision): RF-DETR, all three runtime formats. A
//   DETR-style detector — square resize + ImageNet norm, output
//   `dets[cxcywh, normalized]` + per-query `labels` logits decoded via sigmoid
//   (class idx 1 = package; idx 0 is the DEAD no-object slot) by the `rfdetr`
//   postprocessor, which shipped 2026-08-07 with the coreml build. Chosen for
//   SEPARATION, not speed: on 101 it scores parcel 0.93 / doormat 0.07
//   (margin +0.86) where yolov8n manages +0.21 / +0.03 — the difference
//   between a usable zone gate and a coin flip. It costs 4× the download and
//   ~6× the latency (hub NPU 95.7 ms, N100 iGPU 367 ms, Mac ANE 29.5 ms with
//   98.8% of ops on the ANE), which the package step can afford: it is
//   opt-in per camera, zone-cropped, and not on the per-frame root plane.
// - `yolov8n-package` (the cheap alternative) was removed from the catalog:
//   `rfdetr-package` is the only entry.
//
// The one GAP is `tflite` / edgetpu: neither entry ships a tflite build, and
// for rfdetr that is STRUCTURAL — a DETR decoder head does not compile to the
// Edge TPU's integer op set. An edgetpu-format node therefore has no package
// model at all (unchanged by this decision, which is why it did not block it).
export const PACKAGE_DETECTION_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'rfdetr-package',
    license: RFDETR_APACHE,
    // NOT legacy — `legacy` gates SELECTABILITY (`getModelCatalog` and
    // `buildSchemaSlots` both drop legacy entries), so while it was set this
    // model could not be chosen at all, let alone defaulted to. It is now the
    // step's `defaultModelId` (see STEP_PACKAGE_DETECTION).
    //
    // `preprocessMode: 'resize'` (square resize to 576×576) +
    // `inputNormalization: 'imagenet'` match its export and are both already
    // implemented in the pool preprocess.
    name: 'RF-DETR — Package',
    description:
      'RF-DETR parcel detector — DETR-style decode (onnx / coreml / openvino). Separates parcel from doormat far better than the former yolov8n-package (+0.86 vs +0.21 margin on 101) at ~4× the size and ~6× the latency',
    inputSize: { width: 576, height: 576 },
    labels: [{ id: 'package', name: 'Package' }],
    preprocessMode: 'resize',
    inputNormalization: 'imagenet',
    // Per-MODEL override: the step's own postprocessor is `yolo`; this entry
    // carries the DETR decode.
    postprocessor: 'rfdetr',
    // sizeMB is the download-progress DENOMINATOR (`startDownload` derives
    // totalBytes from it), so these are the real on-HF byte counts, not
    // estimates: onnx 120_607_816 B, openvino .bin 60_121_102 B + .xml,
    // coreml bundle 60_455_929 B. The previous 30s drove the bar to ~380%.
    formats: {
      onnx: {
        url: hf('packageDetection/rfdetr-package/onnx/camstack-rfdetr-package.onnx'),
        sizeMB: 115,
      },
      coreml: {
        url: hf('packageDetection/rfdetr-package/coreml/camstack-rfdetr-package.mlpackage'),
        sizeMB: 58,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(
        hf('packageDetection/rfdetr-package/openvino/camstack-rfdetr-package.xml'),
        58,
      ),
    },
  },
] as const

// ---------------------------------------------------------------------------
// Plate OCR — a plate READER (the only entry; the generic text recognizer it replaced left the catalog)
// ---------------------------------------------------------------------------
//
// `cct-s-v2-global` is the default since 2026-08-20. It is a plate recognizer,
// not a text recognizer, and on the cam-102 ground-truth set (21 plates / 9
// vehicles / 18 junk ROIs, `scratchpad/plate-audit/102`) that is worth:
//
//   vgg_english_g2 + quad-warp   4/21 exact   char 42.9%   0 false   Kia 0/7
//   cct-s-v2-global + 15% margin 19/21 exact  char 90.5%   0 false   Kia 7/7
//
// "Kia" is the operator's own car, DN-RO 309, parked in the driveway at 180-290
// native px: the case that started this and that the generic reader got wrong on
// every single frame ("NOKO309" — it loses the D into the registration seal).
//
// Three things had to move together, and each is declared where it belongs:
//  - the DECODE is per-slot argmax, not CTC → per-model `postprocessor`
//    ('plate-slots', `python/postprocessors/plate_slots.py`);
//  - the PIXELS are the raw detector box plus a 15% margin, NOT the D198
//    quad-warped strip → `pipeline/plate-ocr-crop-policy.ts`;
//  - the GATE is a per-character confidence floor, because a fixed-slot reader
//    always emits a full-length string → `minCharProbability`, 0.75.
export const PLATE_OCR_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'cct-s-v2-global',
    license: FAST_PLATE_OCR_MIT,
    name: 'CCT-S v2 Global — License Plate',
    description:
      'fast-plate-ocr CCT-S v2 — a dedicated license-plate reader (66 regions incl. Germany). 19/21 exact on the cam-102 ground-truth set vs 4/21 for the generic VGG text recognizer, with zero false reads on 18 junk ROIs',
    // 128x64 RGB, stretched WITHOUT preserving aspect — that is how the model was
    // trained (on detector boxes around tilted plates), so `preprocessMode: 'resize'`
    // is the correct mode and not a compromise.
    inputSize: { width: 128, height: 64 },
    // NHWC — the pool derives the layout from the model's declared input shape
    // (`_is_channels_last`), exactly like ArcFace/CLIP.
    inputLayout: 'nhwc',
    labels: [{ id: 'text', name: 'Plate Text' }],
    preprocessMode: 'resize',
    // Per-MODEL: the step's own postprocessor is `ctc` (what the former vgg-english-g2
    // needed); this entry carries the fixed-slot decode.
    postprocessor: 'plate-slots',
    // The upstream project (github.com/ankandrew/fast-plate-ocr) is MIT and the
    // ONNX is published as that same repo's release asset, so MIT is the licence
    // that actually covers these weights — but say the rest out loud: there is
    // no model card and no separate weights grant, and the maintainer states the
    // v2 training corpus is a private dataset he will not release, so the DATA
    // provenance is unauditable. Our artefacts are that ONNX with its uint8
    // rescale head removed (see `scripts/build-plate-ocr-model.py`).
    formats: {
      onnx: {
        url: hf('plateRecognition/cct-s-v2-global/onnx/camstack-cct-s-v2-global.onnx'),
        sizeMB: 5.3,
      },
      coreml: {
        url: hf('plateRecognition/cct-s-v2-global/coreml/camstack-cct-s-v2-global.mlpackage'),
        sizeMB: 5.1,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      // fp32, unlike every other IR here. A recognizer's answer is an argmax
      // plus a confidence THRESHOLD, and fp16 WEIGHTS on top of OpenVINO's
      // already-fp16 default inference precision is error this model cannot
      // absorb — measured, it moved a marginal crop's weakest character by 0.16
      // and silenced a ground-truthed plate. The saving would have been 2.5 MB.
      openvino: ovFormat(
        hf('plateRecognition/cct-s-v2-global/openvino/camstack-cct-s-v2-global.xml'),
        5.0,
      ),
    },
  },
] as const

// ---------------------------------------------------------------------------
// Animal Classifier — EfficientNet-Lite0 (animals-10 retired, D661)
// ---------------------------------------------------------------------------

export const ANIMAL_CLASSIFIER_MODELS: readonly ModelCatalogEntry[] = [
  {
    // PRIMARY (2026-07-19): EfficientNet-Lite0 fine-tuned on the Open Images V7
    // animal subset (CC-BY images + Apache-2.0 timm backbone ⇒ publicly
    // distributable, val 89.25%). Replaced the `animals-10` ViT of unidentified
    // origin, retired from the catalog (D661).
    // 8 coarse classes; labels ride the model's `-labels.json` (logit order).
    id: 'animal-classifier',
    license: ANIMAL_CLASSIFIER_APACHE,
    name: 'Animal Classifier (8)',
    description:
      'EfficientNet-Lite0 animal classifier — bird, cat, cow, deer, dog, horse, sheep, squirrel (Open Images V7, publicly distributable). Unreliable on home cameras: it has no reject class, so it names a species for anything it is given, and calls light curly-coated dogs sheep or cat at high confidence. Prefer a root detector that names animals itself.',
    // D741, measured 2026-10-07 on 219 native animal-track crops: precision
    // 0.54 at 0.5 and at most ~0.71 at any floor; 0.80 is the least-bad floor
    // (precision 0.68, recall 0.20). No floor makes it reliable.
    defaultConfidence: 0.8,
    inputSize: { width: 224, height: 224 },
    inputLayout: 'nchw',
    inputNormalization: 'imagenet',
    labels: [{ id: 'animal-type', name: 'Animal Type' }],
    preprocessMode: 'resize',
    formats: {
      onnx: {
        url: hf('animalClassification/animal-classifier/onnx/animal-classifier.onnx'),
        sizeMB: 13,
      },
      coreml: {
        url: hf('animalClassification/animal-classifier/coreml/animal-classifier.mlpackage'),
        sizeMB: 6.5,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(
        hf('animalClassification/animal-classifier/openvino/animal-classifier.xml'),
        6.9,
      ),
    },
    extraFiles: [
      {
        url: hf('animalClassification/animal-classifier/onnx/animal-classifier-labels.json'),
        filename: 'animal-classifier-labels.json',
        sizeMB: 0.01,
      },
    ],
  },
] as const

// ---------------------------------------------------------------------------
// Bird Classifier — Google AIY Birds V1 (bird-nabirds-404 retired, D661)
// ---------------------------------------------------------------------------

export const BIRD_CLASSIFIER_MODELS: readonly ModelCatalogEntry[] = [
  {
    // PRIMARY (2026-07-19): Google AIY Vision Birds V1 (MobileNetV2, Apache-2.0).
    // 965 outputs; index 964 = `background` (rejected downstream). THE TRAP:
    // this model diverges from every other classifier on all three axes —
    //   • layout  NHWC  (not NCHW)               → `inputLayout: 'nhwc'`
    //   • norm    /255 only, NO imagenet mean/std → `inputNormalization: 'none'`
    //   • output  softmax ALREADY applied in-graph→ `outputProbabilities: true`
    // Wiring it like the imagenet-NCHW-logits animal/vehicle models produces
    // garbage (double-softmax craters every score). Labels ride `-labels.json`.
    //
    // `tflite` is the Coral build of THIS model (D710): Google's full-integer
    // quant of the same graph, compiled by `scripts/build-bird-classifier-edgetpu.py`.
    // The edgetpu path feeds raw uint8 (the [-1,1] scale is in the graph) and
    // dequantises the uint8 softmax (`edgetpu_dequant`), so the three fields
    // above hold for it too. All 65 ops map to the TPU; 3.75 MiB of parameter
    // cache — it does NOT fit beside the root SSD (6.39 MiB), so on a Coral it
    // swaps against the root detector. Adding the build makes the step run ON
    // the Coral for a Coral-elected camera (`resolveStepDevice` → no-jump);
    // a node that should keep it off sets the step's `jumpDeviceKey`.
    id: 'bird-classifier',
    license: AIY_BIRDS_APACHE,
    name: 'Bird Classifier (AIY 965)',
    description:
      'Google AIY Birds V1 (MobileNetV2) — 964 species + background; publicly distributable (Apache-2.0)',
    inputSize: { width: 224, height: 224 },
    inputLayout: 'nhwc',
    inputNormalization: 'none',
    outputProbabilities: true,
    labels: [{ id: 'species', name: 'Bird Species' }],
    preprocessMode: 'resize',
    formats: {
      onnx: {
        url: hf('animalClassification/bird-classifier/onnx/bird-classifier.onnx'),
        sizeMB: 14,
      },
      coreml: {
        url: hf('animalClassification/bird-classifier/coreml/bird-classifier.mlpackage'),
        sizeMB: 6.8,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(
        hf('animalClassification/bird-classifier/openvino/bird-classifier.xml'),
        14,
      ),
      tflite: {
        url: hf('animalClassification/bird-classifier/tflite/bird-classifier_edgetpu.tflite'),
        sizeMB: 3.9,
        runtimes: ['python'],
      },
    },
    extraFiles: [
      {
        url: hf('animalClassification/bird-classifier/onnx/bird-classifier-labels.json'),
        filename: 'bird-classifier-labels.json',
        sizeMB: 0.03,
      },
    ],
  },
] as const

// ---------------------------------------------------------------------------
// Vehicle Classifier — MobileNetV3 (vehicle-type-efficientnet retired, D661)
// ---------------------------------------------------------------------------

export const VEHICLE_CLASSIFIER_MODELS: readonly ModelCatalogEntry[] = [
  {
    // PRIMARY (2026-07-19): MobileNetV3-Large, val 89.4%. 8 coarse road-vehicle
    // types (Ambulance, Bicycle, Bus, Car, Motorcycle, Taxi, Truck, Van).
    // NCHW 224, imagenet norm, raw logits. Replaces the 135 MB EfficientNet-B4.
    id: 'vehicle-type-v1',
    license: VEHICLE_TYPE_V1_NC,
    name: 'Vehicle Type (8)',
    description:
      'MobileNetV3-Large vehicle type classifier — Ambulance, Bicycle, Bus, Car, Motorcycle, Taxi, Truck, Van (val 89.4%)',
    // D741, measured 2026-10-07 on 233 native vehicle-track crops: precision
    // crosses 0.90 at 0.60 (0.912, recall 0.846; 0.877 / 0.877 at 0.50).
    defaultConfidence: 0.6,
    inputSize: { width: 224, height: 224 },
    inputLayout: 'nchw',
    inputNormalization: 'imagenet',
    labels: [{ id: 'vehicle-type', name: 'Vehicle Type' }],
    preprocessMode: 'resize',
    formats: {
      onnx: {
        url: hf('vehicleClassification/vehicle-type-v1/onnx/vehicle-type-v1.onnx'),
        sizeMB: 17,
      },
      coreml: {
        url: hf('vehicleClassification/vehicle-type-v1/coreml/vehicle-type-v1.mlpackage'),
        sizeMB: 8.1,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(
        hf('vehicleClassification/vehicle-type-v1/openvino/vehicle-type-v1.xml'),
        8.7,
      ),
    },
    extraFiles: [
      {
        url: hf('vehicleClassification/vehicle-type-v1/onnx/vehicle-type-v1-labels.json'),
        filename: 'vehicle-type-v1-labels.json',
        sizeMB: 0.01,
      },
    ],
  },
] as const

// ---------------------------------------------------------------------------
// Segmentation Refiner — U2-Net Portable
// ---------------------------------------------------------------------------

export const SEGMENTATION_REFINER_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'u2netp',
    license: U2NET_APACHE,
    name: 'U2-Net Portable',
    description: 'U2-Net-P — ultra-lightweight salient object segmentation (4.7 MB)',
    inputSize: { width: 320, height: 320 },
    labels: [{ id: 'mask', name: 'Segmentation Mask' }],
    preprocessMode: 'resize',
    formats: {
      onnx: {
        url: hf('segmentationRefiner/u2netp/onnx/camstack-u2netp.onnx'),
        sizeMB: 5,
      },
      coreml: {
        url: hf('segmentationRefiner/u2netp/coreml/camstack-u2netp.mlpackage'),
        sizeMB: 3,
        isDirectory: true,
        files: [...MLPACKAGE_FILES],
        runtimes: ['python'],
      },
      openvino: ovFormat(hf('segmentationRefiner/u2netp/openvino/camstack-u2netp.xml'), 2.5),
    },
  },
] as const

// ---------------------------------------------------------------------------
// Instance Segmentation — YOLO26-seg
// ---------------------------------------------------------------------------

/**
 * The dormant `instance-segmentation` step's catalog: the YOLO26-seg entries of
 * {@link OBJECT_DETECTION_MODELS}, by reference. One entry per model (D703) —
 * the artifact lives once, in the root's catalog, where it can be selected as
 * the camera root and supply the `segmentation` step's masks (D737).
 */
export const INSTANCE_SEGMENTATION_MODELS: readonly ModelCatalogEntry[] =
  OBJECT_DETECTION_MODELS.filter((m) => m.group?.family === YOLO26_SEG_FAMILY)

// ---------------------------------------------------------------------------
// CLIP Embedding — SigLIP2 vision encoder (D649); MobileCLIP S1/S2 left the catalog
//
// NO onnx builds, deliberately. The int8-quantized ONNX vision exports were
// measured MISALIGNED with their text encoders on 2026-08-21: matched
// image↔text cosine ≈ 0.01 (S1/S2) where the fp16 openvino/coreml builds of
// the same checkpoints score ≈ 0.22, and the S1 onnx image space had collapsed
// (mean pairwise cosine 0.73 across unrelated crops). The hub's cpu/onnx
// fallback engine was writing those junk vectors straight into `object-clip`
// (~170/day, provable via junk-space probes — cross-space cosine caps at 0.15,
// live index matched the probe at 0.94). Withholding the format makes an
// onnx engine unable to serve the model, so the node-local engine fallback
// rescues clip-embedding onto openvino/coreml (D199 keeps the pinned id; the
// cluster rule forbids substitution). Re-adding onnx requires a new export
// whose image↔text alignment is verified BEFORE upload.
//
// ---------------------------------------------------------------------------

export const CLIP_EMBEDDING_MODELS: readonly ModelCatalogEntry[] = [
  // SigLIP2 B/16-224 (Google, Apache-2.0) — the licence-clean replacement for
  // MobileCLIP (D649), now the ONLY entry and the step default. 768-d, so its vectors live in
  // their own index (`object-clip-siglip2-b16-224`, declared by post-analysis
  // from the model's `clip` metadata); the 512-d `object-clip` is untouched.
  // `2x - 1` is baked into every format (scripts/build-siglip2-model.py), which
  // is why this entry declares `inputNormalization: 'none'` like MobileCLIP did.
  // No onnx here either: the fp32 ONNX on HF is the verification reference, and
  // the pool serves this step through openvino/coreml (D209).
  {
    id: 'siglip2-b16-224',
    license: SIGLIP2_APACHE,
    name: 'SigLIP2 B/16',
    description:
      'Google SigLIP2 base, patch 16, 224×224 — Apache-2.0 CLIP vision encoder, 768-dim (fp16 OpenVINO/CoreML)',
    inputSize: { width: 224, height: 224 },
    labels: [{ id: 'embedding', name: 'CLIP Embedding' }],
    preprocessMode: 'resize',
    inputNormalization: 'none',
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
] as const

// ---------------------------------------------------------------------------
// Audio Classifier — YAMNet (ONNX) + Apple SoundAnalysis (CoreML, zero download)
// ---------------------------------------------------------------------------

export const AUDIO_CLASSIFIER_MODELS: readonly ModelCatalogEntry[] = [
  {
    id: 'yamnet-onnx',
    license: YAMNET_APACHE,
    name: 'YAMNet',
    description:
      'Google YAMNet — 521-class audio event classifier (16 MB ONNX, runs on any platform)',
    inputSize: { width: 1, height: 16000 },
    labels: [],
    preprocessMode: 'resize',
    // The audio analyzer fetches the model and its labels through
    // `ensureModel` like every hosted artefact (`ensureYamnetFiles`), so the
    // labels are declared here rather than next to a hand-built URL.
    extraFiles: [
      {
        url: hf('audioClassification/yamnet/camstack-yamnet-labels.json'),
        filename: 'camstack-yamnet-labels.json',
        sizeMB: 0.01,
      },
    ],
    formats: {
      onnx: {
        url: hf('audioClassification/yamnet/onnx/camstack-yamnet.onnx'),
        sizeMB: 16.1,
      },
      openvino: ovFormat(hf('audioClassification/yamnet/openvino/camstack-yamnet.xml'), 8.2),
      // No `coreml` entry on purpose: the one that was here pointed at the
      // ONNX file, which `coremltools` cannot load — a label, not a model.
      // A Mac runs `apple-soundanalysis` for audio (the analyzer's darwin
      // default); a real CoreML YAMNet needs a conversion from the TF/Keras
      // source and an upload under `audioClassification/yamnet/coreml/`.
    },
  },
  {
    id: 'apple-soundanalysis',
    license: APPLE_SOUNDANALYSIS,
    name: 'Apple SoundAnalysis',
    description: 'macOS built-in — 303 sound categories, Neural Engine accelerated, zero download',
    inputSize: { width: 1, height: 16000 },
    labels: [],
    preprocessMode: 'resize',
    formats: {
      coreml: { url: '', sizeMB: 0 },
    },
  },
] as const
