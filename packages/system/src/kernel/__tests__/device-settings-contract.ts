/**
 * The per-device settings contract (D870), run on REAL SQLite against both
 * views of the one store: hub-main's door view and a forked runner's view.
 *
 * The incident this exists for (2026-10-17): a migration wrote the hub-main
 * store while the recorder, in a runner, read its own blobs — two places for
 * one fact, and every recording stopped for 35 minutes. So every behaviour is
 * asserted from BOTH sides, and a write made through one view is read through
 * the other.
 */
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type { ISettingsStoreProvider } from '@camstack/types'
import { expect } from 'vitest'
import { SqliteSettingsBackend } from '../../builtins/sqlite-storage/sqlite-settings-backend.js'
import { createDataStoreDispatch } from '../../builtins/storage-orchestrator/data-store-dispatch.js'
import { clearDeviceSettings, createDeviceSettingsStore } from '../device-settings-store.js'
import {
  createRunnerAddonSettings,
  type RunnerAddonSettingsClient,
} from '../moleculer/runner-addon-settings.js'
import { createRunnerDeviceSettings } from '../moleculer/runner-device-settings.js'
import { createSectionsStore } from '../sections-store.js'
import { createDoorSettingsView } from '../settings-door-view.js'

/** The per-device and addon-level methods both views offer. */
export interface DeviceView {
  readAddonStore(): Promise<Record<string, unknown>>
  readAddonStoreResult?(): Promise<{ kind: string }>
  readAddonStoreKeyResult(key: string): Promise<{ kind: string; value?: unknown }>
  writeAddonStore(patch: Record<string, unknown>): Promise<void>
  getSection(section: string): Promise<Record<string, unknown>>
  setSection(section: string, patch: Record<string, unknown>): Promise<void>
  readDeviceStore(deviceId: number): Promise<Record<string, unknown>>
  readDeviceStoreBatch(
    deviceIds: readonly number[],
  ): Promise<ReadonlyMap<number, Record<string, unknown>>>
  listDeviceStoreIds(): Promise<readonly number[]>
  writeDeviceStore(deviceId: number, patch: Record<string, unknown>): Promise<void>
  clearDeviceStore(deviceId: number): Promise<void>
}

export interface ContractHarness {
  readonly door: ISettingsStoreProvider
  readonly hubView: DeviceView
  readonly runnerView: DeviceView
  readonly close: () => Promise<void>
}

/** A door-shaped client the way a runner holds it: one `.query` / `.mutate` per call. */
export function clientOverDoor(door: ISettingsStoreProvider): RunnerAddonSettingsClient {
  return {
    get: { query: (input) => door.get(input) },
    set: { mutate: (input) => door.set(input) },
    query: { query: (input) => door.query(input) },
    transact: { mutate: (input) => door.transact(input) },
    deleteWhere: { mutate: (input) => door.deleteWhere(input) },
  }
}

export function hubViewOver(door: ISettingsStoreProvider, addonId: string): DeviceView {
  const sections = createSectionsStore(door)
  return createDoorSettingsView(addonId, door, {
    getSection: (section) => sections.read(section),
    setSection: (section, patch) => sections.write(section, patch),
  })
}

/** A runner's view: addon-level and per-device methods over its client. */
export function runnerViewOver(door: ISettingsStoreProvider, addonId: string): DeviceView {
  const client = clientOverDoor(door)
  return {
    ...createRunnerAddonSettings(client, addonId),
    ...createRunnerDeviceSettings(client, addonId),
  }
}

/** Both views over ONE real SQLite file, plus the door they share. */
export async function realHarness(
  addonId: string,
  wrap: (door: ISettingsStoreProvider) => ISettingsStoreProvider = (d) => d,
  wrapRunner: (door: ISettingsStoreProvider) => ISettingsStoreProvider = (d) => d,
): Promise<ContractHarness> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'device-settings-contract-'))
  const backend = new SqliteSettingsBackend(path.join(dir, 'camstack.db'))
  await backend.initialize()
  const door = wrap(createDataStoreDispatch(() => [backend]))
  return {
    door,
    hubView: hubViewOver(door, addonId),
    runnerView: runnerViewOver(wrapRunner(door), addonId),
    close: async () => {
      await backend.shutdown()
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

const ADDON = 'recorder'
const OTHER_ADDON = 'pipeline-orchestrator'

type ViewName = 'hub' | 'runner'
const VIEWS: readonly ViewName[] = ['hub', 'runner']

function pick(h: ContractHarness, name: ViewName): DeviceView {
  return name === 'hub' ? h.hubView : h.runnerView
}
function other(name: ViewName): ViewName {
  return name === 'hub' ? 'runner' : 'hub'
}

/**
 * Each check is a plain async function taking a harness, so the spec can also
 * run one against a deliberately broken harness (a disarm) and demand red.
 */
export const CONTRACT = {
  async writeInOneViewReadsFromTheOther(h: ContractHarness): Promise<void> {
    for (const writer of VIEWS) {
      const device = writer === 'hub' ? 101 : 102
      await pick(h, writer).writeDeviceStore(device, { enabled: true, bands: [1, 2] })
      const seen = await pick(h, other(writer)).readDeviceStore(device)
      expect(seen, `written by ${writer}, read by ${other(writer)}`).toEqual({
        enabled: true,
        bands: [1, 2],
      })
    }
  },

  async absentIsEmptyButUnreadableThrows(h: ContractHarness): Promise<void> {
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(777)).resolves.toEqual({})
    }
    const broken = createDeviceSettingsStore(
      {
        query: async () => {
          throw new Error('store did not answer')
        },
        transact: async () => ({ applied: true }),
        deleteWhere: async () => ({ deleted: 0 }),
      },
      ADDON,
    )
    const read = await broken.read(5)
    expect(read.kind).toBe('unreadable')
    // A failed read is NEVER the empty object — in either view.
    const failing = {
      ...h.door,
      query: async (): Promise<never> => {
        throw new Error('store did not answer')
      },
    }
    await expect(hubViewOver(failing, ADDON).readDeviceStore(5)).rejects.toThrow(
      /could not be read/,
    )
    await expect(
      createRunnerDeviceSettings(clientOverDoor(failing), ADDON).readDeviceStore(5),
    ).rejects.toThrow(/could not be read/)
    await expect(hubViewOver(failing, ADDON).readDeviceStoreBatch([5])).rejects.toThrow()
    await expect(hubViewOver(failing, ADDON).listDeviceStoreIds()).rejects.toThrow()
  },

  async concurrentMergesOnDifferentFieldsBothLand(h: ContractHarness): Promise<void> {
    await Promise.all([
      h.hubView.writeDeviceStore(201, { alpha: 1 }),
      h.runnerView.writeDeviceStore(201, { beta: 2 }),
      h.hubView.writeDeviceStore(201, { gamma: 3 }),
      h.runnerView.writeDeviceStore(201, { delta: 4 }),
    ])
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(201)).resolves.toEqual({
        alpha: 1,
        beta: 2,
        gamma: 3,
        delta: 4,
      })
    }
  },

  async undefinedRemovesAFieldAndNullKeepsIt(h: ContractHarness): Promise<void> {
    await h.hubView.writeDeviceStore(301, { keep: 1, drop: 2, nothing: 1 })
    await h.runnerView.writeDeviceStore(301, { drop: undefined, nothing: null })
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(301)).resolves.toEqual({ keep: 1, nothing: null })
    }
  },

  async listAndBatch(h: ContractHarness): Promise<void> {
    await h.hubView.writeDeviceStore(402, { a: 1 })
    await h.runnerView.writeDeviceStore(401, { b: 2 })
    await createDeviceSettingsStore(h.door, OTHER_ADDON).merge(403, { c: 3 })
    for (const name of VIEWS) {
      await expect(pick(h, name).listDeviceStoreIds(), name).resolves.toEqual([401, 402])
      const batch = await pick(h, name).readDeviceStoreBatch([401, 402, 999])
      expect(Object.fromEntries(batch), name).toEqual({ 401: { b: 2 }, 402: { a: 1 }, 999: {} })
    }
  },

  async clearRemovesOnlyThisAddonsDevice(h: ContractHarness): Promise<void> {
    await h.hubView.writeDeviceStore(501, { a: 1 })
    await h.hubView.writeDeviceStore(502, { a: 2 })
    await createDeviceSettingsStore(h.door, OTHER_ADDON).merge(501, { z: 9 })
    await h.runnerView.clearDeviceStore(501)
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(501)).resolves.toEqual({})
      await expect(pick(h, name).readDeviceStore(502)).resolves.toEqual({ a: 2 })
    }
    await expect(createDeviceSettingsStore(h.door, OTHER_ADDON).read(501)).resolves.toMatchObject({
      kind: 'present',
    })
  },

  async centralDeleteIsVisibleFromBothViews(h: ContractHarness): Promise<void> {
    await h.hubView.writeDeviceStore(601, { a: 1 })
    await h.runnerView.writeDeviceStore(602, { a: 2 })
    await createDeviceSettingsStore(h.door, OTHER_ADDON).merge(601, { z: 9 })
    const deleted = await clearDeviceSettings(h.door, 601)
    expect(deleted).toBe(2)
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(601)).resolves.toEqual({})
      await expect(pick(h, name).readDeviceStore(602)).resolves.toEqual({ a: 2 })
    }
  },

  /** A failing write in a merge must not leave its removals applied. */
  async addonSettingsWriteInOneViewReadsFromTheOther(h: ContractHarness): Promise<void> {
    await h.hubView.writeAddonStore({ host: 'cam.local', port: 80 })
    await h.runnerView.writeAddonStore({ port: 8080, extra: [1] })
    for (const name of VIEWS) {
      await expect(pick(h, name).readAddonStore(), name).resolves.toEqual({
        host: 'cam.local',
        port: 8080,
        extra: [1],
      })
    }
  },

  async addonSettingsAbsentIsEmptyButUnreadableIsNotEmpty(h: ContractHarness): Promise<void> {
    for (const name of VIEWS) {
      await expect(pick(h, name).readAddonStore(), name).resolves.toEqual({})
      await expect(pick(h, name).readAddonStoreKeyResult('nope'), name).resolves.toEqual({
        kind: 'absent',
      })
    }
    const failing = {
      ...h.door,
      query: async (): Promise<never> => {
        throw new Error('store did not answer')
      },
      get: async (): Promise<never> => {
        throw new Error('store did not answer')
      },
    }
    for (const view of [hubViewOver(failing, ADDON), runnerViewOver(failing, ADDON)]) {
      await expect(view.readAddonStore()).rejects.toThrow(/could not be read/)
      expect((await view.readAddonStoreKeyResult('x')).kind).toBe('unreadable')
    }
    const runner = runnerViewOver(failing, ADDON)
    expect((await runner.readAddonStoreResult?.())?.kind).toBe('failed')
  },

  async addonSettingsConcurrentMergesBothLand(h: ContractHarness): Promise<void> {
    await Promise.all([
      h.hubView.writeAddonStore({ a: 1 }),
      h.runnerView.writeAddonStore({ b: 2 }),
      h.hubView.writeAddonStore({ c: 3 }),
      h.runnerView.writeAddonStore({ d: 4 }),
    ])
    for (const name of VIEWS) {
      await expect(pick(h, name).readAddonStore()).resolves.toEqual({ a: 1, b: 2, c: 3, d: 4 })
    }
  },

  async addonSettingsUndefinedRemovesAField(h: ContractHarness): Promise<void> {
    await h.hubView.writeAddonStore({ keep: 1, drop: 2 })
    await h.runnerView.writeAddonStore({ drop: undefined })
    for (const name of VIEWS) {
      await expect(pick(h, name).readAddonStore()).resolves.toEqual({ keep: 1 })
    }
  },

  async addonSettingsMergeIsOneTransaction(h: ContractHarness): Promise<void> {
    await h.hubView.writeAddonStore({ old: 1, other: 2 })
    await expect(h.runnerView.writeAddonStore({ old: undefined, fresh: 10n })).rejects.toThrow()
    for (const name of VIEWS) {
      await expect(pick(h, name).readAddonStore(), name).resolves.toEqual({ old: 1, other: 2 })
    }
  },

  async sectionsAreSharedByBothViews(h: ContractHarness): Promise<void> {
    await h.runnerView.setSection('cluster', { name: 'home', size: 3 })
    await h.hubView.setSection('cluster', { size: 4 })
    for (const name of VIEWS) {
      await expect(pick(h, name).getSection('cluster'), name).resolves.toEqual({
        name: 'home',
        size: 4,
      })
    }
  },

  async mergeIsOneTransaction(h: ContractHarness): Promise<void> {
    await h.hubView.writeDeviceStore(701, { old: 1, other: 2 })
    // A bigint cannot be serialised: the engine throws while writing, AFTER it
    // has run the delete op of the same call.
    await expect(
      h.runnerView.writeDeviceStore(701, { old: undefined, fresh: 10n }),
    ).rejects.toThrow()
    for (const name of VIEWS) {
      await expect(pick(h, name).readDeviceStore(701), name).resolves.toEqual({
        old: 1,
        other: 2,
      })
    }
  },
}

export type ContractName = keyof typeof CONTRACT
