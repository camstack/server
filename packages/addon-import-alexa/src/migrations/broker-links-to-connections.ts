import type { BrokerLinkPorts } from '@camstack/types'
import { z } from 'zod'
import { alexaBrokersEntryKind, alexaConnectionsEntryKind } from '../broker-record-kinds.js'
import type { PositionalRecordsDoor } from './records-door.js'

export const BROKER_LINKS_TO_CONNECTIONS_ID = 'import-alexa/2026-11-05-broker-links-to-connections'

const BROKER_ROWS_MAX = 1000

/** The broker records and the integration (`connections`) records of this addon. */
export function alexaBrokerLinkPorts(
  records: PositionalRecordsDoor,
  warn: (message: string) => void,
): BrokerLinkPorts {
  const brokers = records.kind({
    name: alexaBrokersEntryKind.name,
    declaration: alexaBrokersEntryKind.declaration,
    schema: z.record(z.string(), z.unknown()),
  })
  const connections = records.kind(alexaConnectionsEntryKind)
  return {
    warn,
    listBrokers: async () => {
      const page = await brokers.query({ limit: BROKER_ROWS_MAX })
      return page.records.map((row) => {
        const name = row.data['name']
        const link = row.data['integrationId']
        return {
          id: row.id,
          name: typeof name === 'string' && name.length > 0 ? name : row.id,
          integrationId: typeof link === 'string' ? link : undefined,
        }
      })
    },
    readConnection: async (id) => {
      const row = await connections.get(id)
      return row === null ? null : { brokerId: row.data.brokerId }
    },
    putConnection: async (id, body) => {
      await connections.put({ id, data: body }, { ifRev: 0 })
    },
    clearBrokerLink: async (brokerId) => {
      await brokers.patch(brokerId, { integrationId: null })
    },
  }
}
