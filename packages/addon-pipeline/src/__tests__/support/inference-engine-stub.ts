import type { EngineOutput, IInferenceEngine, InferenceInput } from '@camstack/types'
import { vi } from 'vitest'
import { makeEngineOutput } from './engine-output.js'

/** Minimal {@link IInferenceEngine} for executor / assembler specs. */
export function makeInferenceEngineStub(
  output: EngineOutput = makeEngineOutput({ kind: 'classifications', classifications: [] }),
): IInferenceEngine {
  return {
    runtime: 'onnx',
    device: 'cpu',
    infer: vi.fn(async (_input: InferenceInput): Promise<EngineOutput> => output),
    dispose: async () => {},
  }
}
