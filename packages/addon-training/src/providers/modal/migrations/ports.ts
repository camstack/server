import {
  isSecretMarker,
  type MigrationApiV1,
  resolveSecretMarkers,
  RevConflictError,
} from '@camstack/types'
import { trainingAccountEntryKind } from '../training-account-record-kinds.js'
import { accountIdOf, FLAT_ACCOUNT_ID } from './entries-to-records.js'
import type { ModalCataloguePorts } from './index.js'

/** The slice of the migration API these ports use. */
export type ModalPortsApi = Pick<MigrationApiV1, 'settings' | 'secrets' | 'log' | 'records'>

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** The keychain refs of a stored token secret: a marker names one, plain text names none. */
function refOf(value: unknown): readonly string[] {
  return isSecretMarker(value) ? [value.$secret] : []
}

/**
 * The account migrations' ports over {@link MigrationApiV1}, and nothing else (planning#447): the
 * addon's own settings store, its keychain handle and its `training-account` records.
 */
export function modalPortsOver(api: ModalPortsApi): ModalCataloguePorts {
  const handle = api.records.kind(trainingAccountEntryKind)
  const secrets = {
    resolve: async (refs: readonly string[]) => {
      const { values } = await api.secrets.resolve({ refs: [...refs] })
      return Object.fromEntries(
        refs.map((ref) => {
          const value = values[ref]
          return [
            ref,
            value === null || value === undefined
              ? { kind: 'missing' as const }
              : { kind: 'value' as const, value, version: 0 },
          ]
        }),
      )
    },
  }
  const readRaw = async () => (await api.settings.read({})).store
  /**
   * The secret a record already holds for an account whose old marker the keychain no longer
   * serves: a pass that released the old ref and crashed before it dropped the marker is finished
   * by the next one, which then sees the record's own copy and clears the dangling marker.
   */
  const heldSecret = async (id: string): Promise<string | undefined> => {
    const secret = (await handle.getResolved({ id }))?.data.tokenSecret
    return secret !== undefined && secret.length > 0 ? secret : undefined
  }
  const withHeldSecrets = async (
    store: Readonly<Record<string, unknown>>,
  ): Promise<Readonly<Record<string, unknown>>> => {
    const patch: Record<string, unknown> = {}
    if (isSecretMarker(store['tokenSecret'])) {
      const held = await heldSecret(FLAT_ACCOUNT_ID)
      if (held !== undefined) patch['tokenSecret'] = held
    }
    const list = store['entries']
    if (Array.isArray(list)) {
      patch['entries'] = await Promise.all(
        list.map(async (row, index) => {
          if (!isRecord(row) || !isSecretMarker(row['tokenSecret'])) return row
          const held = await heldSecret(accountIdOf(row, index))
          return held === undefined ? row : { ...row, tokenSecret: held }
        }),
      )
    }
    return { ...store, ...patch }
  }
  return {
    readStored: async () => {
      const resolved = await resolveSecretMarkers(await readRaw(), secrets, {
        unresolved: 'keep-marker',
      })
      const value = await withHeldSecrets(resolved.value)
      // A secret that is still a marker was not resolved: abort before anything is written.
      if (isSecretMarker(value['tokenSecret'])) {
        throw new Error('the old flat Modal token secret could not be resolved')
      }
      const list = value['entries']
      if (
        Array.isArray(list) &&
        list.some((row) => isSecretMarker(Reflect.get(row, 'tokenSecret')))
      ) {
        throw new Error('an old Modal token secret could not be resolved')
      }
      return value
    },
    readRawStored: readRaw,
    warn: (message) => {
      void api.log.warn({ message })
    },
    readRecord: async (id) => {
      const row = await handle.getResolved({ id })
      if (row === null) return null
      return { tokenId: row.data.tokenId, hasSecret: (row.data.tokenSecret ?? '').length > 0 }
    },
    putRecord: async (id, body) => {
      if ((await handle.get({ id })) !== null) return 'exists'
      try {
        await handle.put({ id, data: body, ifRev: 0 })
      } catch (err: unknown) {
        if (err instanceof RevConflictError) return 'exists'
        throw err
      }
      return 'created'
    },
    clearOldSecrets: async (ids) => {
      // The old token secret leaves the keychain AND the settings: the record holds the copy. The
      // refs go first, so a crash or a failed write afterwards leaves a dangling marker (the next
      // pass finishes it) and never a live keychain entry no marker names. Deleting an unknown ref
      // is not an error, so a re-run is harmless.
      const store = await readRaw()
      const refs: string[] = []
      const flat = ids.includes(FLAT_ACCOUNT_ID)
      if (flat) refs.push(...refOf(store['tokenSecret']))
      const rows = store['entries']
      const touched =
        Array.isArray(rows) && rows.some((row) => isRecord(row) && ids.includes(String(row['id'])))
      if (touched) {
        for (const row of rows) {
          if (isRecord(row) && ids.includes(String(row['id'])))
            refs.push(...refOf(row['tokenSecret']))
        }
      }
      if (refs.length > 0) await api.secrets.delete({ refs })
      if (flat) await api.settings.deleteKeys({ keys: ['tokenSecret'] })
      if (touched) {
        const kept = rows.map((row) => {
          if (!isRecord(row) || !ids.includes(String(row['id']))) return row
          const { tokenSecret: _cleared, ...rest } = row
          return rest
        })
        await api.settings.write({ patch: { entries: kept } })
      }
    },
  }
}
