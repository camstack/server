/**
 * ONVIF integration as an `integration-instances` provider (planning#416, D985, D1007): the
 * integration is one `connections` record under the registry id and its body holds only a name.
 * The connection of each camera (address, credentials) lives on the device, so the instance
 * form is empty and the integration is the owner the devices are stamped with.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const onvifConnectionsEntryKind = defineEntryKind('connections', {
  title: 'ONVIF integrations',
  schema: entryBody({}),
  writeTrigger: 'an operator adds or removes the ONVIF integration',
})
export type OnvifConnectionBody = z.infer<typeof onvifConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const onvifRecordKinds = { connections: onvifConnectionsEntryKind } as const

export function buildOnvifInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<OnvifConnectionBody> {
  return new RecordIntegrationInstances<OnvifConnectionBody>(records, onvifConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'lan', scopedToInstance: false },
      instanceMode: 'single',
      kind: 'connection',
      canTest: false,
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name): OnvifConnectionBody => ({ name }),
    configured: () => true,
    // Nothing of a camera is read from the instance: each device owns its connection.
    onChanged: () => undefined,
  })
}
