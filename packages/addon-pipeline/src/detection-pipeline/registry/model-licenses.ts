/**
 * One licence record per UPSTREAM, referenced by every catalog entry built
 * from it (D661). Facts verified 2026-09-26 (spec
 * `docs/superpowers/specs/2026-09-26-model-license-compliance.md` §2, §6):
 * GitHub licence API / raw LICENSE files, HF card data, ONNX `metadata_props`.
 * A record states what the upstream publishes — never a guess: `UNKNOWN` is an
 * honest gap, an invented SPDX id is not.
 *
 * Addons never import each other, so the CLIP text encoders
 * (addon-post-analysis) and the LLM catalog (addon-ai) keep their own copies.
 * `scripts/check-catalog-licence.ts` fails when two records naming the same
 * upstream disagree on the weights licence or its URL.
 */
import type { ModelLicense } from '@camstack/types'

const COCO_DATA = {
  name: 'COCO 2017',
  terms: "annotations CC-BY-4.0; images under their Flickr owners' terms",
  url: 'https://cocodataset.org/#termsofuse',
} as const

const WIDER_FACE_DATA = {
  name: 'WIDER FACE',
  terms: 'research-oriented terms; images CC BY-NC-ND',
  url: 'http://shuoyang1213.me/WIDERFACE/',
} as const

export const ULTRALYTICS_AGPL: ModelLicense = {
  weights: 'AGPL-3.0',
  code: 'AGPL-3.0',
  data: COCO_DATA,
  upstream: {
    name: 'Ultralytics',
    url: 'https://github.com/ultralytics/ultralytics',
  },
  url: 'https://github.com/ultralytics/ultralytics/blob/main/LICENSE',
  attribution:
    '© Ultralytics, AGPL-3.0. Corresponding source: the upstream Ultralytics checkpoint and build-camstack-models.py (with convert_lib.py) published at https://huggingface.co/camstack/camstack-models/tree/main/source.',
  modifications: 'exported to ONNX, OpenVINO IR and CoreML (scripts/build-camstack-models.py)',
  hosting: 'camstack-hf',
}

export const ULTRALYTICS_YOLOV9_AGPL: ModelLicense = {
  ...ULTRALYTICS_AGPL,
  attribution:
    '© Ultralytics, AGPL-3.0 (Ultralytics YOLOv9 weights). YOLOv9 architecture: Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao, GPL-3.0 (https://github.com/WongKinYiu/yolov9). Corresponding source: the upstream Ultralytics checkpoint and build-camstack-models.py (with convert_lib.py) published at https://huggingface.co/camstack/camstack-models/tree/main/source.',
}

/**
 * YOLOv9-s fine-tuned to 17 COCO classes and compiled for the Coral by Dan
 * Brown (verified 2026-10-22 from the publisher's repository): the training
 * notebook clones WongKinYiu/yolov9 (GPL-3.0, licence API) and starts from its
 * `yolov9-s-converted.pt` release; the data is COCO 2017 filtered to 17
 * classes. The repository's LICENSE.md is MIT and covers the publisher's own
 * plugin and notebooks; no separate licence is stated for the release weights,
 * so the record carries the terms of the GPL-3.0 checkpoint they derive from.
 * CamStack does not alter or re-host the files: a node downloads them from the
 * publisher's GitHub release, pinned by sha256 (the format's `revision`).
 */
export const DBRO_YOLOV9_EDGETPU_GPL: ModelLicense = {
  weights: 'GPL-3.0',
  code: 'GPL-3.0',
  data: COCO_DATA,
  upstream: {
    name: 'YOLOv9-s EdgeTPU (Dan Brown)',
    url: 'https://github.com/dbro/frigate-detector-edgetpu-yolo9',
  },
  url: 'https://github.com/WongKinYiu/yolov9/blob/main/LICENSE.md',
  attribution:
    'YOLOv9-s EdgeTPU weights © 2025 Dan Brown (fine-tuned to 17 COCO classes, INT8, compiled for the Edge TPU; https://github.com/dbro/frigate-detector-edgetpu-yolo9, repository MIT). Derived from the YOLOv9 code and yolov9-s checkpoint of Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao, GPL-3.0 (https://github.com/WongKinYiu/yolov9). Corresponding source: the fine-tuning checkpoint (yolov9-s-relu6-best.pt), the fine-tuning and conversion notebooks and the publisher LICENSE, mirrored at https://huggingface.co/camstack/camstack-models/tree/main/source/yolov9-edgetpu-dbro.',
  modifications: 'none: the publisher release files are mirrored byte-identical',
  hosting: 'camstack-hf',
}

export const CORAL_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  upstream: {
    name: 'Google Coral test_data',
    url: 'https://github.com/google-coral/test_data',
  },
  url: 'https://github.com/google-coral/test_data/blob/master/LICENSE',
  attribution: 'Coral Edge TPU models and AIY Vision Birds V1 © Google LLC, Apache-2.0.',
  hosting: 'third-party',
}

/** The CamStack Coral COCO detector (SSD MobileNet V2). */
export const CORAL_COCO_APACHE: ModelLicense = {
  ...CORAL_APACHE,
  data: COCO_DATA,
}

export const RFDETR_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: { name: 'parcel fine-tuning set (not recorded)', terms: 'UNVERIFIED' },
  upstream: {
    name: 'Roboflow RF-DETR',
    url: 'https://github.com/roboflow/rf-detr',
  },
  url: 'https://github.com/roboflow/rf-detr/blob/develop/LICENSE',
  attribution: 'RF-DETR © Roboflow, Apache-2.0.',
  modifications:
    'RF-DETR-M fine-tuned to 2 classes at 576; exported to ONNX, OpenVINO IR and CoreML; training checkpoint .pth also published',
  hosting: 'camstack-hf',
}

export const YUNET_MIT: ModelLicense = {
  weights: 'MIT',
  code: 'BSD-3-Clause',
  data: WIDER_FACE_DATA,
  upstream: {
    name: 'OpenCV Zoo YuNet',
    url: 'https://github.com/opencv/opencv_zoo/tree/main/models/face_detection_yunet',
  },
  url: 'https://github.com/opencv/opencv_zoo/blob/main/models/face_detection_yunet/LICENSE',
  attribution:
    'YuNet weights Copyright (c) 2020 Shiqi Yu, MIT. Training code: ShiqiYu/libfacedetection.train, BSD-3-Clause.',
  modifications:
    'input contract baked into the graph (the pool RGB /255 becomes the upstream BGR 0..255: Mul(255) plus a channel Gather); internal tensor names cleared in the OpenVINO IR; ONNX fp32, OpenVINO IR fp32, CoreML fp16 (scripts/build-yunet-model.py); Edge TPU build: the bake folded into the first Conv, full-integer int8 post-training quantisation calibrated on CamStack person crops, compiled with edgetpu_compiler 14 (scripts/build-yunet-edgetpu.py)',
  hosting: 'camstack-hf',
}

export const AURAFACE_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  upstream: {
    name: 'fal.ai AuraFace v1 (glintr100.onnx only)',
    url: 'https://huggingface.co/fal/AuraFace-v1',
  },
  url: 'https://huggingface.co/fal/AuraFace-v1',
  attribution: 'AuraFace v1 by fal.ai, Apache-2.0.',
  modifications:
    'input scaling y = 2x - 1 baked ahead of the first Conv (scripts/build-auraface-model.py); converted to OpenVINO IR and CoreML FP16',
  hosting: 'camstack-hf',
}

/**
 * open-lpr's YOLOX-tiny plate detector (D719). Weights Apache-2.0 by the
 * open-lpr repository licence and NOTICE (YOLOX code and its same-repository
 * COCO weights are Apache-2.0; no Ultralytics weights used) — the weights'
 * status is inferred from that statement, not from a per-file licence. The
 * NOTICE travels verbatim (Apache-2.0 §4(d)): licenses/models/NOTICE-open-lpr.txt
 * and the mirror folder's own NOTICE.
 */
export const OPEN_LPR_YOLOX_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: {
    name: 'Simanno annotated plate corpus plus community-contributed photographs, pseudo-labelled by a teacher model (not published; the upstream NOTICE says the photographs were uploaded without consent obtained)',
    terms: 'UNKNOWN',
  },
  upstream: {
    name: 'open-lpr models (faisalthaheem/open-lpr-models), YOLOX-tiny',
    url: 'https://huggingface.co/faisalthaheem/open-lpr-models',
  },
  url: 'https://huggingface.co/faisalthaheem/open-lpr-models/blob/aed0df35ec2891c5a90437041ebeadb592cc516b/LICENSE',
  attribution:
    'open-lpr models, Copyright the open-lpr contributors, Apache-2.0 (https://huggingface.co/faisalthaheem/open-lpr-models, tag detector-2026.10.1). YOLOX architecture and COCO pretraining by Megvii (https://github.com/Megvii-BaseDetection/YOLOX), Apache-2.0. The upstream NOTICE is reproduced verbatim (`NOTICE-open-lpr.txt`).',
  modifications:
    'input contract baked into the graph (static 1x3x640x640 RGB /255 becomes the upstream BGR 0..255: Mul(255) plus a channel Gather) and the output reshaped to the YOLOv8 layout (cx, cy, w, h, obj*cls); ONNX fp32, OpenVINO IR fp16, CoreML fp16 (scripts/build-yolox-plate-model.py); Edge TPU build: the Focus stem rewritten as the equivalent 6x6 stride-2 Conv with the input bake folded into it, the graph cut before the grid decode (raw per-stride head), full-integer int8 post-training quantisation calibrated on CamStack vehicle crops, compiled with edgetpu_compiler 14 (scripts/build-yolox-plate-edgetpu.py)',
  hosting: 'camstack-hf',
}

export const FAST_PLATE_OCR_MIT: ModelLicense = {
  weights: 'MIT',
  code: 'MIT',
  data: {
    name: 'fast-plate-ocr training set',
    terms: 'private, not released upstream',
  },
  upstream: {
    name: 'ankandrew/fast-plate-ocr',
    url: 'https://github.com/ankandrew/fast-plate-ocr',
  },
  url: 'https://github.com/ankandrew/fast-plate-ocr/blob/master/LICENSE',
  attribution:
    'fast-plate-ocr, MIT License, copyright (c) 2024 ankandrew (full notice: licenses/models/MIT-fast-plate-ocr.txt).',
  modifications:
    'input head removed (recorded in the ONNX doc_string); converted to OpenVINO IR and CoreML',
  hosting: 'camstack-hf',
}

const OPEN_IMAGES_DATA = {
  name: 'Open Images V7',
  terms: 'annotations CC-BY-4.0 (Google LLC); images listed as CC-BY-2.0, no warranty',
  url: 'https://storage.googleapis.com/openimages/web/factsfigures_v7.html',
} as const

export const ANIMAL_CLASSIFIER_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: OPEN_IMAGES_DATA,
  upstream: {
    name: 'timm EfficientNet-Lite0, fine-tuned by CamStack',
    url: 'https://github.com/huggingface/pytorch-image-models',
  },
  url: 'https://github.com/huggingface/pytorch-image-models/blob/main/LICENSE',
  attribution:
    'EfficientNet-Lite0 via timm (Ross Wightman), Apache-2.0. Open Images V7 annotations © Google LLC, CC BY 4.0; images listed by Google as CC BY 2.0, without warranty.',
  modifications:
    'fine-tuned by CamStack on the Open Images V7 animal subset (8 classes); exported to ONNX, OpenVINO IR and CoreML',
  hosting: 'camstack-hf',
}

export const AIY_BIRDS_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  upstream: {
    name: 'Google AIY Vision birds_V1',
    url: 'https://github.com/google-coral/test_data',
  },
  url: 'https://github.com/google-coral/test_data/blob/master/LICENSE',
  attribution: 'Coral Edge TPU models and AIY Vision Birds V1 © Google LLC, Apache-2.0.',
  modifications:
    'converted from TensorFlow with tf2onnx; OpenVINO IR and CoreML derived from it; the Edge TPU build is the Google full-integer quantised TFLite of the same model, compiled with edgetpu_compiler 14 (scripts/build-bird-classifier-edgetpu.py)',
  hosting: 'camstack-hf',
}

export const VEHICLE_TYPE_V1_NC: ModelLicense = {
  weights: 'CC-BY-NC-4.0',
  code: 'BSD-3-Clause',
  data: {
    name: 'DrBimmer/vehicle-classification',
    terms: 'CC-BY-NC-4.0 — treated as binding the trained weights (conservative reading)',
    url: 'https://huggingface.co/datasets/DrBimmer/vehicle-classification',
  },
  upstream: {
    name: 'torchvision MobileNetV3-Large, fine-tuned by CamStack',
    url: 'https://github.com/pytorch/vision',
  },
  url: 'https://creativecommons.org/licenses/by-nc/4.0/',
  attribution:
    'torchvision MobileNetV3, BSD-3-Clause. Trained on the Vehicle classification dataset by DrBimmer (https://huggingface.co/datasets/DrBimmer/vehicle-classification), CC BY-NC 4.0.',
  modifications: 'fine-tuned by CamStack (8 classes); exported to ONNX, OpenVINO IR and CoreML',
  hosting: 'camstack-hf',
  nonCommercial: true,
}

export const U2NET_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: { name: 'DUTS-TR', terms: 'not checked' },
  upstream: {
    name: 'xuebinqin/U-2-Net',
    url: 'https://github.com/xuebinqin/U-2-Net',
  },
  url: 'https://github.com/xuebinqin/U-2-Net/blob/master/LICENSE',
  attribution: 'U²-Net © Xuebin Qin et al., Apache-2.0.',
  modifications: 'converted to ONNX, OpenVINO IR and CoreML',
  hosting: 'camstack-hf',
}

export const SIGLIP2_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: { name: 'WebLI', terms: 'Google internal, not released' },
  upstream: {
    name: 'Google SigLIP 2 (google/siglip2-base-patch16-224)',
    url: 'https://huggingface.co/google/siglip2-base-patch16-224',
  },
  url: 'https://huggingface.co/google/siglip2-base-patch16-224',
  attribution: 'SigLIP 2 © Google LLC, Apache-2.0.',
  modifications:
    'input scaling y = 2x - 1 baked ahead of the patch embedding; converted to OpenVINO IR and CoreML FP16, an FP32 ONNX hosted as the verification reference (scripts/build-siglip2-model.py)',
  hosting: 'camstack-hf',
}

export const YAMNET_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: {
    name: 'AudioSet ontology/labels',
    terms: 'CC-BY-4.0 (Google LLC)',
    url: 'https://research.google.com/audioset/',
  },
  upstream: {
    name: 'tensorflow/models research/audioset/yamnet',
    url: 'https://github.com/tensorflow/models/tree/master/research/audioset/yamnet',
  },
  url: 'https://github.com/tensorflow/models/blob/master/LICENSE',
  attribution:
    'YAMNet © Google LLC, Apache-2.0. AudioSet ontology and labels © Google LLC, CC BY 4.0.',
  modifications: 'converted from TensorFlow with tf2onnx; OpenVINO IR derived from it',
  hosting: 'camstack-hf',
}

export const APPLE_SOUNDANALYSIS: ModelLicense = {
  weights: 'LicenseRef-Apple-macOS',
  upstream: {
    name: 'Apple SoundAnalysis (macOS built-in)',
    url: 'https://developer.apple.com/documentation/soundanalysis',
  },
  url: 'https://www.apple.com/legal/sla/',
  hosting: 'built-in',
}

/** Compose a per-entry record: same upstream, entry-specific modifications / data. */
export function licensed(base: ModelLicense, overrides: Partial<ModelLicense>): ModelLicense {
  return { ...base, ...overrides }
}
