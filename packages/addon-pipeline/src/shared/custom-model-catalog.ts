/**
 * The step catalog a placement judges: the static catalog MERGED with the
 * operator's custom models (D657 round 2).
 *
 * The one placement rule (`stepModelRunsOnFormat`) is only one rule if every
 * caller hands it the same catalog. The orchestrator judges the schema, which
 * already carries custom models; the executor and the runner judged the static
 * catalog alone, so a custom face or bird model with a tflite build, pinned on
 * a Coral, read as "no build" there and was bounced off the device it was
 * built for.
 *
 * One TTL-cached read of the `custom-model-registry` collection cap, shared by
 * the executor's model resolution and both placement gates. A failed read
 * keeps the previous snapshot (empty on a cold start: the static-catalog-only
 * behaviour) and warns.
 */
import type {
  CustomModelDescriptor,
  IScopedLogger,
  ModelCatalogEntry,
  StepDefinition,
} from '@camstack/types'
import {
  groupCustomModelsByStep,
  mergeCustomModels,
} from '../detection-pipeline/registry/custom-models.js'
import { getStepDefinition } from '../detection-pipeline/registry/step-definitions.js'

/** How long a read of the custom-model registry is trusted. */
export const CUSTOM_MODEL_CATALOG_TTL_MS = 5_000

/** The two cap reads the catalog needs, structurally typed so tests can fake them. */
export interface CustomModelRegistryApi {
  readonly addons: {
    readonly listCapabilityProviders: {
      query(input: { capName: string }): Promise<readonly { readonly isActive: boolean }[]>
    }
  }
  readonly customModelRegistry: {
    readonly listModels: {
      query(): Promise<readonly CustomModelDescriptor[]>
    }
  }
}

/** Custom models grouped by step id. */
export type CustomModelsByStep = ReadonlyMap<string, readonly ModelCatalogEntry[]>

/**
 * A step's definition with its custom models merged in (static wins on an id
 * collision), or `null` for an unknown addonId. Pure.
 */
export function mergedStepDefinition(
  stepId: string,
  customByStep: CustomModelsByStep,
): StepDefinition | null {
  let def: StepDefinition
  try {
    def = getStepDefinition(stepId)
  } catch {
    return null
  }
  const custom = customByStep.get(stepId)
  if (custom === undefined || custom.length === 0) return def
  return { ...def, models: mergeCustomModels(def.models, custom) }
}

/** TTL-cached read of the custom-model registry, with a synchronous merged view. */
export class CustomModelCatalog {
  private byStep: CustomModelsByStep = new Map()
  private readAtMs = Number.NEGATIVE_INFINITY

  constructor(
    private readonly logger: Pick<IScopedLogger, 'warn'>,
    private readonly now: () => number = Date.now,
  ) {}

  /**
   * Re-read the registry when the snapshot is older than the TTL; answer the
   * snapshot. `force: true` bypasses the TTL — required right after a
   * Library register when Import+land downloads on the same tick (a warm
   * empty snapshot otherwise hides the brand-new id for up to 5 s).
   */
  async refresh(
    api: CustomModelRegistryApi | undefined,
    opts?: { readonly force?: boolean },
  ): Promise<CustomModelsByStep> {
    const now = this.now()
    if (opts?.force !== true && now - this.readAtMs < CUSTOM_MODEL_CATALOG_TTL_MS) {
      return this.byStep
    }
    this.readAtMs = now
    if (api === undefined) return this.byStep
    try {
      const providers = await api.addons.listCapabilityProviders.query({
        capName: 'custom-model-registry',
      })
      this.byStep = providers.some((p) => p.isActive)
        ? groupCustomModelsByStep(await api.customModelRegistry.listModels.query())
        : new Map()
    } catch (err: unknown) {
      this.logger.warn(
        'custom-model-registry query failed — keeping the last custom-model snapshot',
        {
          meta: { error: err instanceof Error ? err.message : String(err) },
        },
      )
    }
    return this.byStep
  }

  /** The snapshot, synchronously. */
  current(): CustomModelsByStep {
    return this.byStep
  }

  /** A step's merged definition from the snapshot, synchronously. */
  readonly stepDefinition = (stepId: string): StepDefinition | null =>
    mergedStepDefinition(stepId, this.byStep)
}
