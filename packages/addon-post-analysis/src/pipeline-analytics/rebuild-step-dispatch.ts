/**
 * Where a rebuild's per-track work is placed, and what happens when a node
 * stops being able to do it.
 *
 * One track = one `pipelineRunner.runStatelessStep` call, node-pinned. This
 * module owns the three rules that make a fleet pass trustworthy:
 *
 * 1. **One model for the whole pass.** `modelId` is fixed at construction and
 *    sent with every request. Step model config is per-(node, device)
 *    (`DeviceStepConfigSchema.modelId`), so a pass that let each node choose
 *    would fill one vector index from several encoders — D52 one level down,
 *    and undetectable afterwards because nothing in a stored vector says which
 *    encoder made it.
 * 2. **A node that cannot serve the pin leaves, and the track is retried.** Not
 *    "counted as failed": the work is fine, the placement was wrong.
 * 3. **It cannot wedge.** Every attempt either returns a verdict or removes a
 *    node, and a track is tried at most once per candidate. When the rotation
 *    empties the pass is over, loudly, rather than spinning.
 */
import type { RunStatelessStepInput, RunStatelessStepResult } from '@camstack/types'
import type { RebuildEmbedOutcome, RebuildSource } from './embedding-rebuild.js'
import {
  buildRebuildStepInput,
  hasKeyFrame,
  readRebuildStepOutcome,
} from './rebuild-detail-request.js'
import type { NodeRotation } from './rebuild-node-rotation.js'

export interface RebuildStepDispatchDeps {
  /**
   * Call `pipelineRunner.runStatelessStep` PINNED to `nodeId`.
   *
   * Injected rather than reached for, because the pin is the entire placement
   * mechanism and a test that cannot see which node was asked cannot prove
   * anything about distribution.
   */
  runStatelessStep(nodeId: string, input: RunStatelessStepInput): Promise<RunStatelessStepResult>
  readonly logger: {
    warn: (
      message: string,
      extras?: { tags?: { deviceId?: number }; meta?: Record<string, unknown> },
    ) => void
  }
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/**
 * Place one track's embedding on a node and read the answer.
 *
 * Holds the rotation across tracks (a node dropped on track 12 stays dropped),
 * which is why it is an object and not a function.
 */
export class RebuildStepDispatcher {
  constructor(
    private readonly deps: RebuildStepDispatchDeps,
    private readonly rotation: NodeRotation,
    /** The model every request in this pass pins. Never re-resolved mid-pass. */
    private readonly modelId: string,
  ) {}

  /**
   * Is there anywhere left to send work? Answered from memory, with no I/O.
   *
   * The caller asks this BEFORE loading a track's media. Nodes only ever leave
   * the rotation, so a `false` here is permanent for the pass — which is what
   * lets the loop stop instead of re-discovering it per track, each time after
   * a blob read. That ordering was the difference between a maintenance job and
   * a 43-minute hub-main saturation.
   */
  get canDispatch(): boolean {
    return !this.rotation.exhausted
  }

  /** Nodes still in the rotation — for the pass's closing summary. */
  get liveNodes(): readonly string[] {
    return this.rotation.live
  }

  /** Nodes that left, with reasons — the operator's answer to "why so few". */
  get droppedNodes(): ReadonlyArray<{ readonly nodeId: string; readonly reason: string }> {
    return this.rotation.dropped
  }

  async embed(source: RebuildSource): Promise<RebuildEmbedOutcome> {
    if (!hasKeyFrame(source)) {
      return { kind: 'failed', reason: 'no key frame or no bbox' }
    }
    const input = buildRebuildStepInput(source, this.modelId)
    // Bounded by construction: a track is offered to each candidate at most
    // once, so the loop terminates even if `drop` ever stopped removing.
    const attempted = new Set<string>()

    for (;;) {
      const nodeId = this.rotation.next()
      if (nodeId === null || attempted.has(nodeId)) {
        return {
          kind: 'no-capable-node',
          reason:
            this.rotation.dropped.length > 0
              ? `every candidate node left the rotation: ${this.rotation.dropped
                  .map((d) => `${d.nodeId} (${d.reason})`)
                  .join('; ')}`
              : 'no online node runs a pipeline runner that can serve this step',
        }
      }
      attempted.add(nodeId)

      let result: RunStatelessStepResult
      try {
        result = await this.deps.runStatelessStep(nodeId, input)
      } catch (err: unknown) {
        // A node that stopped answering mid-pass is a placement problem, never
        // a verdict on the track: drop it and try the same track elsewhere.
        this.dropNode(nodeId, `call failed: ${errorMessage(err)}`, source.deviceId)
        continue
      }

      const verdict = readRebuildStepOutcome(result, this.modelId)
      if (verdict.kind === 'node-unfit') {
        this.dropNode(nodeId, verdict.reason, source.deviceId)
        continue
      }
      return verdict
    }
  }

  /** Retire a node, loudly. A shrinking fleet with no log is an invisible slowdown. */
  private dropNode(nodeId: string, reason: string, deviceId: number): void {
    this.rotation.drop(nodeId, reason)
    this.deps.logger.warn('embedding rebuild: node left the rotation', {
      tags: { deviceId },
      meta: { nodeId, reason, modelId: this.modelId, remaining: [...this.rotation.live] },
    })
  }
}
