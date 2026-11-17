/**
 * D1059 / D49: the Reolink network read (`getNetworkInfo`) swallows each of its
 * sub-reads. On the host path it merges cmd 76 (the one that carries the MAC) with
 * cmd 93, then falls back to cmd 104 — so an answer with an ip and no MAC may mean
 * "cmd 76 timed out", not "this device has no MAC". A kind the answer lacks is
 * therefore `unread` and keeps its stored value; it is never removed.
 *
 * On a hub or NVR child (the channel path) cmd 76 may answer with the HUB's own
 * MAC and IP, so a child declares neither as its identity.
 *
 * The writer stores what `device-manager.setIdentifiers` would (`mergeIdentifiers`).
 */

import { ReolinkBaichuanApi, type ReolinkDeviceInfo } from '@apocaliss92/nodelink-js'
import {
  mergeIdentifiers,
  type DeviceContext,
  type DeviceIdentifiers,
  type IScopedLogger,
  type SetIdentifiersInput,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { populateReolinkMetadata } from '../metadata-populator.js'

const INFO: ReolinkDeviceInfo = {
  type: 'RLC-811A',
  firmwareVersion: 'v3.1',
  serialNumber: 'SN811',
}

interface NetworkAnswer {
  readonly ip?: string
  readonly mac?: string
  readonly activeLink?: string
}

const FULL_NETWORK: NetworkAnswer = {
  mac: 'EC:71:DB:00:00:11',
  ip: '192.0.2.11',
}

function makeLogger(): IScopedLogger {
  const l: IScopedLogger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(() => l),
    withTags: vi.fn(() => l),
  }
  return l
}

interface StoredWorld {
  stored: DeviceIdentifiers | null
}

function makeTarget(world: StoredWorld) {
  const api = {
    deviceManager: {
      setMetadata: { mutate: vi.fn(async () => {}) },
      setIdentifiers: {
        mutate: async (input: SetIdentifiersInput) => {
          world.stored = mergeIdentifiers(world.stored, input.identifiers, input.unread ?? [])
        },
      },
    },
  }
  // The populator touches only `logger` and `api.deviceManager` of the device context.
  const ctx = { logger: makeLogger(), api } as unknown as DeviceContext
  return {
    id: 11,
    ctx,
    uid: undefined,
    setDeviceCachePatch: vi.fn(async () => {}),
  }
}

function makeApi(network: NetworkAnswer | undefined): ReolinkBaichuanApi {
  const api: ReolinkBaichuanApi = Object.create(ReolinkBaichuanApi.prototype)
  vi.spyOn(api, 'getInfo').mockResolvedValue(INFO)
  vi.spyOn(api, 'getNetworkInfo').mockResolvedValue(network)
  vi.spyOn(api, 'getChannelCount').mockResolvedValue(1)
  return api
}

describe('populateReolinkMetadata — identifiers across boots', () => {
  it('keeps the stored MAC when the network read answers with an ip only', async () => {
    const world: StoredWorld = { stored: null }
    const target = makeTarget(world)
    await populateReolinkMetadata(makeApi(FULL_NETWORK), undefined, target)
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['ec:71:db:00:00:11'])

    await populateReolinkMetadata(makeApi({ ip: '192.0.2.12' }), undefined, target)
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['ec:71:db:00:00:11'])
    expect(world.stored?.ip?.value).toBe('192.0.2.12')
    expect(world.stored?.serial?.value).toBe('reolink:sn811')
  })

  it('keeps the stored MAC and IP when the network read answers with neither', async () => {
    const world: StoredWorld = { stored: null }
    const target = makeTarget(world)
    await populateReolinkMetadata(makeApi(FULL_NETWORK), undefined, target)
    await populateReolinkMetadata(makeApi({ activeLink: 'LAN' }), undefined, target)
    await populateReolinkMetadata(makeApi(undefined), undefined, target)
    expect(world.stored?.mac?.map((m) => m.value)).toEqual(['ec:71:db:00:00:11'])
    expect(world.stored?.ip?.value).toBe('192.0.2.11')
  })

  it('a hub child never declares the MAC or IP its channel read answered with', async () => {
    const world: StoredWorld = { stored: null }
    const target = makeTarget(world)
    await populateReolinkMetadata(makeApi(FULL_NETWORK), 2, target)
    expect(world.stored?.mac).toBeUndefined()
    expect(world.stored?.ip).toBeUndefined()
    expect(world.stored?.serial?.value).toBe('reolink:sn811')
  })
})
