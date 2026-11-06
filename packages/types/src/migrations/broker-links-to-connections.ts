/**
 * The integration link moves OFF the broker (D1012). A broker record used to name the registry
 * integration it served (`integrationId`); the integration now has a record of its own,
 * `connections`, keyed by that id, whose body names the broker. For every broker row with a link:
 *
 *  1. the connection is put with `ifRev: 0` (an existing one is never overwritten);
 *  2. it is read back and must name this broker;
 *  3. only then is `integrationId` cleared on the broker (a patch: nothing else is touched).
 *
 * A connection that already names ANOTHER broker is left alone and the link stays on the broker,
 * with a warning (ids only). Rows keyed like a registry id (`int_NNNN`) inside a broker kind are a
 * leftover of an old create bug: they are counted and named, never deleted. Idempotent.
 */
import type { RecordKindHandle } from '../records/records-access.js'
import type { MigrationProcedureResult } from './migration.js'
import type { RowsMigrationLog } from './integration-rows-to-record.js'

/** The body of a `connections` record this migration writes: the link, nothing else. */
export interface BrokerLinkBody {
  readonly name: string
  readonly brokerId: string
}

const BROKER_ROWS_MAX = 1000
const STRAY_REGISTRY_ID = /^int_\d+$/

export interface BrokerLinkRow {
  readonly id: string
  readonly name: string
  readonly integrationId: string | undefined
}

export interface BrokerLinkPorts extends RowsMigrationLog {
  listBrokers(): Promise<readonly BrokerLinkRow[]>
  /** The connection under `id`; null when there is none. */
  readConnection(id: string): Promise<{ readonly brokerId: string | undefined } | null>
  putConnection(id: string, body: BrokerLinkBody): Promise<void>
  clearBrokerLink(brokerId: string): Promise<void>
}

export async function moveBrokerLinksToConnections(
  ports: BrokerLinkPorts,
): Promise<MigrationProcedureResult> {
  const brokers = await ports.listBrokers()
  const strays = brokers.filter((b) => STRAY_REGISTRY_ID.test(b.id))
  if (strays.length > 0) {
    ports.warn(
      `${strays.length} broker row(s) are keyed like a registry integration and are left as they are: ${strays.map((s) => s.id).join(', ')}`,
    )
  }
  let moved = 0
  for (const broker of brokers) {
    const integrationId = broker.integrationId
    if (integrationId === undefined || integrationId === '') continue
    const existing = await ports.readConnection(integrationId)
    if (existing === null) {
      await ports.putConnection(integrationId, {
        name: broker.name,
        brokerId: broker.id,
      })
    } else if (existing.brokerId !== broker.id) {
      ports.warn(
        `integration '${integrationId}' already names broker '${existing.brokerId ?? 'none'}', not '${broker.id}'; the link stays on the broker`,
      )
      continue
    }
    const back = await ports.readConnection(integrationId)
    if (back?.brokerId !== broker.id) {
      throw new Error(
        `integration '${integrationId}': the link did not read back - broker '${broker.id}' keeps it`,
      )
    }
    await ports.clearBrokerLink(broker.id)
    moved += 1
  }
  return {
    outcome: moved === 0 ? 'already-done' : 'done',
    summary: {
      brokers: brokers.length,
      moved,
      strayIntegrationRows: strays.length,
    },
  }
}

/** The ports over the two record kinds of the addon. */
export function brokerLinkPortsOver(deps: {
  readonly brokers: RecordKindHandle<Record<string, unknown>>
  readonly connections: RecordKindHandle<BrokerLinkBody>
  readonly warn: (message: string) => void
}): BrokerLinkPorts {
  return {
    warn: deps.warn,
    listBrokers: async () => {
      const page = await deps.brokers.query({ limit: BROKER_ROWS_MAX })
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
      const row = await deps.connections.get(id)
      return row === null ? null : { brokerId: row.data.brokerId }
    },
    putConnection: async (id, body) => {
      await deps.connections.put({ id, data: body }, { ifRev: 0 })
    },
    clearBrokerLink: async (brokerId) => {
      await deps.brokers.patch(brokerId, { integrationId: null })
    },
  }
}
