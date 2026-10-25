/**
 * The forked runner's addon-level `ctx.settings` methods (D870): the SAME
 * modules hub-main's view uses ({@link ../addon-settings-store.ts},
 * {@link ../sections-store.ts}) over this runner's settings-store client, so an
 * addon's settings are one set of rows whichever process asks.
 */
import type { AddonStoreRead, StoredKeyRead } from '@camstack/types'
import { createAddonSettingsStore, type AddonSettingsDoor } from '../addon-settings-store.js'
import { createSectionsStore, type SectionsDoor } from '../sections-store.js'
import type { RunnerSettingsClient } from './runner-device-settings.js'

/** The client calls the addon-level adapter uses, on top of the device ones. */
export interface RunnerAddonSettingsClient extends RunnerSettingsClient {
  readonly get: { query: AddonSettingsDoor['get'] }
  readonly set: { mutate: SectionsDoor['set'] }
}

export interface RunnerAddonSettingsView {
  readAddonStore(): Promise<Record<string, unknown>>
  readAddonStoreResult(): Promise<AddonStoreRead>
  readAddonStoreKeyResult(key: string): Promise<StoredKeyRead>
  writeAddonStore(patch: Record<string, unknown>): Promise<void>
  getSection(section: string): Promise<Record<string, unknown>>
  setSection(section: string, patch: Record<string, unknown>): Promise<void>
}

/** @param client the hub's `settingsStore` client; `undefined` makes every call THROW. */
export function createRunnerAddonSettings(
  client: RunnerAddonSettingsClient | undefined,
  addonId: string,
): RunnerAddonSettingsView {
  if (client === undefined) {
    const refuse = async (): Promise<never> => {
      throw new Error(`settings of "${addonId}": settings store not wired`)
    }
    return {
      readAddonStore: refuse,
      readAddonStoreResult: async () => ({ kind: 'failed', error: 'settings store not wired' }),
      readAddonStoreKeyResult: async () => ({
        kind: 'unreadable',
        reason: 'store-read-failed',
        error: 'settings store not wired',
      }),
      writeAddonStore: refuse,
      getSection: refuse,
      setSection: refuse,
    }
  }
  const door = {
    query: (input: Parameters<AddonSettingsDoor['query']>[0]) => client.query.query(input),
    get: (input: Parameters<AddonSettingsDoor['get']>[0]) => client.get.query(input),
    set: (input: Parameters<SectionsDoor['set']>[0]) => client.set.mutate(input),
    transact: (input: Parameters<AddonSettingsDoor['transact']>[0]) =>
      client.transact.mutate(input),
  }
  const store = createAddonSettingsStore(door, addonId)
  const sections = createSectionsStore(door)
  return {
    readAddonStore: async () => {
      const read = await store.read()
      switch (read.kind) {
        case 'present':
          return { ...read.value }
        case 'absent':
          return {}
        case 'unreadable':
          throw new Error(`settings of "${addonId}" could not be read: ${read.error}`)
      }
    },
    readAddonStoreResult: async () => {
      const read = await store.read()
      switch (read.kind) {
        case 'present':
          return { kind: 'value', value: { ...read.value } }
        case 'absent':
          return { kind: 'missing' }
        case 'unreadable':
          return { kind: 'failed', error: read.error }
      }
    },
    readAddonStoreKeyResult: async (key) => {
      const read = await store.readKey(key)
      return read.kind === 'unreadable'
        ? { kind: 'unreadable', reason: 'store-read-failed', error: read.error }
        : read
    },
    writeAddonStore: (patch) => store.merge(patch),
    getSection: (section) => sections.read(section),
    setSection: (section, patch) => sections.write(section, patch),
  }
}
