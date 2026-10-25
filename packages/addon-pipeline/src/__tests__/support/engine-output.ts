import type { EngineOutput } from '@camstack/types'

/** Minimal {@link EngineOutput} for pipeline executor specs. */
export function makeEngineOutput(
  structured: EngineOutput['structured'],
  inferenceMs = 1,
): EngineOutput {
  return { structured, inferenceMs }
}
