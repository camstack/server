/**
 * System → Data → Migrations (`/system/data?tab=migrations`): the migration
 * ledger joined with its catalogue — an applied hub SQL migration, an applied
 * addon procedure, one pending, one failed with its error, and one blocked by
 * the failure.
 */
import { defineFixtures } from './_define'
import { D, H, NOW } from './_time'

const META = (
  id: string,
  owner: string,
  seq: number,
  bodyKind: 'sql' | 'plan' | 'procedure',
  description: string,
  extra: Record<string, unknown> = {},
) => ({
  id,
  owner,
  level: owner === 'hub' ? 'hub-store' : 'addon-state',
  seq,
  dependsOn: [],
  store: owner === 'hub' ? 'settings' : 'addon-files',
  scope: 'cluster',
  onFailure: 'block-owner',
  bodyKind,
  description,
  fixtureMark: 'legacyMark',
  ...extra,
})

const HUB_SQL = META(
  'hub/2026-10-02-split-device-settings',
  'hub',
  1,
  'sql',
  'Split the per-device settings table into one row per scope.',
)
const ADDON_PROC = META(
  'example-provider/2026-10-05-move-token-to-keychain',
  'example-provider',
  1,
  'procedure',
  'Move the stored access token into the keychain and clear the plain value.',
)
const PENDING = META(
  'hub/2026-10-08-index-event-tracks',
  'hub',
  2,
  'sql',
  'Add the covering index the track timeline reads.',
  { store: 'events', dependsOn: [HUB_SQL.id] },
)
const FAILED = META(
  'example-provider/2026-10-07-rebuild-device-links',
  'example-provider',
  2,
  'plan',
  'Rebuild the device links from the registry.',
  { dependsOn: [ADDON_PROC.id] },
)
const BLOCKED = META(
  'example-provider/2026-10-08-prune-device-links',
  'example-provider',
  3,
  'procedure',
  'Prune links whose device no longer exists.',
  { dependsOn: [FAILED.id] },
)

const ledger = (meta: ReturnType<typeof META>, status: string, extra: Record<string, unknown>) => ({
  id: meta.id,
  database: meta.store === 'events' ? 'events' : 'settings',
  owner: meta.owner,
  level: meta.level,
  seq: meta.seq,
  status,
  attempts: 1,
  appliedAt: null,
  codeVersion: '1.2.80',
  planSummary: null,
  progress: null,
  error: null,
  reason: null,
  nodeId: 'hub',
  bootId: 'b7f3a1',
  meta,
  ...extra,
})

const ENTRIES = [
  ledger(HUB_SQL, 'applied', {
    appliedAt: NOW - 6 * D,
    planSummary: { device_settings: 128, device_scopes: 412 },
  }),
  ledger(ADDON_PROC, 'applied', { appliedAt: NOW - 4 * D, planSummary: { moved: 1 } }),
  ledger(FAILED, 'failed', {
    attempts: 3,
    error: 'precondition mismatch: the registry changed while the plan was computed',
  }),
  ledger(BLOCKED, 'blocked', { attempts: 0, reason: 'dependency-failed' }),
]

export default defineFixtures({
  area: 'migrations',
  description: 'Data → Migrations: ledger rows joined with their catalogue, pending and failed',
  handlers: {
    'migrations.listLedger': { entries: ENTRIES },
    'migrations.listPending': {
      pending: [
        { meta: PENDING, database: 'events', state: 'pending', reason: null },
        { meta: FAILED, database: 'settings', state: 'failed', reason: null },
        { meta: BLOCKED, database: 'settings', state: 'blocked', reason: 'dependency-failed' },
      ],
    },
    'migrations.dryRun': (i: { id: string }) => ({
      id: i.id,
      ok: true,
      error: null,
      rowsChanged: 0,
      tables: [{ table: 'events_tracks', before: 1204, after: 1204 }],
    }),
  },
})
