/**
 * ESPHome integrations as `integration-instances` (planning#416, D985, D1007): one `connections`
 * record per integration under its registry id, whose body is the integration's `boards` list.
 * Each board keeps its id (the live session id and the owner id of its devices) and its two
 * secrets (`boards[<id>].encryptionKey`, `boards[<id>].password`) in the keychain, declared by
 * type and matched by the board id, never by position. The integrations registry owns the on/off
 * switch (`role: devices`).
 */
import {
  defineEntryKind,
  entryBody,
  type RecordKindHandle,
  type RecordsAccess,
  RecordIntegrationInstances,
} from '@camstack/types'
import { z } from 'zod'
import { buildIntegrationFormSchema, espBoardRowSchema } from './config.js'

export const EspConnectionsBodySchema = entryBody({
  boards: z.array(espBoardRowSchema).optional(),
})
export type EspConnectionsBody = z.infer<typeof EspConnectionsBodySchema>

export const espConnectionsEntryKind = defineEntryKind('connections', {
  title: 'ESPHome integrations',
  schema: EspConnectionsBodySchema,
  writeTrigger: 'an operator adds, edits or removes the boards of an ESPHome integration',
  secretArrayKeys: { boards: 'id' },
})

export interface EspInstancesDeps {
  /** Bring the live board sessions in line with the records after a change. */
  readonly onChanged: () => Promise<void>
}

export function buildEspInstances(
  records: Pick<RecordsAccess, 'kind' | 'owner'>,
  deps: EspInstancesDeps,
): RecordIntegrationInstances<EspConnectionsBody> {
  return new RecordIntegrationInstances<EspConnectionsBody>(records, espConnectionsEntryKind, {
    description: {
      role: 'devices',
      discovery: { mode: 'lan', scopedToInstance: false },
      instanceMode: 'multiple',
      kind: 'connection',
      canTest: false,
      kinds: [
        { id: 'connection', label: 'ESPHome', functionCap: 'device-provider', role: 'devices' },
      ],
    },
    formSchema: () => buildIntegrationFormSchema(),
    initialBody: (name): EspConnectionsBody => ({ name }),
    configured: (body) => (body.boards ?? []).length > 0,
    onChanged: () => deps.onChanged(),
  })
}

/** How the board list reads and writes the record: the only store of the rows. */
export interface EspBoardsStore {
  /** The integration's rows; none when it has no record. A locked keychain serves redacted secrets. */
  read(integrationId: string): Promise<readonly Record<string, unknown>[]>
  /** Replace the integration's whole board list (a board left out releases its secrets). */
  write(integrationId: string, rows: readonly Record<string, unknown>[]): Promise<void>
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export function buildEspBoardsStore(
  records: Pick<RecordsAccess, 'kind'>,
  instances: RecordIntegrationInstances<EspConnectionsBody>,
): EspBoardsStore {
  const handle: RecordKindHandle<EspConnectionsBody> = records.kind(espConnectionsEntryKind)
  return {
    read: async (integrationId) => {
      const resolved = await instances.readResolved(integrationId)
      return (resolved?.body.boards ?? []).filter(isRecord)
    },
    write: async (integrationId, rows) => {
      const stored = await handle.getResolved(integrationId)
      if (stored === null) {
        throw new Error(
          `ESPHome integration '${integrationId}' has no record to save the boards in`,
        )
      }
      const boards = rows.map((row) => espBoardRowSchema.parse(row))
      await handle.put(
        { id: integrationId, data: { ...stored.data, boards } },
        { ifRev: stored.rev },
      )
    },
  }
}
