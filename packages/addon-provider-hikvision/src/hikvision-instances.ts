/**
 * Hikvision integration as an `integration-instances` provider (planning#416, D985, D1007): the
 * integration is one `connections` record under the registry id and its body holds only a name.
 * The connection of each camera or NVR (host, credentials) lives on the device, so the instance
 * form is empty and the integration is the owner the devices are stamped with.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const hikvisionConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Hikvision integrations',
  schema: entryBody({}),
  writeTrigger: 'an operator adds or removes the Hikvision integration',
})
export type HikvisionConnectionBody = z.infer<typeof hikvisionConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const hikvisionRecordKinds = { connections: hikvisionConnectionsEntryKind } as const

export function buildHikvisionInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<HikvisionConnectionBody> {
  return new RecordIntegrationInstances<HikvisionConnectionBody>(
    records,
    hikvisionConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'lan', scopedToInstance: false },
        instanceMode: 'single',
        kind: 'connection',
        canTest: false,
        kinds: [
          { id: 'connection', label: 'Hikvision', functionCap: 'device-provider', role: 'devices' },
        ],
      },
      formSchema: () => ({ sections: [] }),
      initialBody: (name): HikvisionConnectionBody => ({ name }),
      configured: () => true,
      // Nothing of a camera is read from the instance: each device owns its connection.
      onChanged: () => undefined,
    },
  )
}
