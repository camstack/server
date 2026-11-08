/**
 * The Alexa integrations as `integration-instances` (D1012): one `connections` record per
 * integration, keyed by the registry id, whose body is the link to an Alexa account (a `brokers`
 * record, edited on the Brokers page). The account's sign-in and secrets are never copied here.
 */
import {
  buildLinkedInstances,
  type RecordIntegrationInstances,
  type RecordsAccess,
} from '@camstack/types'
import { type AlexaConnectionBody, alexaConnectionsEntryKind } from './broker-record-kinds.js'

export function buildAlexaInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
): RecordIntegrationInstances<AlexaConnectionBody> {
  return buildLinkedInstances(records, {
    kind: alexaConnectionsEntryKind,
    description: {
      role: 'devices',
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
      kinds: [
        { id: 'integration', label: 'Alexa', functionCap: 'device-provider', role: 'devices' },
      ],
    },
    labels: { brokerId: { label: 'Alexa account' } },
  })
}
