/**
 * The automatic node benchmark: an enabled, available device that has no
 * measured result — a new node, or a device discovered later — is measured by
 * a `device`-phase run limited to it, so the automatic shares read a number
 * instead of the table without the operator starting anything.
 *
 *  - ONE auto run at a time, and never while any benchmark runs (the service
 *    allows one run cluster-wide);
 *  - a node that is busy is deferred: it carries more than
 *    {@link AUTO_BENCH_MAX_CAMERAS_ON_NODE} cameras (a benchmark moves them
 *    off and a camera with no other frame source would stay and spoil the
 *    numbers). The hub, which usually carries cameras, waits until it is quiet
 *    and the operator can still run it by hand;
 *  - a failed run is retried at most {@link AUTO_BENCH_MAX_ATTEMPTS} times,
 *    {@link AUTO_BENCH_RETRY_MS} apart. The ledger is persisted per (node,
 *    device) and restored at boot — a respawn right after a lost run would
 *    otherwise start the next one at once and hand the device a fresh budget;
 *    a device that gains a usable result is forgotten;
 *  - never for a device the operator disabled, one that is unplugged or
 *    excluded, or one that already has a usable result: a fresh cell for the
 *    model it runs NOW (the predicate the automatic shares read, so the two
 *    cannot disagree). A result for another model does not count — the device
 *    is measured again.
 *
 * The planner is pure; the scheduler injects every read and the start.
 */
import {
  capacityForModel,
  errMsg,
  type IScopedLogger,
  type NodeMeasuredCapacity,
  type NodeBenchmarkPlanInput,
  type NodeBenchmarkPreflight,
} from '@camstack/types'

/** The model a device runs now, per Auto tune (the shares' own pick). */
export interface DeviceRunsModel {
  readonly nodeId: string
  readonly deviceKey: string
  readonly modelId: string | null
}

/**
 * `nodeId\0deviceKey` of every device that has a usable result: a fresh
 * measurement for the model it runs now. The SAME predicate
 * ({@link capacityForModel}) the automatic shares size a node by.
 */
export function benchmarkedDevices(
  runs: readonly DeviceRunsModel[],
  measured: ReadonlyMap<string, NodeMeasuredCapacity>,
): ReadonlySet<string> {
  const out = new Set<string>()
  for (const run of runs) {
    if (capacityForModel(measured.get(run.nodeId), run.deviceKey, run.modelId) !== undefined) {
      out.add(benchKey(run.nodeId, run.deviceKey))
    }
  }
  return out
}

/** A node carrying more cameras than this is busy; a benchmark would move them all. */
export const AUTO_BENCH_MAX_CAMERAS_ON_NODE = 2
/** A failed or empty run is not retried sooner than this. */
export const AUTO_BENCH_RETRY_MS = 15 * 60_000
/** Runs started for one device before the scheduler gives up on it. */
export const AUTO_BENCH_MAX_ATTEMPTS = 3
/** How often the scheduler looks (it is also nudged when a device set changes). */
export const AUTO_BENCH_TICK_MS = 60_000
/** Hard deadline of an auto run (a one-model device ramp takes well under this). */
const AUTO_BENCH_BUDGET_MINUTES = 20

export interface AutoBenchDevice {
  readonly key: string
  readonly available: boolean
  /** Why the dispatcher drops it; `null` = a candidate. `disabled` = the operator's switch. */
  readonly exclusion: string | null
}

export interface AutoBenchNode {
  readonly nodeId: string
  readonly online: boolean
  /** Cameras placed on the node now (standing attaches and running sessions). */
  readonly camerasOnNode: number
  readonly devices: readonly AutoBenchDevice[]
}

export interface AutoBenchAttempt {
  readonly count: number
  readonly lastAtMs: number
}

export interface AutoBenchInput {
  readonly nodes: readonly AutoBenchNode[]
  /** `nodeId\0deviceKey` pairs with a usable result (see {@link benchmarkedDevices}). */
  readonly benchmarked: ReadonlySet<string>
  /** Any benchmark (manual or auto) is running or its mode is on. */
  readonly runActive: boolean
  readonly attempts: ReadonlyMap<string, AutoBenchAttempt>
  readonly nowMs: number
}

export type AutoBenchSkipReason = 'not-eligible' | 'has-results' | 'gave-up'
export type AutoBenchWaitReason = 'run-active' | 'node-offline' | 'node-busy' | 'retry-later'

export type AutoBenchDecision =
  | {
      readonly kind: 'skip'
      readonly nodeId: string
      readonly deviceKey: string
      readonly reason: AutoBenchSkipReason
    }
  | {
      readonly kind: 'wait'
      readonly nodeId: string
      readonly deviceKey: string
      readonly reason: AutoBenchWaitReason
    }
  | { readonly kind: 'start'; readonly nodeId: string; readonly deviceKey: string }

export interface AutoBenchStart {
  readonly nodeId: string
  readonly deviceKeys: readonly string[]
}

export interface AutoBenchPlan {
  readonly decisions: readonly AutoBenchDecision[]
  /** The one run to start now, or null. */
  readonly start: AutoBenchStart | null
}

export function benchKey(nodeId: string, deviceKey: string): string {
  return `${nodeId}\u0000${deviceKey}`
}

export function planAutoBenchmark(input: AutoBenchInput): AutoBenchPlan {
  const decisions: AutoBenchDecision[] = []
  let start: AutoBenchStart | null = null
  for (const node of input.nodes.toSorted((a, b) => a.nodeId.localeCompare(b.nodeId))) {
    const ready: string[] = []
    for (const device of node.devices.toSorted((a, b) => a.key.localeCompare(b.key))) {
      const base = { nodeId: node.nodeId, deviceKey: device.key }
      if (!device.available || device.exclusion !== null) {
        decisions.push({ kind: 'skip', ...base, reason: 'not-eligible' })
        continue
      }
      const key = benchKey(node.nodeId, device.key)
      if (input.benchmarked.has(key)) {
        decisions.push({ kind: 'skip', ...base, reason: 'has-results' })
        continue
      }
      const attempt = input.attempts.get(key)
      if (attempt !== undefined && attempt.count >= AUTO_BENCH_MAX_ATTEMPTS) {
        decisions.push({ kind: 'skip', ...base, reason: 'gave-up' })
        continue
      }
      if (input.runActive || start !== null) {
        decisions.push({ kind: 'wait', ...base, reason: 'run-active' })
      } else if (!node.online) {
        decisions.push({ kind: 'wait', ...base, reason: 'node-offline' })
      } else if (node.camerasOnNode > AUTO_BENCH_MAX_CAMERAS_ON_NODE) {
        decisions.push({ kind: 'wait', ...base, reason: 'node-busy' })
      } else if (attempt !== undefined && input.nowMs - attempt.lastAtMs < AUTO_BENCH_RETRY_MS) {
        decisions.push({ kind: 'wait', ...base, reason: 'retry-later' })
      } else {
        ready.push(device.key)
        decisions.push({ kind: 'start', ...base })
      }
    }
    if (ready.length > 0 && start === null) start = { nodeId: node.nodeId, deviceKeys: ready }
  }
  return { decisions, start }
}

/** What {@link readAutoBenchNodes} reads; every source answers without a network call. */
export interface AutoBenchNodeSource {
  readonly onlineNodeIds: readonly string[]
  /** The node's live device set from its last probe; `undefined` = never probed. */
  readonly liveDevices: (nodeId: string) => readonly AutoBenchDevice[] | undefined
  /**
   * Ask a never-probed node for its devices, in the background. Its answer
   * reaches the scheduler through the orchestrator's device-set change path.
   */
  readonly requestProbe: (nodeId: string) => void
  readonly camerasOn: (nodeId: string) => Promise<number>
}

/**
 * The scheduler's view of every online node. A node whose devices were never
 * probed contributes none THIS look and is asked for them: the probe cache is
 * otherwise filled only by a reader that asks (placement, the devices page),
 * and on a fresh install with no camera nothing asks — the scheduler then saw
 * `devices: []` on every node forever and never started (CT200, 2026-10-23).
 */
export async function readAutoBenchNodes(
  source: AutoBenchNodeSource,
): Promise<readonly AutoBenchNode[]> {
  return Promise.all(
    source.onlineNodeIds.map(async (nodeId) => {
      const devices = source.liveDevices(nodeId)
      if (devices === undefined) source.requestProbe(nodeId)
      return {
        nodeId,
        online: true,
        camerasOnNode: await source.camerasOn(nodeId),
        devices: devices ?? [],
      }
    }),
  )
}

/** Where the attempt ledger survives a restart (`nodeId\0deviceKey` keys). */
export interface AutoBenchAttemptPersistence {
  readonly load: () => Promise<ReadonlyMap<string, AutoBenchAttempt>>
  readonly save: (attempts: ReadonlyMap<string, AutoBenchAttempt>) => Promise<void>
}

export interface AutoBenchmarkDeps {
  readonly logger: IScopedLogger
  /** Every online node's live devices and load, from reads that make no network call. */
  readonly readNodes: () => Promise<readonly AutoBenchNode[]>
  readonly benchmarked: () => Promise<ReadonlySet<string>>
  readonly runActive: () => boolean
  /** deviceKey → the detector to measure (Auto tune's pick first); absent = none to offer. */
  readonly pickModels: (
    nodeId: string,
    deviceKeys: readonly string[],
  ) => Promise<Readonly<Record<string, string>>>
  readonly start: (
    plan: NodeBenchmarkPlanInput,
  ) => Promise<
    | { readonly kind: 'started'; readonly runId: string }
    | { readonly kind: 'refused'; readonly preflight: NodeBenchmarkPreflight }
  >
  readonly now?: () => number
  /** Absent = in memory only. */
  readonly persistence?: AutoBenchAttemptPersistence
}

export class AutoBenchmarkScheduler {
  private readonly attempts = new Map<string, AutoBenchAttempt>()
  /** The last decision logged per (node, device): a decision is logged when it CHANGES. */
  private readonly lastLogged = new Map<string, string>()
  private restored: Promise<void> | null = null
  private inFlight: Promise<void> | null = null
  /** A nudge that arrived while a look ran: one more look follows it. */
  private rerun: string | null = null
  private timer: ReturnType<typeof setInterval> | null = null

  constructor(private readonly deps: AutoBenchmarkDeps) {}

  start(): void {
    if (this.timer !== null) return
    this.timer = setInterval(() => {
      void this.tick('tick')
    }, AUTO_BENCH_TICK_MS)
    this.timer.unref?.()
  }

  stop(): void {
    if (this.timer !== null) clearInterval(this.timer)
    this.timer = null
  }

  /**
   * Look now (single-flight). A call while one runs is folded into ONE more
   * look right after it: a device-set change that lands mid-look (a node's
   * first probe answering) must not wait for the next minute's tick.
   */
  tick(trigger: string): Promise<void> {
    if (this.inFlight !== null) {
      this.rerun = trigger
      return this.inFlight
    }
    this.inFlight = this.run(trigger)
      .catch((err: unknown) => {
        this.deps.logger.warn('auto benchmark: tick failed — retried on the next', {
          meta: { trigger, error: errMsg(err) },
        })
      })
      .finally(() => {
        this.inFlight = null
      })
      .then(() => {
        const next = this.rerun
        this.rerun = null
        return next === null ? undefined : this.tick(next)
      })
    return this.inFlight
  }

  /** Load the persisted ledger ONCE, before the first decision; a failed read is a fresh budget, said so. */
  private restore(): Promise<void> {
    this.restored ??= (async () => {
      const persistence = this.deps.persistence
      if (persistence === undefined) return
      try {
        for (const [key, attempt] of await persistence.load()) {
          if (!this.attempts.has(key)) this.attempts.set(key, attempt)
        }
        this.deps.logger.info('auto benchmark: attempts restored', {
          meta: { devices: this.attempts.size },
        })
      } catch (err: unknown) {
        this.deps.logger.warn('auto benchmark: attempt ledger unreadable — starting with none', {
          meta: { error: errMsg(err) },
        })
      }
    })()
    return this.restored
  }

  private async persist(): Promise<void> {
    try {
      await this.deps.persistence?.save(this.attempts)
    } catch (err: unknown) {
      this.deps.logger.warn('auto benchmark: attempt ledger not saved — kept in memory', {
        meta: { error: errMsg(err) },
      })
    }
  }

  private note(decision: AutoBenchDecision, extra: string = ''): void {
    const signature = `${decision.kind}:${'reason' in decision ? decision.reason : ''}${extra}`
    const key = benchKey(decision.nodeId, decision.deviceKey)
    if (this.lastLogged.get(key) === signature) return
    this.lastLogged.set(key, signature)
    const quiet =
      decision.kind === 'skip' &&
      (decision.reason === 'has-results' || decision.reason === 'not-eligible')
    const log = quiet
      ? this.deps.logger.debug.bind(this.deps.logger)
      : this.deps.logger.info.bind(this.deps.logger)
    log(`auto benchmark: ${decision.kind}`, {
      tags: { nodeId: decision.nodeId },
      meta: {
        deviceKey: decision.deviceKey,
        ...('reason' in decision ? { reason: decision.reason } : {}),
        ...(extra !== '' ? { detail: extra } : {}),
      },
    })
  }

  private async run(trigger: string): Promise<void> {
    const nowMs = this.deps.now?.() ?? Date.now()
    await this.restore()
    const plan = planAutoBenchmark({
      nodes: await this.deps.readNodes(),
      benchmarked: await this.deps.benchmarked(),
      runActive: this.deps.runActive(),
      attempts: this.attempts,
      nowMs,
    })
    let forgot = false
    for (const decision of plan.decisions) {
      if (decision.kind !== 'start') this.note(decision)
      if (decision.kind === 'skip' && decision.reason === 'has-results') {
        forgot = this.attempts.delete(benchKey(decision.nodeId, decision.deviceKey)) || forgot
      }
    }
    if (forgot) await this.persist()
    if (plan.start === null) return
    const { nodeId, deviceKeys } = plan.start
    const models = await this.deps.pickModels(nodeId, deviceKeys)
    const devices = deviceKeys.flatMap((deviceKey) => {
      const modelId = models[deviceKey]
      return modelId === undefined ? [] : [{ deviceKey, modelIds: [modelId] }]
    })
    if (devices.length === 0) {
      for (const deviceKey of deviceKeys) {
        this.note(
          { kind: 'wait', nodeId, deviceKey, reason: 'retry-later' },
          'no detector to offer',
        )
      }
      return
    }
    const outcome = await this.deps.start({
      nodeId,
      devices,
      phases: ['device'],
      steps: [],
      budgetMinutes: AUTO_BENCH_BUDGET_MINUTES,
      acceptInsufficientHeadroom: false,
    })
    if (outcome.kind === 'refused') {
      const why = outcome.preflight.refusals.map((r) => r.kind).join(',')
      for (const { deviceKey } of devices) {
        this.note({ kind: 'wait', nodeId, deviceKey, reason: 'retry-later' }, `refused: ${why}`)
      }
      return
    }
    for (const { deviceKey } of devices) {
      const key = benchKey(nodeId, deviceKey)
      this.attempts.set(key, { count: (this.attempts.get(key)?.count ?? 0) + 1, lastAtMs: nowMs })
      this.lastLogged.delete(key)
      await this.persist()
      this.deps.logger.info('auto benchmark: started', {
        tags: { nodeId },
        meta: {
          deviceKey,
          runId: outcome.runId,
          attempt: this.attempts.get(key)?.count ?? 1,
          trigger,
        },
      })
    }
  }
}
