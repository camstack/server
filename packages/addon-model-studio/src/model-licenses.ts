/**
 * Licence records for the catalogs Model Studio itself offers (D661): the
 * pinned plugin catalog YOLOv9 manifest and the plus catalog public catalog. Neither is
 * re-hosted by CamStack; a node downloads the file from the publisher.
 *
 * Addons never import each other, so these duplicate records in
 * addon-pipeline's `registry/model-licenses.ts` for the same upstream names;
 * `scripts/check-catalog-licence.ts` fails when two records naming the same
 * upstream disagree on the weights licence or its URL.
 */
import type { ModelLicense } from '@camstack/types'

/**
 * plugin catalog's YOLOv9 ReLU detectors. Checked 2026-09-27 on
 * `onnx/scrypted_yolov9t_relu/scrypted_yolov9t_relu.onnx` at the pinned
 * revision: no licence in the ONNX metadata, and the export's node traces name
 * `models.yolo.DetectionModel` / `models.common.Conv` from a `yolov9/` checkout
 * — WongKinYiu's YOLOv9 code (GPL-3.0), not Ultralytics. The repository's HF
 * card says `license: mit` at repository level; nothing states terms per model
 * or names the training data. So: code GPL-3.0, weights UNKNOWN.
 */
export const PLUGIN_CATALOG_YOLOV9_UNKNOWN: ModelLicense = {
  weights: 'UNKNOWN',
  code: 'GPL-3.0',
  data: { name: 'not stated by plugin catalog', terms: 'UNKNOWN' },
  upstream: {
    name: 'plugin catalog plugin-models (repository tagged MIT, no per-model terms)',
    url: 'https://huggingface.co/scrypted/plugin-models',
  },
  url: 'https://huggingface.co/scrypted/plugin-models',
  attribution:
    'plugin catalog YOLOv9 ReLU detectors, Koushik Dutta (scrypted/plugin-models, repository tagged MIT); trained with the YOLOv9 code of Chien-Yao Wang, I-Hau Yeh, Hong-Yuan Mark Liao, GPL-3.0 (https://github.com/WongKinYiu/yolov9).',
  modifications: 'none: downloaded as published, at a pinned revision',
  hosting: 'third-party',
}

/** plus catalog's default Coral model: Google's SSDLite MobileDet, Apache-2.0. */
export const CORAL_MOBILEDET_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  code: 'Apache-2.0',
  data: {
    name: 'COCO 2017',
    terms: "annotations CC-BY-4.0; images under their Flickr owners' terms",
    url: 'https://cocodataset.org/#termsofuse',
  },
  upstream: { name: 'Google Coral test_data', url: 'https://github.com/google-coral/test_data' },
  url: 'https://github.com/google-coral/test_data/blob/master/LICENSE',
  attribution: 'Coral Edge TPU models and AIY Vision Birds V1 © Google LLC, Apache-2.0.',
  hosting: 'third-party',
}
