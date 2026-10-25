/**
 * Auto tune (D745, D755): gather the inputs, compute the plan, and apply
 * exactly the plan the operator confirmed.
 *
 * The plan is the recommender (`@camstack/types` auto-tune) over every
 * runner node — sized by a capacity floor (`minSessionsPerDevice` parallel
 * sessions per device at the camera rate), never by observed or estimated
 * load — plus the diff of the writes (`plan-diff.ts`). Every model and
 * model-bound threshold lives on an accelerator (D927), so that is the only
 * layer it writes. Its `planHash` names everything the apply writes; the apply recomputes the plan
 * and refuses a different hash, so a configuration change between the two is
 * shown to the operator again instead of being written over.
 *
 * Apply order, each phase reported:
 *  1. download every newly picked detector on its node FIRST — a node never
 *     switches to a model it does not have (an N100 compile takes 5–25 s, a
 *     Core ML package 40 MB); any failure stops the apply before a write;
 *  2. node model pins (one agent-blob read-modify-write);
 *  3. re-dispatch the cameras of every touched node.
 * Re-running converges.
 *
 * Custom models are never overwritten (D786): a (node, device) whose root
 * detector is pinned to a custom-registry model is KEPT by the recommender, and
 * the diff writes nothing there. The plan warns about each. A registry that does not answer keeps
 * every pin outside the measured catalog — unknown is never "not custom".
 */
import { createHash } from 'node:crypto'
import {
  type AutoTuneApplyResult,
  type AutoTuneNodeInput,
  type AutoTunePhaseResult,
  type AutoTunePlan,
  type AutoTuneWarning,
  type CapacitySource,
  collectModelBoundKeys,
  computeCapacityShares,
  foreignCapacityCells,
  DETECTOR_ACCURACY,
  DEFAULT_CAMERA_FPS,
  DEFAULT_MIN_SESSIONS_PER_DEVICE,
  type HardwareInfo,
  type IScopedLogger,
  MODEL_FORMATS,
  type ModelFormat,
  type NodeInferenceDevices,
  type MeasuredLatency,
  type NodeCapacitySource,
  type NodeMeasuredCapacity,
  type NodeRecommendation,
  type PipelineSchema,
  recommendNode,
  type SuggestSharesResult,
} from '@camstack/types'
import type { AgentSettingsMapBlob } from '../orchestrator-store-schemas.js'
import {
  applyNodeAutoTune,
  type AutoTuneDiffInput,
  DETECTOR_STEP_ID,
  type DetectorTarget,
  keptDeviceKey,
} from './plan-diff.js'

export interface AutoTuneServiceDeps {
  readonly logger: IScopedLogger
  readonly runnerNodeIds: () => readonly string[]
  readonly readNodeDevices: (nodeId: string) => Promise<NodeInferenceDevices>
  readonly readHardware: (nodeId: string) => Promise<HardwareInfo | null>
  readonly readCatalog: (nodeId: string) => Promise<PipelineSchema | null>
  readonly readAgentSettings: () => Promise<AgentSettingsMapBlob>
  readonly rewriteAgentSettings: (
    transform: (prev: AgentSettingsMapBlob) => AgentSettingsMapBlob,
  ) => Promise<void>
  /**
   * The detection rate one session is counted at: the fastest camera that
   * runs the pipeline root; null when no camera does (then 10 fps).
   */
  readonly cameraFps: () => Promise<number | null>
  /** Measured node capacity (node benchmark results) for the `benchmark` share source. */
  readonly measuredCapacity: NodeCapacitySource
  /**
   * Each node's fresh node-benchmark detector measurements (D791) — measured
   * on the node beats the table. Absent / failing = the table alone.
   */
  readonly measuredLatency?: (
    nodeIds: readonly string[],
  ) => Promise<ReadonlyMap<string, MeasuredLatency>>
  readonly downloadModel: (nodeId: string, modelId: string, format: ModelFormat) => Promise<void>
  /** Ids of the custom-registry models (`customModelRegistry.listModels`). Throws when unreadable. */
  readonly readCustomModelIds: () => Promise<ReadonlySet<string>>
  readonly invalidateCatalog: () => void
  readonly redispatch: (nodeId: string) => Promise<void>
  readonly now: () => number
}

interface PlanInternals {
  readonly plan: AutoTunePlan
  readonly diffInput: AutoTuneDiffInput
  /** nodeId → (deviceKey → format) of every recommended device. */
  readonly formats: ReadonlyMap<string, ReadonlyMap<string, ModelFormat>>
}

function minSessionsOf(input: { readonly minSessionsPerDevice?: number }): number {
  return input.minSessionsPerDevice ?? DEFAULT_MIN_SESSIONS_PER_DEVICE
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Canonical JSON (sorted keys) — the plan hash must not depend on key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (typeof value === 'object' && value !== null) {
    const entries = Object.entries(value)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`
  }
  return JSON.stringify(value)
}

function formatsByModelOf(catalog: PipelineSchema | null): Record<string, readonly ModelFormat[]> {
  const out: Record<string, readonly ModelFormat[]> = {}
  for (const slot of catalog?.slots ?? []) {
    for (const addon of slot.addons) {
      if (addon.id !== DETECTOR_STEP_ID) continue
      for (const model of addon.models) {
        out[model.id] = MODEL_FORMATS.filter((f) => f in model.formats)
      }
    }
  }
  return out
}

function boundKeysOf(
  catalogs: readonly (PipelineSchema | null)[],
): Record<string, readonly string[]> {
  const byStep = new Map<string, Set<string>>()
  for (const catalog of catalogs) {
    for (const slot of catalog?.slots ?? []) {
      for (const addon of slot.addons) {
        const keys = collectModelBoundKeys(addon.configSchema ?? [])
        if (keys.length === 0) continue
        const set = byStep.get(addon.id) ?? new Set<string>()
        for (const k of keys) set.add(k)
        byStep.set(addon.id, set)
      }
    }
  }
  return Object.fromEntries([...byStep].map(([step, set]) => [step, [...set].toSorted()]))
}

interface Recommended {
  readonly gathered: readonly GatheredNode[]
  readonly nodes: readonly AutoTuneNodeInput[]
  readonly recommendations: readonly NodeRecommendation[]
  readonly cameraFps: number
}

interface GatheredNode {
  readonly nodeId: string
  readonly devices: NodeInferenceDevices
  readonly hardware: HardwareInfo | null
  readonly catalog: PipelineSchema | null
}

/** `node|deviceKey → custom model` of every stored root-detector pin to a custom model. */
function storedCustomPins(
  agent: AgentSettingsMapBlob,
  isCustomModel: (modelId: string) => boolean,
): ReadonlyMap<string, string> {
  const out = new Map<string, string>()
  for (const [nodeId, entry] of Object.entries(agent)) {
    for (const [deviceKey, device] of Object.entries(entry?.inferenceDevices ?? {})) {
      const modelId = device?.steps?.[DETECTOR_STEP_ID]?.modelId
      if (modelId !== undefined && isCustomModel(modelId)) {
        out.set(keptDeviceKey(nodeId, deviceKey), modelId)
      }
    }
  }
  return out
}

export class AutoTuneService {
  private applying = false

  constructor(private readonly deps: AutoTuneServiceDeps) {}

  async plan(input: {
    readonly headroom: number
    readonly minSessionsPerDevice?: number
  }): Promise<AutoTunePlan> {
    return (await this.computePlan(input.headroom, minSessionsOf(input))).plan
  }

  /**
   * Shares proportional to each node's capacity in parallel sessions (D755):
   * from the latency table at the models Auto tune picks at its defaults
   * (`hardware`), or from node benchmark results (`benchmark`), a node
   * without results falling back to `hardware` and saying so. ONE pass, and
   * nothing but capacity goes in — the automatic shares are exactly this.
   * Per device it reports an ADVISORY session cap — never written, never
   * enforced.
   */
  async suggestShares(input: {
    readonly headroom: number
    readonly source?: CapacitySource
  }): Promise<SuggestSharesResult> {
    const source = input.source ?? 'hardware'
    const minSessionsPerDevice = DEFAULT_MIN_SESSIONS_PER_DEVICE
    const rec = await this.recommend(input.headroom, minSessionsPerDevice)
    let measured: ReadonlyMap<string, NodeMeasuredCapacity> = new Map()
    if (source === 'benchmark') {
      try {
        measured = await this.deps.measuredCapacity.readMeasuredCapacity(
          rec.recommendations.map((r) => r.nodeId),
        )
      } catch (err: unknown) {
        // Unreadable results are no results: every node says it fell back.
        this.deps.logger.warn(
          'load balancing: benchmark results unreadable — sized from hardware',
          {
            meta: { error: errMsg(err) },
          },
        )
      }
    }
    this.noteForeignCells(rec.recommendations, measured)
    return computeCapacityShares({
      recommendations: rec.recommendations,
      source,
      measured,
      headroom: input.headroom,
      cameraFps: rec.cameraFps,
      minSessionsPerDevice,
    })
  }

  /** Foreign-model cells already reported, so a recompute does not repeat the line. */
  private readonly reportedForeign = new Set<string>()

  /**
   * A measured cell for a model the device does not run now is ignored by the
   * shares (D913 follow-up); say so ONCE per (node, device, models), with the
   * device key — silence would read as "measured and used".
   */
  private noteForeignCells(
    recommendations: readonly NodeRecommendation[],
    measured: ReadonlyMap<string, NodeMeasuredCapacity>,
  ): void {
    for (const cell of foreignCapacityCells(recommendations, measured)) {
      const key = `${cell.nodeId}|${cell.deviceKey}|${cell.measuredModelId}|${cell.runsModelId ?? ''}`
      if (this.reportedForeign.has(key)) continue
      this.reportedForeign.add(key)
      this.deps.logger.info('load balancing: benchmark cell for another model ignored', {
        tags: { nodeId: cell.nodeId },
        meta: {
          deviceKey: cell.deviceKey,
          measuredModelId: cell.measuredModelId,
          runsModelId: cell.runsModelId,
        },
      })
    }
  }

  /**
   * Gather every node and recommend. Nothing but hardware, catalog, the sizing
   * and — for a plan — the custom pins goes in. `customPins` maps
   * `node|deviceKey` to the custom model pinned there; shares pass none
   * (capacity is a property of the hardware, not of what it runs).
   */
  private async recommend(
    headroom: number,
    minSessionsPerDevice: number,
    customPins: ReadonlyMap<string, string> = new Map(),
  ): Promise<Recommended> {
    const nodeIds = [...new Set(['hub', ...this.deps.runnerNodeIds()])].toSorted()
    const gathered = await Promise.all(
      nodeIds.map(async (nodeId) => {
        const [devices, hardware, catalog] = await Promise.all([
          this.deps.readNodeDevices(nodeId),
          this.deps.readHardware(nodeId).catch(() => null),
          this.deps.readCatalog(nodeId).catch(() => null),
        ])
        return { nodeId, devices, hardware, catalog }
      }),
    )
    const nodes: AutoTuneNodeInput[] = gathered.map((g) => ({
      nodeId: g.nodeId,
      // A node whose catalog never answered cannot be told which builds exist.
      reachable: g.devices.reachable && g.catalog !== null,
      hardware: g.hardware,
      devices: g.devices.devices.map((d) => {
        const pinned = customPins.get(keptDeviceKey(g.nodeId, d.key))
        return {
          key: d.key,
          format: d.format,
          enabled: d.enabled,
          available: d.available,
          ...(pinned !== undefined ? { customPinModelId: pinned } : {}),
        }
      }),
      formatsByModel: formatsByModelOf(g.catalog),
    }))
    const observedFps = await this.deps.cameraFps()
    const cameraFps = observedFps !== null && observedFps > 0 ? observedFps : DEFAULT_CAMERA_FPS
    let measured: ReadonlyMap<string, MeasuredLatency> = new Map()
    try {
      measured = (await this.deps.measuredLatency?.(nodeIds)) ?? new Map()
    } catch (err: unknown) {
      this.deps.logger.warn('auto tune: node benchmark results unreadable — the table decides', {
        meta: { error: errMsg(err) },
      })
    }
    const recommendations: NodeRecommendation[] = nodes.map((node) => {
      const own = measured.get(node.nodeId)
      return recommendNode({
        node,
        headroom,
        minSessionsPerDevice,
        cameraFps,
        ...(own !== undefined ? { measured: own } : {}),
      })
    })
    return { gathered, nodes, recommendations, cameraFps }
  }

  private async computePlan(
    headroom: number,
    minSessionsPerDevice: number,
  ): Promise<PlanInternals> {
    const warnings: AutoTuneWarning[] = []
    const isCustomModel = await this.customModelPredicate(warnings)
    const agentSettings = await this.deps.readAgentSettings()
    const customPins = storedCustomPins(agentSettings, isCustomModel)
    const { gathered, nodes, recommendations, cameraFps } = await this.recommend(
      headroom,
      minSessionsPerDevice,
      customPins,
    )

    const touchedNodes = new Set(recommendations.filter((r) => !r.skipped).map((r) => r.nodeId))
    const targets = new Map<string, readonly DetectorTarget[]>()
    const formats = new Map<string, Map<string, ModelFormat>>()
    for (const rec of recommendations) {
      if (rec.skipped) continue
      const node = nodes.find((n) => n.nodeId === rec.nodeId)
      const list: DetectorTarget[] = []
      const byKey = new Map<string, ModelFormat>()
      for (const d of rec.devices) {
        if (d.chosen === null) continue
        list.push({
          deviceKey: d.deviceKey,
          modelId: d.chosen.modelId,
          effectiveEnabled: d.enabled,
        })
        const format = node?.devices.find((x) => x.key === d.deviceKey)?.format
        if (format !== undefined) byKey.set(d.deviceKey, format)
      }
      targets.set(rec.nodeId, list)
      formats.set(rec.nodeId, byKey)
    }
    // Kept: every stored custom pin (enabled or not — its thresholds are the
    // fine-tune's), plus every device the recommender kept with its group.
    const keptDevices = new Set<string>(customPins.keys())
    for (const rec of recommendations) {
      for (const d of rec.devices) {
        if (d.kept !== undefined) keptDevices.add(keptDeviceKey(rec.nodeId, d.deviceKey))
      }
    }
    const diffInput: AutoTuneDiffInput = {
      touchedNodes,
      targets,
      boundKeysByStep: boundKeysOf(gathered.map((g) => g.catalog)),
      keptDevices,
      isCustomModel,
    }
    const nodeChanges = applyNodeAutoTune(agentSettings, diffInput).changes
    for (const [key, modelId] of [...customPins].toSorted(([a], [b]) => a.localeCompare(b))) {
      const [nodeId = '', deviceKey = ''] = key.split('|')
      warnings.push({ kind: 'custom-pin-kept', nodeId, deviceKey, modelId })
    }

    const planHash = createHash('sha256')
      .update(
        canonical({
          version: 3,
          headroom,
          minSessionsPerDevice,
          cameraFps,
          picks: recommendations.map((r) => ({
            nodeId: r.nodeId,
            skipped: r.skipped,
            devices: r.devices.map((d) => [d.deviceKey, d.chosen?.modelId ?? null, d.kept ?? null]),
          })),
          nodeChanges,
        }),
      )
      .digest('hex')
    return {
      plan: {
        planHash,
        family: 'yolov9',
        headroom,
        minSessionsPerDevice,
        cameraFps,
        generatedAt: this.deps.now(),
        nodes: recommendations,
        nodeChanges: [...nodeChanges],
        warnings,
      },
      diffInput,
      formats,
    }
  }

  /**
   * "Is this model custom?" from the registry. A registry that does not
   * answer is NOT an empty registry: every pin outside the measured catalog
   * is then treated as custom, and the plan says so.
   */
  private async customModelPredicate(
    warnings: AutoTuneWarning[],
  ): Promise<(modelId: string) => boolean> {
    try {
      const ids = await this.deps.readCustomModelIds()
      return (modelId) => ids.has(modelId)
    } catch (err: unknown) {
      const error = errMsg(err)
      this.deps.logger.warn(
        'auto tune: custom-model registry unreadable — every pin outside the measured catalog is kept',
        { meta: { error } },
      )
      warnings.push({ kind: 'custom-registry-unreadable', error })
      return (modelId) => !(modelId in DETECTOR_ACCURACY)
    }
  }

  async apply(input: {
    readonly planHash: string
    readonly headroom: number
    readonly minSessionsPerDevice?: number
  }): Promise<AutoTuneApplyResult> {
    if (this.applying) return { kind: 'refused', reason: 'apply-in-progress' }
    this.applying = true
    try {
      return await this.applyLocked(input)
    } finally {
      this.applying = false
    }
  }

  private async applyLocked(input: {
    readonly planHash: string
    readonly headroom: number
    readonly minSessionsPerDevice?: number
  }): Promise<AutoTuneApplyResult> {
    const { plan, diffInput, formats } = await this.computePlan(
      input.headroom,
      minSessionsOf(input),
    )
    if (plan.planHash !== input.planHash) {
      this.deps.logger.warn('auto tune: stale plan refused', {
        meta: { confirmed: input.planHash, current: plan.planHash },
      })
      return { kind: 'stale', plan }
    }
    const phases: AutoTunePhaseResult[] = []

    // 1. Downloads first: no node switches to a model it does not have.
    const downloads = plan.nodeChanges.flatMap((c) =>
      c.modelPins
        .filter((p) => p.stepId === DETECTOR_STEP_ID && p.after !== null && p.after !== p.before)
        .map((p) => ({
          nodeId: c.nodeId,
          modelId: p.after ?? '',
          format: formats.get(c.nodeId)?.get(c.deviceKey),
        })),
    )
    const unique = new Map(downloads.map((d) => [`${d.nodeId}|${d.modelId}|${d.format}`, d]))
    try {
      for (const d of unique.values()) {
        if (d.format === undefined) continue
        await this.deps.downloadModel(d.nodeId, d.modelId, d.format)
      }
      phases.push({
        phase: 'download',
        ok: true,
        detail: `${unique.size} model(s) present on their nodes`,
      })
    } catch (err: unknown) {
      phases.push({ phase: 'download', ok: false, detail: errMsg(err) })
      this.deps.logger.warn('auto tune: a model download failed — nothing was written', {
        meta: { error: errMsg(err) },
      })
      return { kind: 'aborted', phases }
    }

    // 2. Node model pins and thresholds.
    try {
      await this.deps.rewriteAgentSettings((prev) => applyNodeAutoTune(prev, diffInput).next)
      for (const c of plan.nodeChanges) {
        for (const pin of c.modelPins) {
          this.deps.logger.info('auto tune: node model set', {
            tags: { nodeId: c.nodeId },
            meta: {
              nodeId: c.nodeId,
              deviceKey: c.deviceKey,
              stepId: pin.stepId,
              from: pin.before,
              to: pin.after,
            },
          })
        }
      }
      phases.push({
        phase: 'node-models',
        ok: true,
        detail: `${plan.nodeChanges.length} device(s) updated`,
      })
    } catch (err: unknown) {
      phases.push({ phase: 'node-models', ok: false, detail: errMsg(err) })
    }

    // 3. Re-dispatch so the change takes effect now.
    this.deps.invalidateCatalog()
    const failed: string[] = []
    for (const nodeId of [...diffInput.touchedNodes].toSorted()) {
      try {
        await this.deps.redispatch(nodeId)
      } catch (err: unknown) {
        failed.push(`${nodeId}: ${errMsg(err)}`)
      }
    }
    phases.push({
      phase: 'redispatch',
      ok: failed.length === 0,
      detail: failed.length === 0 ? `${diffInput.touchedNodes.size} node(s)` : failed.join('; '),
    })
    for (const rec of plan.nodes.filter((r) => r.skipped)) {
      this.deps.logger.info('auto tune: node skipped', {
        tags: { nodeId: rec.nodeId },
        meta: { nodeId: rec.nodeId, reasons: rec.reasons },
      })
    }
    this.deps.logger.info('auto tune: applied', {
      meta: {
        planHash: plan.planHash,
        nodeChanges: plan.nodeChanges.length,
        phases,
      },
    })
    return { kind: 'applied', planHash: plan.planHash, phases }
  }
}
