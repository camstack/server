import type {
  FrameInput,
  CropInput,
  PipelineConfig,
  PipelineNode,
  PipelineResult,
  StepResult,
  SpatialDetection,
  PipelineSlot,
  IAddonResolver,
  InferenceOutput,
} from '@camstack/types'
import { randomUUID } from 'node:crypto'
import { errMsg } from '@camstack/types'

export class PipelineRunner {
  constructor(private readonly addonResolver: IAddonResolver) {}

  async run(frame: FrameInput, config: PipelineConfig): Promise<PipelineResult> {
    const startTime = performance.now()
    const results: StepResult[] = []
    const timings: Record<string, number> = {}

    // Execute video pipeline root nodes
    for (const rootNode of config.video) {
      await this.executeNode(rootNode, frame, null, results, timings)
    }

    // Execute audio node if present (independent)
    if (config.audio) {
      await this.executeNode(config.audio, frame, null, results, timings)
    }

    return {
      results,
      totalMs: performance.now() - startTime,
      timings,
      frameTimestamp: frame.timestamp,
    }
  }
  private async executeNode(
    node: PipelineNode,
    frame: FrameInput,
    parentDetection: { det: SpatialDetection; resultId: string } | null,
    results: StepResult[],
    timings: Record<string, number>,
  ): Promise<void> {
    const resultId = randomUUID()
    const stepStart = performance.now()

    try {
      // Resolve addon caller via the resolver
      const effectiveConfig = { ...node.configOverride }
      const caller = await this.addonResolver.resolve(node.addon, effectiveConfig)

      // Unified interface: always call process() with the appropriate input.
      // - Root nodes: FrameInput (full frame)
      // - Child nodes: CropInput (region from parent detection)
      // The addon determines output type (detections/crops/classifications/mask)
      // based on its slot — the runner doesn't need to know.
      let output: InferenceOutput

      if (parentDetection) {
        const cropInput: CropInput = {
          frame,
          roi: parentDetection.det.bbox,
          parentDetection: parentDetection.det,
        }
        output = await caller.process(cropInput)
      } else {
        output = await caller.process(frame)
      }

      const stepMs = performance.now() - stepStart

      // Determine slot type from output shape
      const slot: PipelineSlot =
        'detections' in output ? 'detector' : 'crops' in output ? 'cropper' : 'classifier'

      const stepResult: StepResult = {
        addon: node.addon,
        slot,
        output,
        parentResultId: parentDetection?.resultId,
        resultId,
        inferenceMs: output.inferenceMs,
        preprocessMs: 0,
        totalMs: stepMs,
      }
      results.push(stepResult)
      timings[node.step] = stepMs

      // Process children
      if (node.children?.length) {
        const detections: readonly SpatialDetection[] =
          'detections' in output ? output.detections : 'crops' in output ? output.crops : []

        // For each detection, find children with matching inputClasses and execute
        await this.executeChildren(node.children, frame, detections, resultId, results, timings)
      }
    } catch (error: unknown) {
      const stepMs = performance.now() - stepStart
      const message = errMsg(error)
      results.push({
        addon: node.addon,
        slot: 'detector',
        output: { detections: [], inferenceMs: 0, modelId: '' },
        parentResultId: parentDetection?.resultId,
        resultId,
        inferenceMs: 0,
        preprocessMs: 0,
        totalMs: stepMs,
        error: {
          code: 'ADDON_ERROR',
          message,
          childrenSkipped: true,
        },
      })
    }
  }

  private async executeChildren(
    children: readonly PipelineNode[],
    frame: FrameInput,
    parentDetections: readonly SpatialDetection[],
    parentResultId: string,
    results: StepResult[],
    timings: Record<string, number>,
  ): Promise<void> {
    // For each parent detection, run all matching children in parallel
    const promises: Promise<void>[] = []

    for (const detection of parentDetections) {
      // Skip detections with degenerate bounding boxes
      if (detection.bbox.w < 1 || detection.bbox.h < 1) continue

      for (const child of children) {
        // TODO: Check inputClasses matching from addon manifest
        // For now, run all children on all detections (caller configures tree correctly)
        promises.push(
          this.executeNode(
            child,
            frame,
            { det: detection, resultId: parentResultId },
            results,
            timings,
          ),
        )
      }
    }

    await Promise.allSettled(promises)
  }
}
