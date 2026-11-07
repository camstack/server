import type { ConfigUISchema } from '@camstack/types'
import { type RuntimeId, type RuntimePoolProfile, tuningFor } from './runtimes.js'

/**
 * The live and per-backend values laid into the detection-pipeline settings forms. The scoped
 * hooks (`clusterSettingsSchema`, `nodeSettingsSchema`) and `scopedSettingsOverlay` (which
 * offers the tuned defaults for the node that asks) share them.
 */

/**
 * Slider keys on the "Inference executor" section that map 1:1 onto a
 * {@link RuntimePoolProfile} field. Used to inject the node-default runtime's
 * registry value as the field's suggested default in the executor form.
 */
const PROFILE_SLIDER_KEYS = [
  'concurrency',
  'numWorkers',
  'windowMs',
  'maxBatchSize',
  'numStreams',
  'intraOpThreads',
] as const

type ProfileSliderKey = (typeof PROFILE_SLIDER_KEYS)[number]

function isProfileSliderKey(key: string): key is ProfileSliderKey {
  return PROFILE_SLIDER_KEYS.some((k) => k === key)
}

export const CONCURRENCY_MAX = 8
const COREML_CONCURRENCY_MAX = 4

/** The model-substitution readout, laid into the cluster form as the field's live default. */
export function withLiveSubstitutions(schema: ConfigUISchema, text: string): ConfigUISchema {
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) =>
        field.type === 'text' && field.key === 'activeModelSubstitutions'
          ? { ...field, default: text }
          : field,
      ),
    })),
  }
}

/**
 * The matrix-tuned slider/select defaults of one backend, laid into the executor form. They are a
 * UI hint only: a persisted value always wins (`hydrateSchema` lays the store over defaults).
 */
export function withBackendTuning(schema: ConfigUISchema, backend: RuntimeId): ConfigUISchema {
  const tuning: RuntimePoolProfile = tuningFor(backend)
  return {
    ...schema,
    sections: schema.sections.map((section) => ({
      ...section,
      fields: section.fields.map((field) => {
        if (field.type === 'select' && field.key === 'batchMode') {
          return { ...field, default: tuning.batchMode }
        }
        if (field.type === 'slider') {
          // Per-backend slider max overrides — CoreML serializes per-context
          // so >4 prepare workers add overhead without throughput. OpenVINO/
          // ONNX inherit the schema default (32) which is already reasonable.
          const tuned = isProfileSliderKey(field.key)
            ? { ...field, default: tuning[field.key] }
            : field
          if (field.key !== 'concurrency') return tuned
          return {
            ...tuned,
            max: backend === 'coreml' ? COREML_CONCURRENCY_MAX : CONCURRENCY_MAX,
          }
        }
        return field
      }),
    })),
  }
}
