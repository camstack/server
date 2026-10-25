/**
 * System → Data → Records (`/system/data?tab=records`); the unified Records section also lists entry kinds.
 */
import { REDACTED_SECRET } from '@camstack/types'
import { defineFixtures } from './_define'
import { NOW } from './_time'

const LLM_DECL = {
  name: 'llm-profiles',
  database: 'settings' as const,
  class: 'config',
  writeTrigger: 'operator',
  retention: { kind: 'forever' as const },
  indexes: [{ fields: ['name'] }],
  fields: {},
}

function declaration(name: string, database: 'settings' | 'events', cls: string) {
  return {
    name,
    database,
    class: cls,
    writeTrigger: 'addon',
    retention: { kind: 'forever' as const },
    indexes: [],
    fields: {},
  }
}

export default defineFixtures({
  area: 'storage-records',
  description: 'Record kind catalog and read-only row preview',
  handlers: {
    'storageAdmin.listKinds': {
      kinds: [
        {
          owner: 'ml',
          kind: 'llm-profiles',
          database: 'settings',
          class: 'config',
          state: 'declared',
          rows: 2,
          bytesEstimate: 4096,
          writeTrigger: 'operator',
          retention: { kind: 'forever' },
          entry: true,
          declaration: {
            ...LLM_DECL,
            entry: { title: 'LLM profiles', nameField: 'name', schema: {} },
          },
        },
        {
          owner: 'pipeline-analytics',
          kind: 'migrations',
          database: 'settings',
          class: 'config',
          state: 'declared',
          rows: 1,
          bytesEstimate: 512,
          writeTrigger: 'addon',
          retention: { kind: 'forever' },
          entry: false,
          declaration: {
            name: 'migrations',
            database: 'settings',
            class: 'config',
            writeTrigger: 'addon',
            retention: { kind: 'forever' },
            indexes: [],
            fields: {},
          },
        },
        {
          owner: 'notifiers',
          kind: 'notification-targets',
          database: 'settings',
          class: 'config',
          state: 'declared',
          rows: 1,
          bytesEstimate: 640,
          writeTrigger: 'operator',
          retention: { kind: 'forever' },
          entry: true,
          declaration: {
            ...LLM_DECL,
            name: 'notification-targets',
            entry: {
              title: 'Notification targets',
              nameField: 'name',
              schema: {},
            },
          },
        },
        {
          owner: 'recorder',
          kind: 'segment-ledger',
          database: 'events',
          class: 'ledger',
          state: 'declared',
          rows: 18420,
          bytesEstimate: 5_242_880,
          writeTrigger: 'addon',
          retention: { kind: 'forever' },
          entry: false,
          declaration: declaration('segment-ledger', 'events', 'ledger'),
        },
        {
          owner: 'pipeline-analytics',
          kind: 'stats-5m',
          database: 'events',
          class: 'series',
          state: 'declared',
          rows: 0,
          bytesEstimate: null,
          writeTrigger: 'addon',
          retention: { kind: 'forever' },
          entry: false,
          declaration: declaration('stats-5m', 'events', 'series'),
        },
        {
          owner: 'legacy-tracker',
          kind: 'tracks-v1',
          database: 'events',
          class: 'ledger',
          state: 'orphaned',
          rows: null,
          bytesEstimate: null,
          writeTrigger: 'addon',
          retention: { kind: 'forever' },
          entry: false,
          declaration: declaration('tracks-v1', 'events', 'ledger'),
        },
      ],
    },
    'storageAdmin.readRecords': (input: unknown) => {
      const req = input as { owner?: string; kind?: string }
      if (req.owner === 'ml' && req.kind === 'llm-profiles') {
        return {
          records: [
            {
              id: 'prof-1',
              deviceId: null,
              at: null,
              expiresAt: null,
              rev: 3,
              updatedAt: NOW - 3600_000,
              data: {
                name: 'Local Ollama',
                kind: 'managed-local',
                apiKey: REDACTED_SECRET,
              },
            },
          ],
          nextCursor: null,
        }
      }
      return { records: [], nextCursor: null }
    },
  },
})
