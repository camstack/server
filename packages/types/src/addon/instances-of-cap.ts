/**
 * The instances of a function cap across every provider of `integration-instances` (D1013 rule 5).
 *
 * Every holder describes its kinds; the instances of a kind that serves the asked cap (its `functionCap`,
 * or one it declares in `alsoServes`) are the answer. The hub resolver and an addon reading over `ctx.api` bind the same {@link InstanceSource}, so
 * there is ONE rule. A holder that cannot answer is reported in `unreadable`, never skipped silently: an
 * empty list and a failed read are different answers (D315) and a caller that would act on absence
 * (a dispatcher dropping a rule's target) must be able to tell them apart (D49).
 */
import type {
  IntegrationInstance,
  IntegrationInstanceDescription,
  IntegrationInstanceKind,
} from '../capabilities/integration-instances.cap.js'

/** Where holders and their instances are read from. */
export interface InstanceSource {
  /** The addon ids that hold `integration-instances` and also provide `cap`. */
  holders(cap: string): Promise<readonly string[]>
  describe(addonId: string): Promise<IntegrationInstanceDescription>
  listInstances(addonId: string): Promise<readonly IntegrationInstance[]>
}

/** One instance of the asked cap and where it lives. */
export interface InstanceOfCap {
  readonly addonId: string
  readonly kind: IntegrationInstanceKind
  readonly instance: IntegrationInstance
}

export interface InstancesOfCapResult {
  readonly instances: readonly InstanceOfCap[]
  /** Holders that did not answer, with why. */
  readonly unreadable: readonly {
    readonly addonId: string
    readonly error: string
  }[]
}

/**
 * The kind's instances answer for `cap`: it is the kind's `functionCap`, or one the kind declares in
 * `alsoServes`. The one rule a link (a picker, a resolver, a delete guard) matches a target by.
 */
export function kindServesCap(kind: IntegrationInstanceKind, cap: string): boolean {
  return kind.functionCap === cap || (kind.alsoServes ?? []).includes(cap)
}

export async function instancesOfCap(
  source: InstanceSource,
  cap: string,
  filter: { readonly kind?: string } = {},
): Promise<InstancesOfCapResult> {
  const instances: InstanceOfCap[] = []
  const unreadable: { addonId: string; error: string }[] = []
  for (const addonId of await source.holders(cap)) {
    try {
      const description = await source.describe(addonId)
      const kinds = (description.kinds ?? []).filter((kind) => kindServesCap(kind, cap))
      if (kinds.length === 0) continue
      for (const instance of await source.listInstances(addonId)) {
        const kind = kinds.find((candidate) => candidate.id === instance.kind)
        if (kind === undefined) continue
        if (filter.kind !== undefined && (kind.brokerKind ?? kind.id) !== filter.kind) continue
        instances.push({ addonId, kind, instance })
      }
    } catch (err: unknown) {
      unreadable.push({
        addonId,
        error: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return { instances, unreadable }
}

/** The slice of `ctx.api` an addon needs to read the instances of a function cap. */
export interface InstanceApi {
  readonly capabilities: {
    readonly getCapability: {
      query(input: { name: string }): Promise<{ readonly providers: readonly string[] } | null>
    }
  }
  readonly integrationInstances: {
    readonly describe: {
      query(input: { addonId: string }): Promise<IntegrationInstanceDescription>
    }
    readonly listInstances: {
      query(input: { addonId: string }): Promise<readonly IntegrationInstance[]>
    }
  }
}

async function providersOf(api: InstanceApi, name: string): Promise<readonly string[]> {
  const info = await api.capabilities.getCapability.query({ name })
  if (info === null) throw new Error(`the capability registry did not answer for ${name}`)
  return info.providers
}

/**
 * The source over `ctx.api`. Every provider of the cap is a holder, not only those that also serve
 * `integration-instances`: a provider that does not (an addon older than the hub during an update)
 * then fails `describe` and is reported unreadable, so its instances are retried as transient
 * instead of vanishing from the catalogue and failing for good.
 */
export function instanceSourceOverApi(api: InstanceApi): InstanceSource {
  return {
    holders: (cap) => providersOf(api, cap),
    describe: (addonId) => api.integrationInstances.describe.query({ addonId }),
    listInstances: (addonId) => api.integrationInstances.listInstances.query({ addonId }),
  }
}
