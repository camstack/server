/**
 * The Notification Center integration as an `integration-instances` provider (epic #440): the
 * fixed builtin `DeclaredDevices` mints for the alarm panel (`boot/build-alarm-panel.ts`) has an
 * instance record under its registry id, holding only its name. It is name-only on purpose: the
 * integration's `enabled` switch stays in the registry (a fixed builtin is switched through
 * `integrations.update`, and `integrations.list` never projects it from a record), and the panel
 * is configured on its own device, not on the integration.
 */
import {
  defineEntryKind,
  entryBody,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import type { z } from 'zod'

export const alarmPanelConnectionsEntryKind = defineEntryKind('connections', {
  title: 'Notification Center integration',
  schema: entryBody({}),
  writeTrigger: 'the hub declares the Notification Center integration on boot',
})
export type AlarmPanelConnectionBody = z.infer<typeof alarmPanelConnectionsEntryKind.schema>

/** Every kind of the Notification Center integration record, keyed by its name. */
export const alarmPanelInstanceRecordKinds = {
  connections: alarmPanelConnectionsEntryKind,
} as const

export function buildAlarmPanelInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<AlarmPanelConnectionBody> {
  return new RecordIntegrationInstances<AlarmPanelConnectionBody>(
    records,
    alarmPanelConnectionsEntryKind,
    {
      description: {
        role: 'devices',
        discovery: { mode: 'none', scopedToInstance: false },
        instanceMode: 'single',
        kind: 'notification-center',
        canTest: false,
        kinds: [
          {
            id: 'notification-center',
            label: 'Notification Center',
            functionCap: 'notification-rules',
            role: 'devices',
          },
        ],
      },
      formSchema: () => ({ sections: [] }),
      initialBody: (name): AlarmPanelConnectionBody => ({ name }),
      configured: () => true,
      // Nothing of the integration is read from the record.
      onChanged: () => undefined,
    },
  )
}
