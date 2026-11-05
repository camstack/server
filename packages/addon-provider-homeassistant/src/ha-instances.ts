/**
 * The Home Assistant integrations as `integration-instances` (D1012): one `connections` record
 * per integration, keyed by the registry id, whose body is the link to a Home Assistant connection
 * (a `brokers` record, edited on the Brokers page).
 */
import {
  type BrokerLinkBody,
  buildBrokerLinkInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { haConnectionsEntryKind } from './broker-record-kinds.js'

export const HA_BROKER_KIND = 'home-assistant'

export function buildHaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<BrokerLinkBody> {
  return buildBrokerLinkInstances(records, {
    kind: haConnectionsEntryKind,
    brokerKind: HA_BROKER_KIND,
    brokerLabel: 'Home Assistant connection',
    onChanged: () => undefined,
  })
}
