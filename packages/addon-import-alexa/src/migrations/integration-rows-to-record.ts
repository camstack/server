/**
 * The Alexa integration's last legacy row, `brokerId` (the integration to broker link), moves onto
 * the broker record (planning#416): the runtime reads `broker.integrationId`, so the row is only
 * stamped across when the broker has no link yet, then every legacy row of the integration is
 * cleared (the door `integration_settings` is dropped through accepts an addon only once this
 * ran). Nothing is overwritten: a broker that already names an integration, or a `brokerId` that
 * names no broker, is left as it is and said so in a warning (ids only, never a value).
 * An empty door is a no-op, so a rerun is too.
 */
import {
  integrationRowsPortsOverApi,
  type IntegrationRowsApi,
  type IntegrationRowsPorts,
  type MigrationProcedureResult,
  type RowsMigrationLog,
  type SecretsAccess,
} from '@camstack/types'
import { z } from 'zod'
import { alexaBrokersEntryKind } from '../broker-record-kinds.js'
import type { PositionalRecordsDoor } from './records-door.js'

export const INTEGRATION_ROWS_TO_RECORD_ID = 'import-alexa/2026-11-05-integration-rows-to-record'

const ADDON_ID = 'import-alexa'

/** The broker record, as far as the link is concerned. */
export interface BrokerLinkState {
  readonly integrationId: string | undefined
}

export interface AlexaIntegrationLinkPorts extends RowsMigrationLog {
  /** The broker record under `id`; null when there is none. */
  readBrokerLink(id: string): Promise<BrokerLinkState | null>
  /** Set `integrationId` on the broker record (a patch: nothing else is touched). */
  stampBrokerLink(id: string, integrationId: string): Promise<void>
}

/** `readRows` is already the Echo targets' port, hence the `Integration` names here. */
export interface AlexaIntegrationRowsPorts extends AlexaIntegrationLinkPorts {
  listIntegrations: IntegrationRowsPorts['listIntegrations']
  readIntegrationRows: IntegrationRowsPorts['readRows']
  clearIntegrationRows: IntegrationRowsPorts['clearRows']
}

export async function moveAlexaIntegrationRows(
  ports: AlexaIntegrationRowsPorts,
): Promise<MigrationProcedureResult> {
  const integrations = await ports.listIntegrations(ADDON_ID)
  let stamped = 0
  let cleared = 0
  for (const integration of integrations) {
    const rows = await ports.readIntegrationRows(integration.id)
    if (Object.keys(rows).length === 0) continue
    const brokerId = rows['brokerId']
    if (typeof brokerId === 'string' && brokerId !== '') {
      const broker = await ports.readBrokerLink(brokerId)
      if (broker === null) {
        ports.warn(
          `integration '${integration.id}': brokerId '${brokerId}' names no broker record; nothing linked`,
        )
      } else if (broker.integrationId !== undefined) {
        ports.warn(
          `integration '${integration.id}': broker '${brokerId}' already names integration '${broker.integrationId}'; the link is not changed`,
        )
      } else {
        await ports.stampBrokerLink(brokerId, integration.id)
        const back = await ports.readBrokerLink(brokerId)
        if (back?.integrationId !== integration.id) {
          throw new Error(
            `integration '${integration.id}': the link did not read back from broker '${brokerId}' - the legacy settings are kept`,
          )
        }
        stamped += 1
      }
    }
    await ports.clearIntegrationRows(integration.id)
    cleared += 1
  }
  return cleared === 0
    ? {
        outcome: 'already-done',
        summary: { integrations: integrations.length },
      }
    : {
        outcome: 'done',
        summary: { integrations: integrations.length, stamped, cleared },
      }
}

/** The hub side (the registry list, the migration-only door) and the broker records side. */
export function alexaIntegrationRowsPorts(deps: {
  readonly api: IntegrationRowsApi
  readonly records: PositionalRecordsDoor
  readonly secrets: Pick<SecretsAccess, 'resolve' | 'delete'> | null
  readonly warn: (message: string) => void
}): AlexaIntegrationRowsPorts {
  const brokers = deps.records.kind(alexaBrokersEntryKind)
  const rows = integrationRowsPortsOverApi({
    api: deps.api,
    secrets: deps.secrets,
    // Only the registry list, the rows and the clear are used; the record side is the link below.
    records: deps.records.kind({
      name: alexaBrokersEntryKind.name,
      declaration: alexaBrokersEntryKind.declaration,
      schema: z.record(z.string(), z.unknown()),
    }),
    log: { warn: deps.warn },
  })
  return {
    warn: deps.warn,
    listIntegrations: rows.listIntegrations,
    readIntegrationRows: rows.readRows,
    clearIntegrationRows: rows.clearRows,
    readBrokerLink: async (id) => {
      const row = await brokers.get(id)
      return row === null ? null : { integrationId: row.data.integrationId }
    },
    stampBrokerLink: async (id, integrationId) => {
      await brokers.patch(id, { integrationId })
    },
  }
}
