/**
 * The Matter integrations as `integration-instances` (D1012): one `connections` record per
 * integration, keyed by the registry id, whose body is the link to a Matter fabric (a `brokers`
 * record, edited on the Brokers page).
 */
import {
  buildLinkedInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { type MatterConnectionBody, matterConnectionsEntryKind } from './broker-record-kinds.js'

export const MATTER_BROKER_KIND = 'matter'

export function buildMatterInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<MatterConnectionBody> {
  return buildLinkedInstances(records, {
    kind: matterConnectionsEntryKind,
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
    },
    labels: { brokerId: { label: 'Matter fabric' } },
  })
}
