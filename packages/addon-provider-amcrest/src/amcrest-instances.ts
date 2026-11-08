/**
 * Amcrest integration as an `integration-instances` provider (planning#416, D985, D1007): the
 * integration is one `connections` record under the registry id and its body holds only a name.
 * The connection of each camera (host, credentials) lives on the device, so the instance form is
 * empty and the integration is the owner the devices are stamped with.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const amcrestConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Amcrest integrations',
  schema: entryBody({}),
  writeTrigger: 'an operator adds or removes the Amcrest integration',
})
export type AmcrestConnectionBody = z.infer<typeof amcrestConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const amcrestRecordKinds = { connections: amcrestConnectionsEntryKind } as const

export function buildAmcrestInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<AmcrestConnectionBody> {
  return new RecordIntegrationInstances<AmcrestConnectionBody>(
    records,
    amcrestConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
        instanceMode: 'single',
        kind: 'connection',
        canTest: false,
        kinds: [
          { id: 'connection', label: 'Amcrest', functionCap: 'device-provider', role: 'devices' },
        ],
      },
      formSchema: () => ({ sections: [] }),
      initialBody: (name): AmcrestConnectionBody => ({ name }),
      configured: () => true,
      // Nothing of a camera is read from the instance: each device owns its connection.
      onChanged: () => undefined,
    },
  )
}
