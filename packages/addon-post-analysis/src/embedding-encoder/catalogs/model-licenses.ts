/**
 * Licence records for the CLIP encoders this addon downloads (D661). Addons
 * never import each other, so these duplicate the image-encoder records in
 * addon-pipeline's `registry/model-licenses.ts`;
 * `scripts/check-catalog-licence.ts` fails when two records naming the same
 * upstream disagree on the weights licence or its URL.
 */
import type { ModelLicense } from '@camstack/types'

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

export const SIGLIP2_TEXT_APACHE: ModelLicense = {
  ...SIGLIP2_APACHE,
  modifications:
    "input sliced to the model's 64 positions in the graph; ONNX weights FP16, OpenVINO IR and CoreML FP16; a Lowercase normalizer prepended to the Gemma tokenizer (scripts/build-siglip2-model.py)",
}
