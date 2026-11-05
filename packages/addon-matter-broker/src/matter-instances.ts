/**
 * The Matter integrations as `integration-instances` (D1012): one `connections` record per
 * integration, keyed by the registry id, whose body is the link to a Matter fabric (a `brokers`
 * record, edited on the Brokers page).
 */
import {
  type BrokerLinkBody,
  buildBrokerLinkInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { matterConnectionsEntryKind } from './broker-record-kinds.js'

export const MATTER_BROKER_KIND = 'matter'

export function buildMatterInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<BrokerLinkBody> {
  return buildBrokerLinkInstances(records, {
    kind: matterConnectionsEntryKind,
    brokerKind: MATTER_BROKER_KIND,
    brokerLabel: 'Matter fabric',
    onChanged: () => undefined,
  })
}
