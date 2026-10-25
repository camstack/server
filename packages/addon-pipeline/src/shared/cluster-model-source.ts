/**
 * Where the runner gets the ONE cluster model choice per cluster-scoped step.
 *
 * The sibling of `crop-convention-source.ts`, and deliberately built the same
 * way, because it answers the neighbouring half of the same question: the crop
 * convention decides WHAT pixels the encoder sees, this decides WHICH encoder
 * sees them. Both are cluster-wide, both are read by the runner from the
 * `pipeline-orchestrator` global settings over the hub-routed `addon-settings`
 * cap, both pass NO `nodeId`.
 *
 * ## Deliberately NOT node-scoped, and not on the attach config
 *
 * With a `nodeId` the settings cap would project that node's scoped value and
 * two nodes could embed into one index with two encoders — the original defect,
 * relocated to the transport. And the attach config is the wrong carrier for
 * the same reason it was wrong for the crop: eleven builders construct a
 * `RunnerCameraConfig`, a cluster-wide constant threaded through eleven
 * builders eventually reaches ten of them, and the cameras attached by the
 * forgotten one quietly write a foreign feature space into the shared index.
 *
 * ## Why the failure mode keeps the last value — and refuses before the first
 *
 * A failed read must never revert to the registry default MID-PASS: that would
 * silently change what every remaining vector of that dispatch means, which is
 * the exact class of harm the scope exists to prevent. So a failure keeps the
 * last known row and says so, once per change. Before the FIRST answer there is
 * no row to keep: the step is refused by name (D658) — a default run then made
 * the default model the pool's active variant for the process lifetime.
 */
import {
  CLUSTER_MODEL_SCOPED_STEPS,
  type ClusterModelChoice,
  type ClusterStepModels,
  type ClusterStepSettings,
  DEFAULT_CLUSTER_STEP_SETTINGS,
  type HydratedClusterView,
  type IScopedLogger,
  pickClusterStepSettings,
} from '@camstack/types'

/**
 * The addon whose GLOBAL settings own the cluster row. Same owner as the crop
 * convention and the native-frame lease: hub-resident and neutral between the
 * addons that read it (post-analysis pins it for a re-embed pass, the runner
 * enforces it live — neither should own a value the other depends on).
 */
export const CLUSTER_MODEL_OWNER_ADDON_ID = 'pipeline-orchestrator'

/**
 * How long a read is trusted.
 *
 * A detail dispatch is per-TRACK, not per-frame, so a minute of staleness is at
 * most a minute of vectors written with the previous encoder after an operator
 * flip — and those vectors are stamped with the model that made them
 * ([D196](../../../../docs/decisions/index.md)), so they are identifiable and
 * re-embeddable rather than silently mixed. That stamp is what makes a TTL
 * acceptable here at all.
 */
export const CLUSTER_MODEL_TTL_MS = 60_000

/**
 * How soon a step whose model is still UNKNOWN is asked again. Short, because
 * every cluster-scoped dispatch is refused until then (D658); bounded, because
 * an owner that is restarting must not be asked at dispatch rate.
 */
export const CLUSTER_MODEL_UNKNOWN_RETRY_MS = 5_000

/**
 * The hub-routed reads, structurally typed so tests can fake them.
 *
 * The MODEL comes from the owner's three-way answer
 * (`pipelineOrchestrator.getClusterModelChoice`, D651): a written choice, a key
 * nobody wrote, or NO answer. `getGlobalSettings` cannot say the third — it
 * hydrates an unread or restarting store as `{}`, i.e. as "the defaults" — and
 * that is how a runner that booted while the owner restarted ran the registry
 * default for its whole life (D658). The step KNOBS still come from the
 * hydrated view: a knob falling back to its default changes an admission floor,
 * not a feature space.
 */
export interface ClusterModelSettingsApi {
  readonly addonSettings: {
    readonly getGlobalSettings: {
      query(input: { addonId: string }): Promise<HydratedClusterView | null>
    }
  }
  readonly pipelineOrchestrator: {
    readonly getClusterModelChoice: {
      query(input: { stepId: string }): Promise<ClusterModelChoice>
    }
  }
}

export interface ClusterModelSourceOptions {
  readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  /** Injected clock — the TTL is otherwise untestable without sleeping. */
  readonly now?: () => number
  readonly ttlMs?: number
  readonly unknownRetryMs?: number
}

/** Why a step's model is not known, as the last ask of the owner answered. */
export type ClusterModelUnknownReason = string

/**
 * TTL-cached read of the cluster model row.
 *
 * A step's model is KNOWN only once the owner has answered for it (`stored` or
 * `absent`). Until then it is UNKNOWN, and a cluster-scoped step is refused by
 * name rather than run with the registry default (D49, D658): a default run
 * during the owner's boot window made that model the pool's active variant for
 * the whole process, and the face default was ArcFace until D651. Once known,
 * an unanswered read keeps the LAST KNOWN model — never reverts to a default.
 */
export class ClusterModelSource {
  private models: Readonly<Record<string, string>> = {}
  private unknown: ReadonlyMap<string, ClusterModelUnknownReason> = new Map(
    CLUSTER_MODEL_SCOPED_STEPS.map((s) => [s.stepId, 'not-yet-asked']),
  )
  private settings: ClusterStepSettings = DEFAULT_CLUSTER_STEP_SETTINGS
  private lastReadAtMs = Number.NEGATIVE_INFINITY
  private inFlight: Promise<void> | null = null
  private readonly logger: Pick<IScopedLogger, 'info' | 'warn'>
  private readonly now: () => number
  private readonly ttlMs: number
  private readonly unknownRetryMs: number
  /** The last "not known" state logged, so it is said once per change. */
  private lastUnknownLogKey = ''

  constructor(options: ClusterModelSourceOptions) {
    this.logger = options.logger
    this.now = options.now ?? (() => Date.now())
    this.ttlMs = options.ttlMs ?? CLUSTER_MODEL_TTL_MS
    this.unknownRetryMs = options.unknownRetryMs ?? CLUSTER_MODEL_UNKNOWN_RETRY_MS
  }

  /**
   * The KNOWN models, `stepId → modelId`. A step absent here is unknown (see
   * {@link unknownSteps}) and must be refused, never defaulted.
   */
  current(): ClusterStepModels {
    return this.models
  }

  /** Cluster-scoped steps whose model the owner has not answered yet, with why. */
  unknownSteps(): ReadonlyMap<string, ClusterModelUnknownReason> {
    return this.unknown
  }

  /** Cluster-scoped step knobs in force right now (admission floors, …). */
  currentSettings(): ClusterStepSettings {
    return this.settings
  }

  /**
   * Re-read if the cached row has expired (sooner while a step is unknown).
   * Concurrent callers share one in-flight read; a failure keeps the LAST
   * KNOWN row.
   */
  async refresh(api: ClusterModelSettingsApi | undefined): Promise<ClusterStepModels> {
    if (api === undefined) return this.models
    const ttl = this.unknown.size > 0 ? Math.min(this.ttlMs, this.unknownRetryMs) : this.ttlMs
    if (this.now() - this.lastReadAtMs < ttl) return this.models
    this.inFlight ??= this.read(api).finally(() => {
      this.inFlight = null
    })
    await this.inFlight
    return this.models
  }

  private async read(api: ClusterModelSettingsApi): Promise<void> {
    this.lastReadAtMs = this.now()
    await Promise.all([this.readModels(api), this.readSettings(api)])
  }

  private async readModels(api: ClusterModelSettingsApi): Promise<void> {
    const answers = await Promise.all(
      CLUSTER_MODEL_SCOPED_STEPS.map(async (step) => ({
        stepId: step.stepId,
        answer: await askOwner(api, step.stepId),
      })),
    )
    const nextModels: Record<string, string> = { ...this.models }
    const nextUnknown = new Map<string, ClusterModelUnknownReason>()
    const unanswered: Array<{ stepId: string; reason: string; keeping: string | null }> = []
    for (const { stepId, answer } of answers) {
      if (answer.kind === 'model') {
        nextModels[stepId] = answer.modelId
        continue
      }
      // No answer: the last KNOWN model stays; a step never known stays unknown.
      const keeping = this.models[stepId] ?? null
      unanswered.push({ stepId, reason: answer.reason, keeping })
      if (keeping === null) nextUnknown.set(stepId, answer.reason)
    }
    const changed = Object.keys(nextModels).filter(
      (stepId) => this.models[stepId] !== undefined && nextModels[stepId] !== this.models[stepId],
    )
    if (changed.length > 0) {
      // The one line that anchors "recognition changed on Tuesday" to a cause.
      this.logger.info(
        'cluster step model changed — vectors already stored by the previous model need a re-embed pass',
        {
          meta: {
            changed: changed.map((stepId) => ({
              stepId,
              from: this.models[stepId],
              to: nextModels[stepId],
            })),
          },
        },
      )
    }
    const learned = Object.keys(nextModels).filter((stepId) => this.models[stepId] === undefined)
    if (learned.length > 0) {
      this.logger.info('cluster step model known — cluster-scoped steps run it', {
        meta: { known: Object.fromEntries(learned.map((id) => [id, nextModels[id]])) },
      })
    }
    this.models = nextModels
    this.unknown = nextUnknown
    this.reportUnanswered(unanswered)
  }

  /** Once per change of the unanswered set — never once per retry. */
  private reportUnanswered(
    unanswered: readonly { stepId: string; reason: string; keeping: string | null }[],
  ): void {
    const key = JSON.stringify(unanswered)
    if (key === this.lastUnknownLogKey) return
    this.lastUnknownLogKey = key
    if (unanswered.length === 0) return
    this.logger.warn(
      'cluster step model not answered by its owner — a step never known is REFUSED, a known one keeps its last model',
      {
        meta: {
          owner: CLUSTER_MODEL_OWNER_ADDON_ID,
          unanswered: unanswered.map((u) => ({
            stepId: u.stepId,
            reason: u.reason,
            ...(u.keeping !== null ? { keeping: u.keeping } : { refused: true }),
          })),
        },
      },
    )
  }

  private async readSettings(api: ClusterModelSettingsApi): Promise<void> {
    let view: HydratedClusterView | null
    try {
      view = await api.addonSettings.getGlobalSettings.query({
        addonId: CLUSTER_MODEL_OWNER_ADDON_ID,
      })
    } catch (err: unknown) {
      this.logger.warn('cluster step settings read failed — keeping the last known knobs', {
        meta: {
          owner: CLUSTER_MODEL_OWNER_ADDON_ID,
          error: err instanceof Error ? err.message : String(err),
        },
      })
      return
    }
    // A null view is the owner mid-boot: no answer, so nothing changes (D49).
    if (view === null) return
    const nextSettings = pickClusterStepSettings(view)
    const settingsChanged = Object.keys(nextSettings).some((stepId) => {
      const from = this.settings[stepId] ?? {}
      const to = nextSettings[stepId] ?? {}
      const keys = new Set([...Object.keys(from), ...Object.keys(to)])
      return [...keys].some((key) => from[key] !== to[key])
    })
    if (settingsChanged) {
      this.logger.info('cluster step settings changed', {
        meta: { from: { ...this.settings }, to: { ...nextSettings } },
      })
      this.settings = nextSettings
    }
  }
}

type OwnerAnswer =
  | { readonly kind: 'model'; readonly modelId: string }
  | { readonly kind: 'none'; readonly reason: string }

/** One step's model from the owner's three-way answer; a throw is no answer. */
async function askOwner(api: ClusterModelSettingsApi, stepId: string): Promise<OwnerAnswer> {
  try {
    const choice = await api.pipelineOrchestrator.getClusterModelChoice.query({ stepId })
    switch (choice.kind) {
      case 'stored':
        return { kind: 'model', modelId: choice.modelId }
      case 'absent':
        return { kind: 'model', modelId: choice.defaultModelId }
      case 'unreadable':
        return { kind: 'none', reason: choice.reason }
    }
  } catch (err: unknown) {
    return {
      kind: 'none',
      reason: `read-failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
}
