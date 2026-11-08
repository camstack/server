/**
 * Gree integrations as `integration-instances` (planning#416, D985, D1007): an integration is one
 * `connections` record under the registry id, and its body holds a name and the discovery scope. The
 * connection of each air conditioner (IP, UDP tuning) lives on the AC device, so the instance form is the
 * scope only and the integration is the owner the devices are stamped with. Its body also lists the extra /24
 * subnets its discovery sweeps (`sweepSubnets`).
 */
import {
  defineEntryKind,
  entryBody,
  type ConfigUISchema,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import { isGreeSweepCidr } from './gree-subnet-scan.js'

export const greeConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Gree integrations',
  schema: entryBody({
    sweepSubnets: z
      .array(
        z.string().refine(isGreeSweepCidr, {
          message: 'Expected a /24 IPv4 CIDR, e.g. 192.168.20.0/24',
        }),
      )
      .nullish(),
  }),
  writeTrigger: 'an operator adds or removes a Gree integration',
})
export type GreeConnectionBody = z.infer<typeof greeConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const greeRecordKinds = {
  connections: greeConnectionsEntryKind,
} as const

/** The enabled integrations' extra sweep subnets, deduplicated. */
export function extraSweepSubnetsOf(
  instances: readonly {
    readonly enabled: boolean
    readonly body: GreeConnectionBody
  }[],
): readonly string[] {
  const out = new Set<string>()
  for (const instance of instances) {
    if (!instance.enabled) continue
    for (const subnet of instance.body.sweepSubnets ?? []) out.add(subnet)
  }
  return [...out]
}

/** The integration form: the discovery scope the integration owns, beyond the local interfaces. */
export function buildGreeInstanceFormSchema(): ConfigUISchema {
  return {
    sections: [
      {
        id: 'discovery',
        title: 'Discovery',
        titleKey: 'provider-gree:instance.s_discovery.title',
        columns: 1,
        fields: [
          {
            type: 'tags',
            key: 'sweepSubnets',
            label: 'Extra subnets to sweep',
            labelKey: 'provider-gree:instance.s_discovery.sweepSubnets.label',
            description:
              'Additional /24 subnets searched for air conditioners, one CIDR each (for example 192.168.20.0/24). The subnets of this hub and of the known air conditioners are always searched.',
            descriptionKey: 'provider-gree:instance.s_discovery.sweepSubnets.description',
          },
        ],
      },
    ],
  }
}

export function buildGreeInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<GreeConnectionBody> {
  return new RecordIntegrationInstances<GreeConnectionBody>(records, greeConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'lan', scopedToInstance: false },
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
      kinds: [{ id: 'connection', label: 'Gree', functionCap: 'device-provider', role: 'devices' }],
    },
    formSchema: () => buildGreeInstanceFormSchema(),
    initialBody: (name): GreeConnectionBody => ({ name }),
    configured: () => true,
    // Nothing of an air conditioner is read from the instance: each AC owns its connection.
    onChanged: () => undefined,
  })
}
