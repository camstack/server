/**
 * RTSP integration as an `integration-instances` provider (planning#416, D985, D1007): the
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

export const rtspConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Rtsp integrations',
  schema: entryBody({}),
  writeTrigger: 'an operator adds or removes the Rtsp integration',
})
export type RtspConnectionBody = z.infer<typeof rtspConnectionsEntryKind.schema>

/** Every kind this addon declares, keyed by its name. */
export const rtspRecordKinds = { connections: rtspConnectionsEntryKind } as const

export function buildRtspInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<RtspConnectionBody> {
  return new RecordIntegrationInstances<RtspConnectionBody>(records, rtspConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'none', scopedToInstance: false },
      instanceMode: 'single',
      kind: 'connection',
      canTest: false,
    },
    formSchema: () => ({ sections: [] }),
    initialBody: (name): RtspConnectionBody => ({ name }),
    configured: () => true,
    // Nothing of a camera is read from the instance: each device owns its connection.
    onChanged: () => undefined,
  })
}
