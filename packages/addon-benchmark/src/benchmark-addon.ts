/**
 * Benchmark addon — the Benchmark page in the admin UI (Node benchmark ·
 * Image · Audio) and its one custom action, the Image section's single run.
 *
 * HUB-ONLY (D646): custom actions are served by the hub instance. The node
 * benchmark is NOT here: the pipeline orchestrator owns it (D791) and drives
 * the measured node's runner; this addon only renders it. Everything here is
 * orchestration through `ctx.api` — no engine state. Its one store is the
 * accuracy evaluation's record kinds (`record-kinds.ts`).
 */
import type {
  AddonApi,
  AddonInitResult,
  AddonPageDeclaration,
  FrameResult,
  IAddonPageProvider,
} from '@camstack/types'
import { BaseAddon, addonPagesSourceCapability } from '@camstack/types'
import type { z } from 'zod'
import { benchmarkActions, type BenchmarkActions } from './benchmark-actions.js'
import { benchmarkRecordKinds } from './record-kinds.js'
/**
 * Hard backstop for one `runPipelineTest` call. BELOW the UDS addon-call
 * plane's 60 s request timeout (`DEFAULT_UDS_REQUEST_TIMEOUT_MS`): the old
 * 120 s guard could never fire first, so the caller was abandoned by the
 * transport while this still waited. A single run is far below it.
 */
const BENCH_RUN_TIMEOUT_MS = 55_000

/**
 * Race `promise` against a hard timeout. On timeout the returned promise
 * REJECTS with a clear, operator-facing message (never resolves silently) so
 * the caller surfaces an error instead of hanging. The pending work is left to
 * settle on its own (it can't be cancelled through the cap boundary).
 */
export async function withHardTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} exceeded ${ms}ms — aborting (likely a wedged step)`)),
      ms,
    )
    timer.unref?.()
  })
  try {
    return await Promise.race([promise, timeout])
  } finally {
    if (timer) clearTimeout(timer)
  }
}

type ActionInput<K extends keyof BenchmarkActions> = z.infer<BenchmarkActions[K]['input']>

export class BenchmarkAddon extends BaseAddon {
  readonly id = 'benchmark'

  readonly pages: readonly AddonPageDeclaration[] = [
    {
      id: 'benchmark',
      label: 'Benchmark',
      icon: 'gauge',
      path: '/addon/benchmark',
      remoteName: 'addon_benchmark_page',
      bundle: 'remoteEntry.js',
      // Dock into the sidebar's Detection group.
      section: 'detection',
    },
  ] as const

  constructor() {
    super({})
  }

  protected async onInitialize(): Promise<AddonInitResult<BenchmarkActions>> {
    // The accuracy evaluation's runs and samples (`record-kinds.ts`). Hub-only,
    // so the kernel always provides records; without them a run would have
    // nowhere to live, and that is a boot failure, not a silent degrade.
    const records = this.ctx.records
    if (records === undefined) {
      throw new Error('benchmark needs ctx.records for its eval-run / eval-sample kinds')
    }
    await records.declare(benchmarkRecordKinds)

    const provider: IAddonPageProvider = {
      id: this.id,
      listPages: () => this.pages,
    }

    return {
      providers: [{ capability: addonPagesSourceCapability, provider }],
      customActions: benchmarkActions,
      actionHandlers: {
        runPipelineTest: async (input) => this.runPipelineTest(input),
      },
    }
  }

  protected async onShutdown(): Promise<void> {}

  private get api(): AddonApi {
    const api = this.ctx.api
    if (!api) throw new Error('BenchmarkAddon: ctx.api not available')
    return api
  }

  // ── Detection Pipeline — one run ─────────────────────────────────────────

  private async runPipelineTest(input: ActionInput<'runPipelineTest'>): Promise<FrameResult> {
    const { nodeId, steps, imageBase64, referenceImage, sessionId, deviceKey, plane } = input

    // Debug-level: the payload an operator correlates a slow or odd run with.
    this.ctx.logger.debug('runPipelineTest payload', {
      meta: {
        nodeId: nodeId ?? null,
        deviceKey: deviceKey ?? null,
        plane: plane ?? null,
        sessionId: sessionId ?? null,
        stepsCount: steps.length,
        steps: steps.map(
          (s) => `${s.addonId}/${s.modelId ?? '(format default)'}${s.enabled ? '' : '[off]'}`,
        ),
        imageSource: referenceImage
          ? `ref:${referenceImage}`
          : imageBase64
            ? `base64:${Math.round(imageBase64.length / 1024)}KB`
            : 'none',
      },
    })

    // Binary on the internal hop: the browser→hub leg carries base64 (superjson
    // cannot ship binary efficiently), the hub→executor leg ships bytes.
    const image = imageBase64 ? new Uint8Array(Buffer.from(imageBase64, 'base64')) : undefined

    // A model is chosen by the accelerator that runs it (D927): the caller
    // names the tree (a camera's resolved pipeline, or the builder's), and the
    // executing node resolves each absent `modelId` from that device's
    // provisioning. There is no node-wide tree to fall back to.
    if (steps.length === 0) {
      throw new Error(
        'runPipelineTest needs the steps to run: pass a camera tree from pipelineOrchestrator.resolvePipeline or build one',
      )
    }
    const stepsToRun = [...steps]

    return withHardTimeout(
      this.api.pipelineExecutor.runPipeline.mutate({
        nodeId,
        steps: stepsToRun,
        ...(image ? { image } : {}),
        referenceImage,
        sessionId,
        // Absent, never present-and-undefined: the generated router takes
        // `.loose()` input and an explicit `undefined` is not the same thing
        // as "the node's default pool" / "the cap's default plane".
        ...(deviceKey ? { deviceKey } : {}),
        ...(plane ? { plane } : {}),
      }),
      BENCH_RUN_TIMEOUT_MS,
      'runPipelineTest',
    )
  }
}
