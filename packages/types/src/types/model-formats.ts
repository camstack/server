/**
 * The model weight formats a catalog entry can ship. Schema-free on purpose:
 * `types/models.ts` builds Zod schemas from it, but a runner-closure consumer
 * (the model downloader in `@camstack/system`) needs only the list and must
 * reach it through `@camstack/types/addon` without building the cap schema
 * graph (D28).
 */
export const MODEL_FORMATS = ['onnx', 'coreml', 'openvino', 'tflite', 'pt', 'gguf'] as const
export type ModelFormat = (typeof MODEL_FORMATS)[number]
