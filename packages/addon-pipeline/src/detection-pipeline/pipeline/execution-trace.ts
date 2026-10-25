/**
 * Execution trace builder — creates StepTrace records for observability.
 *
 * Three verbosity levels:
 * - 'off': no trace created (zero overhead)
 * - 'summary': timing only (minimal overhead)
 * - 'full': timing + input/output metadata (for benchmark/test)
 */
import type {
  TraceVerbosity,
  StepTrace,
  PipelineExecutionTrace,
  StepOutput,
  PipelineSlot,
  PostprocessorType,
} from '@camstack/types'

let traceCounter = 0

export class ExecutionTraceBuilder {
  private readonly steps: StepTrace[] = []
  private readonly startTime: number

  constructor(
    private readonly verbosity: TraceVerbosity,
    private readonly deviceId: number,
    private readonly frameWidth: number,
    private readonly frameHeight: number,
    private readonly engineRuntime: string,
  ) {
    this.startTime = Date.now()
  }

  /** Whether trace collection is active. */
  get isActive(): boolean {
    return this.verbosity !== 'off'
  }

  /**
   * Record a completed step execution.
   * No-op if verbosity is 'off'.
   */
  addStep(params: {
    stepId: string
    modelId: string
    slot: PipelineSlot
    postprocessor: PostprocessorType
    preprocessMs: number
    inferenceMs: number
    postprocessMs: number
    inputType: 'full-frame' | 'crop-roi'
    inputWidth: number
    inputHeight: number
    parentDetection?: string
    output: StepOutput
    error?: string
  }): void {
    if (this.verbosity === 'off') return

    const totalMs = params.preprocessMs + params.inferenceMs + params.postprocessMs

    const trace: StepTrace = {
      stepId: params.stepId,
      modelId: params.modelId,
      slot: params.slot,
      postprocessor: params.postprocessor,
      preprocessMs: Math.round(params.preprocessMs * 100) / 100,
      inferenceMs: Math.round(params.inferenceMs * 100) / 100,
      postprocessMs: Math.round(params.postprocessMs * 100) / 100,
      totalMs: Math.round(totalMs * 100) / 100,
      inputType: params.inputType,
      inputSize: { width: params.inputWidth, height: params.inputHeight },
      parentDetection: this.verbosity === 'full' ? params.parentDetection : undefined,
      outputKind: params.output.kind,
      outputCount: countOutput(params.output),
      topResult: this.verbosity === 'full' ? formatTopResult(params.output) : undefined,
      error: params.error,
    }

    this.steps.push(trace)
  }

  /**
   * Finalize and return the complete execution trace.
   * Returns null if verbosity is 'off'.
   */
  build(detectionCount: number): PipelineExecutionTrace | null {
    if (this.verbosity === 'off') return null

    const totalMs = Date.now() - this.startTime

    return {
      traceId: `trace-${Date.now()}-${++traceCounter}`,
      deviceId: this.deviceId,
      timestamp: this.startTime,
      frameSize: { width: this.frameWidth, height: this.frameHeight },
      engineRuntime: this.engineRuntime,
      steps: this.steps,
      totalMs,
      detectionCount,
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function countOutput(output: StepOutput): number {
  switch (output.kind) {
    case 'detections':
      return output.detections.length
    case 'classifications':
      return output.classifications.length
    case 'embedding':
      return 1
    case 'text':
      return output.text.length > 0 ? 1 : 0
    case 'mask':
      return 1
  }
}

function formatTopResult(output: StepOutput): string | undefined {
  switch (output.kind) {
    case 'detections': {
      const top = output.detections[0]
      return top ? `${top.class} ${top.score.toFixed(2)}` : undefined
    }
    case 'classifications': {
      const top = output.classifications[0]
      return top ? `${top.class} ${top.score.toFixed(2)}` : undefined
    }
    case 'embedding':
      return `embedding[${output.embedding.length}]`
    case 'text':
      return output.text || undefined
    case 'mask':
      return `mask ${output.maskWidth}×${output.maskHeight}`
  }
}
