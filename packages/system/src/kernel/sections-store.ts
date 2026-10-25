/**
 * Settings SECTIONS (D870): a section is the `system-settings` rows under
 * `<section>.` - one place for every process. A forked runner used to keep a
 * `sections` blob table of its own that nobody else wrote, so `getSection('server')`
 * answered `{}` there and the real values in hub-main.
 *
 * A section a bootstrap file owns (`auth`, `server`, ...) is answered only for
 * the keys the store may answer ({@link storeMayAnswer}); the rest of such a
 * section is env + config.yaml and lives in the hub process alone.
 */
import type { ISettingsStoreProvider } from '@camstack/types'
import { storeMayAnswer } from './system-settings-policy.js'
import { loadSystemSettingsPrefix } from './settings-door-view.js'

/** The door slice sections need. */
export type SectionsDoor = Pick<ISettingsStoreProvider, 'query' | 'get' | 'set'>

export interface SectionsStore {
  /** Stored keys of a section, or a throw when the store cannot be asked. */
  read(section: string): Promise<Record<string, unknown>>
  /** Set each key of `patch`. Errors propagate; no read, so no lost update. */
  write(section: string, patch: Readonly<Record<string, unknown>>): Promise<void>
}

export function createSectionsStore(door: SectionsDoor): SectionsStore {
  return {
    read: (section) =>
      loadSystemSettingsPrefix(door, `${section}.`, (key) => storeMayAnswer(`${section}.${key}`)),
    write: async (section, patch) => {
      for (const [key, value] of Object.entries(patch)) {
        await door.set({ collection: 'system-settings', key: `${section}.${key}`, value })
      }
    },
  }
}
