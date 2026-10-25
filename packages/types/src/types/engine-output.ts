/**
 * Output envelope of an inference engine call.
 *
 * Every engine is a Python pool (`inference_pool.py`) and postprocessing runs
 * in-process there — the pool returns a `structured` StepOutput payload. The
 * former Node.js onnxruntime raw-tensor fields (`tensor` / `tensors` /
 * `letterbox`) were removed with that path: the platform ships no Node ONNX
 * runtime.
 */
export interface EngineOutput {
  readonly structured?: Record<string, unknown>
  readonly inferenceMs: number
  /**
   * Overload shed: the inference pool DELIBERATELY did not run inference for
   * this frame (the Python pool's per-model in-flight bound, or the TS-side
   * worker in-flight cap). A shed output carries NO `structured` payload —
   * consumers skip the frame the way any dropped frame is skipped. It is an
   * expected flow-control outcome, never an error.
   */
  readonly dropped?: true
  /** Which bound shed the frame (e.g. `'worker-in-flight-cap'`). */
  readonly shedReason?: string
}
