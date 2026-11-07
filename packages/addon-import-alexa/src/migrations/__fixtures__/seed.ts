/**
 * The legacy data a node that last ran a pre-record release holds for import-alexa, written by
 * hand in the shape those releases stored: the addon-level `echoTargets` setting in the canonical
 * `addon-settings` layout (rows still carrying the retired volume and mode), two accounts with
 * the NESTED connection object (secrets inside), and the integration's legacy `brokerId` row.
 * Every row carries a MARK so a step that rewrote a row it does not own is caught by the replay.
 */
import { defineEntryKind, entryBody, makeInMemoryRecords, recordSecretRef } from '@camstack/types'
import type Database from 'better-sqlite3'
import { z } from 'zod'
import { alexaRecordKinds } from '../../broker-record-kinds.js'
import { alexaNotifyRecordKinds } from '../../speak/echo-store.js'

export const SEED_ADDON_ID = 'import-alexa'

/** The accounts kind as the hub declared it before the flat body: the connection nested. */
export const legacyBrokersKind = defineEntryKind('brokers', {
  title: 'legacy brokers',
  schema: entryBody({
    connection: z.object({
      amazonDomain: z.string().optional(),
      cookie: z.string().optional().meta({ secret: true }),
      refreshToken: z.string().optional().meta({ secret: true }),
      macDms: z.string().optional(),
      pollIntervalMs: z.number().optional(),
    }),
    integrationId: z.string().optional(),
  }),
})

export interface AlexaSeedMarks {
  readonly accounts: Readonly<
    Record<
      string,
      {
        readonly name: string
        readonly cookie: string
        readonly integrationId: string
      }
    >
  >
  /** The integration whose legacy `brokerId` row links the first account. */
  readonly rowIntegration: string
  readonly echo: { readonly id: string; readonly name: string }
  /** A key the migrations do not know: it must survive all of them. */
  readonly unrelated: { readonly key: string; readonly value: string }
  /** A neighbour addon's `echoTargets` key, which no step may touch. */
  readonly neighbour: string
}

export function seedAlexaSettings(db: Database.Database): AlexaSeedMarks {
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const put = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  const row = (key: string, value: unknown): void => {
    put.run(`${SEED_ADDON_ID}.${key}`, JSON.stringify({ addonId: SEED_ADDON_ID, key, value }))
  }
  row('echoTargets', [
    {
      id: 'echo-kitchen',
      name: 'Kitchen mark',
      enabled: false,
      brokerId: 'alexa_001',
      echoId: 'echo-k',
      respectDnd: false,
      volume: 63,
      mode: 'announce',
    },
  ])
  row('someUnrelatedKey', 'keep-me')
  put.run(
    'other-addon.echoTargets',
    JSON.stringify({
      addonId: 'other-addon',
      key: 'echoTargets',
      value: 'neighbour-mark',
    }),
  )
  return {
    accounts: {
      alexa_001: {
        name: 'Living room mark',
        cookie: 'cookie-1',
        integrationId: 'int_0035',
      },
      alexa_002: {
        name: 'Study mark',
        cookie: 'cookie-2',
        integrationId: 'int_0036',
      },
    },
    rowIntegration: 'int_0035',
    echo: { id: 'echo-kitchen', name: 'Kitchen mark' },
    unrelated: { key: 'someUnrelatedKey', value: 'keep-me' },
    neighbour: 'neighbour-mark',
  }
}

/** The records of that node: nested accounts (the second already linked), then the current kinds declared. */
export async function seedAlexaRecords(marks: AlexaSeedMarks) {
  const memory = makeInMemoryRecords(SEED_ADDON_ID)
  await memory.records.declare({ brokers: legacyBrokersKind })
  const legacy = memory.records.kind(legacyBrokersKind)
  for (const [id, account] of Object.entries(marks.accounts)) {
    await legacy.put(
      {
        id,
        data: {
          name: account.name,
          // The first account is unlinked on the record: its link comes from the legacy row.
          ...(id === 'alexa_002' ? { integrationId: account.integrationId } : {}),
          connection: {
            amazonDomain: 'amazon.it',
            macDms: 'mac',
            cookie: account.cookie,
          },
        },
      },
      { ifRev: 0 },
    )
  }
  await memory.records.declare({
    ...alexaRecordKinds,
    ...alexaNotifyRecordKinds,
  })
  return memory
}

export const nestedRef = (id: string, key: string): string =>
  recordSecretRef(SEED_ADDON_ID, 'brokers', id, `connection.${key}`)
