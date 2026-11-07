/**
 * The legacy data a node that last ran a pre-record release holds for training-modal: the
 * addon-level `entries` setting (two accounts, each token secret a keychain marker) in the
 * canonical `addon-settings` layout, written by hand in the shape that release stored, with a
 * MARK on every row so a step that rewrote a row it does not own is caught by the replay.
 */
import type Database from 'better-sqlite3'

export const SEED_ADDON_ID = 'training-modal'

export interface ModalSeedMarks {
  /** Account id to its keychain ref and the secret that ref holds. */
  readonly accounts: Readonly<Record<string, { readonly ref: string; readonly secret: string }>>
  /** A key the migrations do not know: it must survive both. */
  readonly unrelated: { readonly key: string; readonly value: string }
  /** A neighbour addon's `entries` key, which no step may touch. */
  readonly neighbour: string
}

const ROW = {
  tokenId: 'ak-x',
  environment: 'main',
  gpuType: 'A10G',
  region: 'eu',
  costCapUsd: 7,
  maxRuntimeHours: 2,
  failedDatasetGraceHours: 12,
}

export function seedModalLegacy(db: Database.Database): ModalSeedMarks {
  db.exec('CREATE TABLE "addon-settings" (id TEXT PRIMARY KEY NOT NULL, data TEXT NOT NULL)')
  const put = db.prepare('INSERT INTO "addon-settings" (id, data) VALUES (?, ?)')
  const row = (key: string, value: unknown): void => {
    put.run(`${SEED_ADDON_ID}.${key}`, JSON.stringify({ addonId: SEED_ADDON_ID, key, value }))
  }
  row('entries', [
    { ...ROW, id: 'acc-home', name: 'Home mark', tokenSecret: { $secret: 'ref-home', v: 1 } },
    { ...ROW, id: 'acc-lab', name: 'Lab mark', tokenSecret: { $secret: 'ref-lab', v: 1 } },
  ])
  row('someUnrelatedKey', 'keep-me')
  put.run(
    'other-addon.entries',
    JSON.stringify({ addonId: 'other-addon', key: 'entries', value: 'neighbour-mark' }),
  )
  return {
    accounts: {
      'acc-home': { ref: 'ref-home', secret: 'as-home' },
      'acc-lab': { ref: 'ref-lab', secret: 'as-lab' },
    },
    unrelated: { key: 'someUnrelatedKey', value: 'keep-me' },
    neighbour: 'neighbour-mark',
  }
}
