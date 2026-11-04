/**
 * Gree integrations as `integration-instances` (planning#416, D985, D1007): an integration is one
 * `connections` record under the registry id, and its body holds only a name. The connection of
 * each air conditioner (IP, UDP tuning) lives on the AC device, so the instance form is empty and
 * the integration is the owner the devices are stamped with.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const greeConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Gree integrations',
  schema: entryBody({}),
  writeTrigger: 'an operator adds or removes a Gree integration',
})
export type GreeConnectionBody = z.infer<typeof greeConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const greeRecordKinds = { connections: greeConnectionsEntryKind } as const

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
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name): GreeConnectionBody => ({ name }),
    configured: () => true,
    // Nothing of an air conditioner is read from the instance: each AC owns its connection.
    onChanged: () => undefined,
  })
}
