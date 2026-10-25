/**
 * Licence records for the managed LLM catalog (D661). Facts verified
 * 2026-09-27 against each upstream's Hugging Face card (`cardData.license`)
 * and, for Qwen3.6, its `LICENSE` file (Apache-2.0). None of these weights is
 * re-hosted by CamStack: a node downloads the GGUF from the publisher named
 * in `upstream`.
 */
import type { ModelLicense } from '@camstack/types'

const QWEN_ATTRIBUTION = 'Qwen models © Alibaba Cloud, Apache-2.0.'

export const QWEN_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  upstream: { name: 'Qwen (Alibaba Cloud)', url: 'https://huggingface.co/Qwen' },
  url: 'https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF',
  attribution: QWEN_ATTRIBUTION,
  modifications: 'none (GGUF Q4_K_M published by Qwen; not re-hosted by CamStack)',
  hosting: 'third-party',
}

export const LLAMA_32_COMMUNITY: ModelLicense = {
  weights: 'LicenseRef-Llama-3.2-Community',
  upstream: {
    name: 'Meta Llama 3.2 (GGUF by bartowski)',
    url: 'https://huggingface.co/bartowski/Llama-3.2-3B-Instruct-GGUF',
  },
  url: 'https://github.com/meta-llama/llama-models/blob/main/models/llama3_2/LICENSE',
  attribution:
    'Built with Llama. Llama 3.2 is licensed under the Llama 3.2 Community License, Copyright © Meta Platforms, Inc. All Rights Reserved.',
  modifications: 'Q4_K_M GGUF quantisation by bartowski (not re-hosted by CamStack)',
  hosting: 'third-party',
}

export const QWEN_VL_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  upstream: { name: 'Qwen3-VL (GGUF by unsloth)', url: 'https://huggingface.co/unsloth' },
  url: 'https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct',
  attribution: QWEN_ATTRIBUTION,
  modifications: 'Q4_K_M GGUF quantisation by unsloth (not re-hosted by CamStack)',
  hosting: 'third-party',
}

export const QWEN36_APACHE: ModelLicense = {
  weights: 'Apache-2.0',
  upstream: {
    name: 'Qwen3.6-35B-A3B (GGUF by unsloth)',
    url: 'https://huggingface.co/unsloth/Qwen3.6-35B-A3B-GGUF',
  },
  url: 'https://huggingface.co/Qwen/Qwen3.6-35B-A3B/blob/main/LICENSE',
  attribution: QWEN_ATTRIBUTION,
  modifications: 'UD-Q4_K_M GGUF quantisation by unsloth (not re-hosted by CamStack)',
  hosting: 'third-party',
}
