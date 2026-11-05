/**
 * The Alexa integrations as `integration-instances` (D1011): one `connections` record per
 * integration, keyed by the registry id, whose body is the link to an Alexa account (a `brokers`
 * record, edited on the Brokers page). The account's sign-in and secrets are never copied here.
 */
import {
  type BrokerLinkBody,
  buildBrokerLinkInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { alexaConnectionsEntryKind } from './broker-record-kinds.js'
import { ALEXA_BROKER_KIND } from './speak/constants.js'

export function buildAlexaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<BrokerLinkBody> {
  return buildBrokerLinkInstances(records, {
    kind: alexaConnectionsEntryKind,
    brokerKind: ALEXA_BROKER_KIND,
    brokerLabel: 'Alexa account',
    onChanged: () => undefined,
  })
}
