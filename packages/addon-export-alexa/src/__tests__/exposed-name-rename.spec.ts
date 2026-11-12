/**
 * Renaming a device on one Alexa skill (D1049): the rename is pushed as an AddOrUpdateReport under
 * the SAME endpoint id with the new friendlyName, and the name is per skill — a second skill
 * sharing the store keeps calling the device what it called it.
 *
 * Wired like `SkillRuntime.setExposedName`: one per-device store shared by the skills, the real
 * `SyncEngine`, the real endpoint builder reading the skill's own saved name.
 *
 * Disarm: skipping the push in `renameOnSkill` (or saving under a fixed instance id) fails the
 * first case.
 */
import {
  EXPOSED_NAMES_STORE_KEY,
  type ExposedNameStore,
  ExportNameRefusedError,
  type IScopedLogger,
  readExposedName,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { alexaNameValidator } from '../endpoints/alexa-name.js'
import { buildGenericDeviceEndpoint } from '../endpoints/generic-device.js'
import type { AlexaEndpoint } from '../endpoints/types.js'
import { renameOnSkill } from '../exposed-name-rename.js'
import { SyncEngine } from '../sync-engine.js'

const logger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
  withTags: () => logger,
}

const DEVICE = 7
const PLUG = {
  deviceId: DEVICE,
  stableId: 's7',
  name: 'Kitchen plug',
  type: 'switch',
  capNames: ['switch'],
}

function sharedStore() {
  const blobs = new Map<number, Record<string, unknown>>()
  let writes = 0
  const store: ExposedNameStore = {
    read: async (id) => blobs.get(id) ?? {},
    write: async (id, patch) => {
      writes += 1
      blobs.set(id, { ...blobs.get(id), ...patch })
    },
  }
  return { store, blobs, writes: () => writes }
}

/** One skill: its sync engine posts to one linked account and records what it sent. */
function skill(instanceId: string, store: ExposedNameStore) {
  const posted: AlexaEndpoint[][] = []
  const exported: Record<number, readonly string[]> = {}
  const signatures: Record<number, string> = {}
  const buildEndpoints = async (deviceId: number): Promise<AlexaEndpoint[]> => {
    const name = readExposedName(await store.read(deviceId), instanceId, alexaNameValidator)
    const endpoint = buildGenericDeviceEndpoint({
      ...PLUG,
      ...(name !== null ? { alexaName: name } : {}),
    })
    return endpoint === null ? [] : [endpoint]
  }
  const engine = new SyncEngine({
    logger,
    listExposed: () => [{ deviceId: DEVICE, exposedAt: 0, capabilities: [] }],
    listLinkedAccounts: () => [{ userId: 'user-a', username: 'user-a', linkedAt: 0 }],
    hasProactiveCredentials: () => true,
    buildEndpoints,
    mayRetire: () => false,
    afterPush: () => {},
    filterForAccount: async (_userId, endpoints) => endpoints,
    postAddOrUpdate: async (_userId, endpoints) => {
      posted.push([...endpoints])
      return true
    },
    postDelete: async () => true,
    getExportedEndpoints: () => exported,
    setExportedEndpoints: async (next) => {
      Object.assign(exported, next)
    },
    getExportedSignatures: () => signatures,
    setExportedSignatures: async (next) => {
      Object.assign(signatures, next)
    },
  })
  const rename = (raw: unknown, dryRun = false) =>
    renameOnSkill(
      {
        instanceId,
        store,
        logger,
        isExposed: (id) => id === DEVICE,
        push: (id) => engine.pushDevice(id),
      },
      String(DEVICE),
      raw,
      { dryRun },
    )
  return { engine, posted, buildEndpoints, rename }
}

describe('renaming a device on one Alexa skill', () => {
  it('pushes AddOrUpdateReport with the new friendlyName under the same endpoint id', async () => {
    const { store } = sharedStore()
    const a = skill('export-alexa', store)
    const [before] = await a.buildEndpoints(DEVICE)

    await a.rename('Coffee machine')

    await vi.waitFor(() => expect(a.posted).toHaveLength(1))
    const [sent] = a.posted[0] ?? []
    expect(sent?.friendlyName).toBe('Coffee machine')
    expect(sent?.endpointId).toBe(before?.endpointId)
  })

  it('is per skill: the other skill keeps the device name and is not pushed', async () => {
    const { store, blobs } = sharedStore()
    const a = skill('export-alexa', store)
    const b = skill('alexa-skill-2b', store)

    await a.rename('Coffee machine')
    await b.rename('Macchinetta')
    await vi.waitFor(() => expect(b.posted).toHaveLength(1))

    expect(blobs.get(DEVICE)?.[EXPOSED_NAMES_STORE_KEY]).toEqual({
      'export-alexa': 'Coffee machine',
      'alexa-skill-2b': 'Macchinetta',
    })
    expect((await a.buildEndpoints(DEVICE))[0]?.friendlyName).toBe('Coffee machine')
    expect((await b.buildEndpoints(DEVICE))[0]?.friendlyName).toBe('Macchinetta')
    expect(a.posted).toHaveLength(1)
  })

  it('a refused name and a dry run write nothing and push nothing', async () => {
    const { store, writes } = sharedStore()
    const a = skill('export-alexa', store)
    await expect(a.rename('Coffee!')).rejects.toBeInstanceOf(ExportNameRefusedError)
    await a.rename('Coffee machine', true)
    expect(writes()).toBe(0)
    expect(a.posted).toEqual([])
  })
})
