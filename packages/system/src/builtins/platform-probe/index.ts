/**
 * Platform-probe core builtin.
 *
 * Infra addon — probes hardware + inference runtimes on the local node and
 * exposes the result via the `platform-probe` capability (singleton per
 * node).
 */
import type {
  ProviderRegistration,
  IPlatformProbeProvider,
  PlatformCapabilities,
  HardwareInfo,
  ModelRequirement,
  ResolvedInferenceConfig,
  HwAccelBackend,
  AcceleratorRescan,
} from '@camstack/types'
import {
  BaseAddon,
  platformProbeCapability,
  errMsg,
  emitReadiness,
  EventCategory,
} from '@camstack/types'
import { PlatformScorer } from './platform-scorer.js'
import { InferenceConfigResolver } from './inference-config-resolver.js'
import { nodeCoralFs } from './coral-accelerators.js'
import {
  findAcceleratorFactsScript,
  readPublishedAcceleratorFacts,
  publishedAcceleratorFactsPath,
  runAcceleratorFactsProbe,
} from './accelerator-facts-probe.js'

export { PlatformScorer } from './platform-scorer.js'
export { InferenceConfigResolver } from './inference-config-resolver.js'

/**
 * The decode-hwaccel backends `ctx.kernel.hwaccel.resolve` accepts. The cap
 * input enum is WIDER (it also carries EP-only names — coreml/openvino/… —
 * shared with other probe surfaces), so the provider param must stay
 * `string`-typed to satisfy the `InferProvider` contract. We narrow it here
 * with a type guard instead of a cast: any value that is not a known decode
 * backend (or the `'none'` sentinel) resolves to `null` → auto-probe.
 */
const HWACCEL_DECODE_BACKENDS: readonly string[] = [
  'videotoolbox',
  'cuda',
  'nvdec',
  'vaapi',
  'qsv',
  'd3d11va',
  'dxva2',
  'amf',
  'vdpau',
  'drm',
]

function isHwAccelBackend(value: string): value is HwAccelBackend {
  return HWACCEL_DECODE_BACKENDS.includes(value)
}

function narrowHwAccelPrefer(value: string | null | undefined): HwAccelBackend | 'none' | null {
  if (value === 'none') return 'none'
  if (typeof value === 'string' && isHwAccelBackend(value)) return value
  return null
}

/** How often the accelerator part of the probe is re-run (D919). Cheap: `/sys` + `/dev` reads. */
export const ACCELERATOR_REPROBE_INTERVAL_MS = 60_000

/** What started an accelerator re-probe — logged with every change. */
export type AcceleratorReprobeTrigger = 'periodic' | 'operator'

export class PlatformProbeNativeAddon extends BaseAddon {
  private scorer: PlatformScorer | null = null
  private cachedCaps: PlatformCapabilities | null = null
  /** The periodic accelerator re-probe; started once the full probe completed. */
  private reprobeTimer: ReturnType<typeof setInterval> | null = null
  /**
   * Per-boot generation stamp for the manual readiness emissions below.
   * Constant for the lifetime of this addon instance (== one process boot);
   * consumer-side registries derive a monotonic epoch from generation
   * transitions. Mirrors `BaseAddon._readinessGeneration` (private there).
   */
  private readonly readinessGeneration: string =
    typeof crypto !== 'undefined' && crypto.randomUUID
      ? crypto.randomUUID()
      : Math.random().toString(36).slice(2, 14)

  constructor() {
    super({})
  }

  /**
   * Manual readiness protocol. The provider registers synchronously from
   * `onInitialize`, but the REAL hardware + EP scoring is the async
   * `probePromise` (embedded-Python install included). The BaseAddon
   * auto-emit would flip `ready` at registration time — BEFORE any
   * accelerator is visible — so probe-gated consumers (detection-pipeline
   * engine auto-pick) would read accelerator-blind results and stick on
   * onnx-CPU. Instead: `starting` at init, the single authoritative
   * `ready` once the probe resolves, `down` on shutdown.
   */
  protected override get autoEmitReadiness(): boolean {
    return false
  }

  /** Bare cluster node id — readiness is scoped `{type:'node', nodeId}`. */
  private bareLocalNodeId(): string {
    const raw = this.ctx.kernel?.localNodeId ?? 'hub'
    return raw.includes('/') ? raw.split('/')[0]! : raw
  }

  /** Emit a `system.ready-state` transition for the platform-probe cap. */
  private emitProbeReadiness(state: 'starting' | 'ready' | 'down'): void {
    const ctx = this.ctxIfReady
    if (!ctx) return
    const nodeId = this.bareLocalNodeId()
    try {
      emitReadiness(ctx.eventBus, {
        capName: platformProbeCapability.name,
        scope: { type: 'node', nodeId },
        state,
        generation: this.readinessGeneration,
        sourceNodeId: nodeId,
      })
    } catch {
      /* best-effort — a broken bus must not take the probe down */
    }
  }

  protected async onInitialize(): Promise<ProviderRegistration[]> {
    // Readiness: `starting` now; the authoritative `ready` flips only when
    // the async probe below completes (see `autoEmitReadiness` above).
    this.emitProbeReadiness('starting')
    // The hub ships no system python3 — inference uses the embedded portable
    // Python. Resolve it so the scorer probes the SAME interpreter the
    // detection pool runs (coreml/openvino EP availability). null → the
    // scorer falls back to a PATH lookup (dev/agent). Best-effort: a failed
    // download must not abort the probe (hardware + ffmpeg scoring still run).
    const embeddedPython = await this.ctx.deps.ensurePython().catch((err: unknown) => {
      this.ctx.logger.debug('ensurePython unavailable for platform probe', {
        meta: { error: errMsg(err) },
      })
      return null
    })
    // Every probe line (the Coral evidence included) is per node.
    const factsScript = findAcceleratorFactsScript(this.ctx.dataDir)
    this.scorer = new PlatformScorer(
      this.ctx.logger.withTags({ nodeId: this.bareLocalNodeId() }),
      embeddedPython,
      nodeCoralFs,
      embeddedPython === null || factsScript === null
        ? null
        : () =>
            runAcceleratorFactsProbe({
              pythonPath: embeddedPython,
              scriptPath: factsScript,
            }),
    )

    const emitPhase = (phase: string, payload?: Record<string, unknown>): void => {
      this.ctx.eventBus?.emit({
        id: `platform-probe-${phase}-${Date.now()}`,
        timestamp: new Date(),
        source: { type: 'core', id: 'platform-probe-native' },
        category: EventCategory.PlatformProbePhase,
        data: { type: 'platform-probe.phase', phase, ...payload },
      })
    }

    const scorer = this.scorer
    const probePromise: Promise<PlatformCapabilities> = scorer
      .probe(emitPhase)
      .then((caps) => {
        this.cachedCaps = caps
        this.ctx.logger.info('Platform probe complete', {
          meta: {
            cpuModel: caps.hardware.cpuModel,
            arch: caps.hardware.arch,
            totalRAM_MB: caps.hardware.totalRAM_MB,
            gpu: caps.hardware.gpu?.name ?? 'none',
            bestReason: caps.bestScore.reason,
            bestScore: caps.bestScore.score,
          },
        })
        // The single authoritative `ready` — the probe (incl. embedded-Python
        // EP scoring) is final, so consumers gating on readiness now see the
        // node's REAL accelerators. On failure this never fires (consumers
        // fall back via their finite awaitReady timeout).
        this.emitProbeReadiness('ready')
        this.startAcceleratorReprobe()
        return caps
      })
      .catch((err: unknown) => {
        const msg = errMsg(err)
        this.ctx.logger.error('Platform probe failed', {
          meta: { error: msg },
        })
        emitPhase('error', { message: msg })
        throw err
      })

    const getCaps = async (): Promise<PlatformCapabilities> => {
      return this.cachedCaps ?? probePromise
    }

    const provider: IPlatformProbeProvider = {
      getCapabilities: async (): Promise<PlatformCapabilities> => {
        return getCaps()
      },
      getHardware: async (): Promise<HardwareInfo> => {
        const caps = await getCaps()
        // The pool publishes this after it starts. A boot probe that ran
        // before OpenVINO was installed stays cached; the file is the update.
        const published = readPublishedAcceleratorFacts(publishedAcceleratorFactsPath())
        if (published === null) return caps.hardware
        return { ...caps.hardware, accelerators: published }
      },
      resolveInferenceConfig: async (input: {
        readonly requirements: readonly ModelRequirement[]
      }): Promise<ResolvedInferenceConfig> => {
        const caps = await getCaps()
        const resolver = new InferenceConfigResolver(caps.scores, caps.hardware)
        return resolver.resolve(input.requirements)
      },
      resolveHwAccel: async (input: {
        readonly prefer?: string | null
      }): Promise<{ preferred: readonly string[]; rationale: string }> => {
        const hwaccel = this.ctx.kernel.hwaccel
        if (!hwaccel) {
          return { preferred: [], rationale: 'kernel hwaccel unavailable' }
        }
        const res = await hwaccel.resolve(narrowHwAccelPrefer(input.prefer))
        return { preferred: res.preferred, rationale: res.rationale }
      },
      rescanAccelerators: async (): Promise<AcceleratorRescan> => {
        // A rescan before the first probe completed waits for it: there is no
        // device list to compare against until then.
        await getCaps()
        const rescan = this.reprobeAccelerators('operator')
        if (rescan === null) throw new Error('platform-probe: the probe is shutting down')
        return rescan
      },
    }

    return [{ capability: platformProbeCapability, provider }]
  }

  /** Start the periodic accelerator re-probe (idempotent). */
  private startAcceleratorReprobe(): void {
    if (this.reprobeTimer !== null) return
    this.reprobeTimer = setInterval(() => {
      this.reprobeAccelerators('periodic')
    }, ACCELERATOR_REPROBE_INTERVAL_MS)
    this.reprobeTimer.unref?.()
  }

  /**
   * Re-run the accelerator part of the probe and serve its answer from now on.
   * Every device that appeared or disappeared is logged, naming the node and
   * what triggered the re-probe; the orchestrator sees the new list on its next
   * `getCapabilities` read and re-elects through its device-set-change path.
   * `null` when the scorer is gone or has not completed its first probe.
   */
  reprobeAccelerators(trigger: AcceleratorReprobeTrigger): AcceleratorRescan | null {
    const scorer = this.scorer
    if (scorer === null) return null
    let result: ReturnType<PlatformScorer['reprobeAccelerators']>
    try {
      result = scorer.reprobeAccelerators()
    } catch (err: unknown) {
      this.ctx.logger.warn('accelerator re-probe failed — last device list kept', {
        tags: { nodeId: this.bareLocalNodeId() },
        meta: { nodeId: this.bareLocalNodeId(), trigger, error: errMsg(err) },
      })
      return null
    }
    if (result === null) return null
    this.cachedCaps = result.caps
    const nodeId = this.bareLocalNodeId()
    for (const deviceKey of result.change.appeared)
      this.ctx.logger.info('inference device appeared', {
        tags: { nodeId },
        meta: {
          nodeId,
          deviceKey,
          trigger,
          decidedBy: result.detection.decidedBy,
        },
      })
    for (const deviceKey of result.change.disappeared)
      this.ctx.logger.info('inference device disappeared', {
        tags: { nodeId },
        meta: {
          nodeId,
          deviceKey,
          trigger,
          decidedBy: result.detection.decidedBy,
        },
      })
    if (trigger === 'operator')
      this.ctx.logger.info('inference devices rescanned', {
        tags: { nodeId },
        meta: {
          nodeId,
          usbBus: result.detection.usbBus,
          decidedBy: result.detection.decidedBy,
          appeared: result.change.appeared,
          disappeared: result.change.disappeared,
        },
      })
    return {
      devices: result.caps.devices,
      appeared: result.change.appeared,
      disappeared: result.change.disappeared,
      usbBus: result.detection.usbBus,
      decidedBy: result.detection.decidedBy,
    }
  }

  protected async onShutdown(): Promise<void> {
    if (this.reprobeTimer !== null) {
      clearInterval(this.reprobeTimer)
      this.reprobeTimer = null
    }
    this.emitProbeReadiness('down')
    this.scorer = null
    this.cachedCaps = null
  }
}

export default PlatformProbeNativeAddon
