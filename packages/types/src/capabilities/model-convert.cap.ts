import { z } from 'zod'
import {
  ConvertResultSchema,
  ConvertTargetSchema,
  ModelConvertMetadataSchema,
} from '../types/models.js'
import { type CapabilityDefinition, type InferProvider, method } from './capability-definition.js'

export const ModelConvertInputSchema = z.object({
  sourceUrl: z.string(),
  metadata: ModelConvertMetadataSchema,
  targets: z.array(ConvertTargetSchema).min(1).readonly(),
  calibrationRef: z.string().optional(),
  sessionId: z.string().optional(),
})
export type ModelConvertInput = z.infer<typeof ModelConvertInputSchema>

export const modelConvertCapability = {
  name: 'model-convert',
  scope: 'system',
  mode: 'singleton',
  internal: true,
  methods: {
    convert: method(ModelConvertInputSchema, ConvertResultSchema, {
      kind: 'mutation',
      auth: 'admin',
      // Model conversion (download + onnxsim + onnx2torch/trace + coremltools/OV)
      // runs for minutes; the default ~60s RPC timeout kills it mid-run. 10 min.
      timeoutMs: 600_000,
    }),
  },
} as const satisfies CapabilityDefinition

export type IModelConvertProvider = InferProvider<typeof modelConvertCapability>
