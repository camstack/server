import { brokerLinkPortsOver, type BrokerLinkPorts, type RecordsAccess } from '@camstack/types'
import { z } from 'zod'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../broker-record-kinds.js'

export const BROKER_LINKS_TO_CONNECTIONS_ID = 'import-alexa/2026-11-05-broker-links-to-connections'

/** The broker records and the integration (`connections`) records of this addon. */
export function alexaBrokerLinkPorts(
  records: Pick<RecordsAccess, 'kind'>,
  warn: (message: string) => void,
): BrokerLinkPorts {
  return brokerLinkPortsOver({
    brokers: records.kind({
      name: alexaBrokersEntryKind.name,
      declaration: alexaBrokersEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    connections: records.kind(alexaConnectionsEntryKind),
    warn,
  })
}
