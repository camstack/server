/**
 * The legacy data a node that last ran a pre-record release holds for waste-collections: the
 * addon-level `sources` setting in the canonical `addon-settings` layout, written by hand in the
 * shape that release stored, with a MARK on every row (a typed-args row, a legacy `argsJson` row
 * carrying a password raw, a disabled one) so a copy that rewrote a row is caught by the replay.
 */
import type Database from 'better-sqlite3'

export const SEED_ADDON_ID = 'waste-collections'

export interface WasteSeedMarks {
  /** Source id to the label the seed gave it. */
  readonly labels: Readonly<Record<string, string>>
  /** The password the legacy `argsJson` row carried raw. */
  readonly rawPassword: string
  /** A neighbour addon's `sources` key, which no step may touch. */
  readonly neighbour: string
}

export function seedWasteLegacy(db: Database.Database): WasteSeedMarks {
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const put = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  const sources = [
    {
      id: 'home',
      label: 'Home mark',
      module: 'junker_app',
      argsJson: JSON.stringify({ city: 'Torino', password: 'hunter2', pin: 4821 }),
      enabled: true,
    },
    {
      id: 'cabin',
      label: 'Cabin mark',
      module: 'ics',
      args: { url: 'https://example.com/cabin.ics' },
      enabled: false,
    },
  ]
  put.run(
    `${SEED_ADDON_ID}.sources`,
    JSON.stringify({ addonId: SEED_ADDON_ID, key: 'sources', value: sources }),
  )
  put.run(
    'other-addon.sources',
    JSON.stringify({ addonId: 'other-addon', key: 'sources', value: 'neighbour-mark' }),
  )
  return {
    labels: { home: 'Home mark', cabin: 'Cabin mark' },
    rawPassword: 'hunter2',
    neighbour: 'neighbour-mark',
  }
}
