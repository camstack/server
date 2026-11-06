/**
 * The notification targets the dispatcher can send to, read as INSTANCES of the function cap
 * `notification-output` (epic #440, step 6; D1013 rule 5). A rule's `targetId` is the instance id, the
 * send still goes to `notificationOutput.send({ addonId, targetId })`, so a rule saved before this
 * change keeps resolving.
 *
 * A provider that could not be read is never an empty list (D315, D49): its holder is NAMED in the
 * answer, so one broken holder cannot stall delivery to the healthy ones, and a target missing from a
 * partial answer is transient (retried), never "deleted". Nothing readable at all is an error.
 */
import {
  type IntegrationInstance,
  type IntegrationInstanceDescription,
  type InstanceSource,
  instancesOfCap,
  type TargetKind,
} from '@camstack/types'
import type { NcTargetRef, NcUnreadableHolder } from '../../notification-center/dispatcher.js'

const NOTIFICATION_OUTPUT = 'notification-output'
const INTEGRATION_INSTANCES = 'integration-instances'

/** What the dispatcher takes from a KIND: the budgets its caps and delivery parameters declare. */
export type NcKindBudgets = Pick<TargetKind, 'kind' | 'caps' | 'deliveryParams'>

/** The slice of `ctx.api` the read needs. */
export interface NcInstanceApi {
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

async function providersOf(api: NcInstanceApi, name: string): Promise<readonly string[]> {
  const info = await api.capabilities.getCapability.query({ name })
  if (info === null) throw new Error(`the capability registry did not answer for ${name}`)
  return info.providers
}

/** The source over `ctx.api`: the same rule the hub resolver binds to its registry. */
export function instanceSourceOverApi(api: NcInstanceApi): InstanceSource {
  return {
    holders: async (cap) => {
      const providing = new Set(await providersOf(api, cap))
      return (await providersOf(api, INTEGRATION_INSTANCES)).filter((id) => providing.has(id))
    },
    describe: (addonId) => api.integrationInstances.describe.query({ addonId }),
    listInstances: (addonId) => api.integrationInstances.listInstances.query({ addonId }),
  }
}

/** The readable targets, and the holders that could not be read. */
export interface NcTargetRead {
  readonly targets: readonly NcTargetRef[]
  readonly unreadable: readonly NcUnreadableHolder[]
}

/** Every readable target as the dispatcher sees it, with the budgets its KIND declares. */
export async function readNcTargets(
  source: InstanceSource,
  kinds: readonly NcKindBudgets[],
): Promise<NcTargetRead> {
  const { instances, unreadable } = await instancesOfCap(source, NOTIFICATION_OUTPUT)
  if (instances.length === 0 && unreadable.length > 0) {
    throw new Error(
      `notification targets unreadable from ${unreadable.map((u) => `${u.addonId} (${u.error})`).join(', ')}`,
    )
  }
  const byKind = new Map(kinds.map((kind) => [kind.kind, kind]))
  const targets = instances.map(({ addonId, kind, instance }): NcTargetRef => {
    const declared = byKind.get(kind.id)
    const owner = instance.formValues['ownerUserId']
    const deliveryParams = declared?.deliveryParams
    return {
      id: instance.id,
      addonId,
      name: instance.name,
      kind: kind.id,
      enabled: instance.enabled !== false,
      ...(typeof owner === 'string' && owner.length > 0 ? { ownerUserId: owner } : {}),
      ...(declared !== undefined ? { bodyMaxLen: declared.caps.bodyMaxLen } : {}),
      ...(declared !== undefined ? { maxActions: declared.caps.actions } : {}),
      ...(deliveryParams !== undefined && deliveryParams.length > 0 ? { deliveryParams } : {}),
    }
  })
  return { targets, unreadable: unreadable.map((u) => ({ addonId: u.addonId, error: u.error })) }
}
