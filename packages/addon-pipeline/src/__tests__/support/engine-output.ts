import type { EngineOutput } from '@dominevo/types'

/** Minimal {@link EngineOutput} for pipeline executor specs. */
export function makeEngineOutput(
  structured: EngineOutput['structured'],
  inferenceMs = 1,
): EngineOutput {
  return { structured, inferenceMs }
}
