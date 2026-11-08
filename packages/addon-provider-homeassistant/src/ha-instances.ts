/**
 * The Home Assistant integrations as `integration-instances` (D1012): one `connections` record
 * per integration, keyed by the registry id, whose body is the link to a Home Assistant connection
 * (a `brokers` record, edited on the Brokers page).
 */
import {
  buildLinkedInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { type HaConnectionBody, haConnectionsEntryKind } from './broker-record-kinds.js'

export const HA_BROKER_KIND = 'home-assistant'

export function buildHaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<HaConnectionBody> {
  return buildLinkedInstances(records, {
    kind: haConnectionsEntryKind,
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
      kinds: [
        {
          id: 'integration',
          label: 'Home Assistant',
          functionCap: 'device-provider',
          role: 'devices',
        },
      ],
    },
    labels: { brokerId: { label: 'Home Assistant connection' } },
  })
}
