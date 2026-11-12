/**
 * The Home Assistant name (D1049): per connection, applied to `dev.name` only, never to the
 * device key — so a rename updates the same Home Assistant device. The reconcile skip must see
 * a rename, or an event-debounced pass would never announce it. A deleted connection takes its
 * names with it.
 *
 * Disarm: announce the plan's `dev` to every broker (drop `devBlockFor` in `announceToBrokers`)
 * and "each broker gets its own dev block" fails; drop the prune in `onTargetChanged` and
 * "a deleted connection" fails.
 */
import {
  EXPOSED_NAMES_STORE_KEY,
  type ExposedNameStore,
  type IScopedLogger,
  makeInMemoryRecords,
} from '@camstack/types'
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { type AnnounceClient, announceToBrokers } from '../announce.js'
import { devBlockFor, haNameValidator, namesByBroker } from '../exposed-name.js'
import { HaExportAddon } from '../ha-export.addon.js'
import { structureFingerprint } from '../reconcile-fingerprint.js'
import { ExportTargets, haExportTargetsKind, newTargetBody } from '../target-records.js'
import type { HaCmps, HaDeviceBlock } from '../types.js'

const quiet: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => quiet,
  withTags: () => quiet,
}

interface Sent {
  readonly brokerId: string
  readonly deviceKey: string
  readonly dev: HaDeviceBlock
}

function recordingClient(brokerId: string, sent: Sent[]): AnnounceClient {
  return {
    publishEntityChange: async (deviceKey: string, _cmps: HaCmps, dev: HaDeviceBlock) => {
      sent.push({ brokerId, deviceKey, dev })
      return true
    },
  }
}

const store = (names: Record<string, string>): ExposedNameStore => ({
  read: async () => ({ [EXPOSED_NAMES_STORE_KEY]: names }),
  write: async () => undefined,
})

describe('Home Assistant exposed name', () => {
  it('names the device per connection and keeps its key', async () => {
    const names = await namesByBroker(store({ 'ha-a': 'Cancello' }), 7, ['ha-a', 'ha-b'])
    const dev: HaDeviceBlock = {
      ids: ['camstack_7'],
      name: 'Gate cam',
      mf: 'CamStack',
      mdl: 'camera',
    }
    expect(devBlockFor(dev, names, 'ha-a')).toEqual({
      ...dev,
      name: 'Cancello',
    })
    expect(devBlockFor(dev, names, 'ha-b')).toBe(dev)
  })

  it('refuses control characters and over-long names', () => {
    expect(haNameValidator('Gate\u0007').ok).toBe(false)
    expect(haNameValidator('x'.repeat(101)).ok).toBe(false)
  })

  it('a rename changes the reconcile fingerprint', () => {
    const plan = { deviceKey: 'k' }
    const before = structureFingerprint(new Map([['k', { brokerIds: ['ha-a'], plan }]]))
    const after = structureFingerprint(
      new Map([
        [
          'k',
          {
            brokerIds: ['ha-a'],
            plan,
            exposedNames: new Map([['ha-a', 'Cancello']]),
          },
        ],
      ]),
    )
    expect(after).not.toBe(before)
  })

  it('each broker gets its own dev block, under the same device key', async () => {
    const sent: Sent[] = []
    const clients = new Map([
      ['ha-a', recordingClient('ha-a', sent)],
      ['ha-b', recordingClient('ha-b', sent)],
    ])
    const dev: HaDeviceBlock = {
      ids: ['camstack_7'],
      name: 'Gate cam',
      mf: 'CamStack',
      mdl: 'camera',
    }
    const delivered = await announceToBrokers(
      [
        {
          deviceId: 7,
          brokerIds: ['ha-a', 'ha-b', 'ha-gone'],
          plan: { deviceKey: 'camstack_7', cmps: {}, dev },
          exposedNames: new Map([['ha-a', 'Cancello']]),
        },
      ],
      (brokerId) => clients.get(brokerId),
      false,
      quiet,
    )
    expect(delivered).toBe(true)
    expect(sent).toEqual([
      { brokerId: 'ha-a', deviceKey: 'camstack_7', dev: { ...dev, name: 'Cancello' } },
      { brokerId: 'ha-b', deviceKey: 'camstack_7', dev },
    ])
  })

  it('a deleted connection takes its device names with it; another keeps its own', async () => {
    const store = new Map<number, Record<string, unknown>>([
      [7, { [EXPOSED_NAMES_STORE_KEY]: { hae_001: 'Cancello', hae_002: 'Gate' }, other: 1 }],
    ])
    const addon = new HaExportAddon()
    const memory = makeInMemoryRecords('homeassistant-export')
    await memory.records.declare({ 'ha-export-targets': haExportTargetsKind })
    const handle = memory.records.kind(haExportTargetsKind)
    await handle.put({
      id: 'hae_002',
      data: { ...newTargetBody('Office'), connectionId: 'ha_001' },
    })
    Reflect.set(
      addon,
      '_ctx',
      fakeAddonContext({
        id: 'homeassistant-export',
        settings: {
          readDeviceStore: async (id) => store.get(id) ?? {},
          writeDeviceStore: async (id, patch) => {
            store.set(id, { ...store.get(id), ...patch })
          },
          listDeviceStoreIds: async () => [...store.keys()],
          readDeviceStoreBatch: async (ids) =>
            new Map(ids.map((id): [number, Record<string, unknown>] => [id, store.get(id) ?? {}])),
        },
      }),
    )
    Reflect.set(addon, 'targetBook', await ExportTargets.load(handle))
    Reflect.set(addon, 'onConfigChanged', async () => {})

    // A dry run (the first pass of an all-or-none save) checks and writes nothing.
    const saveExposedName: unknown = Reflect.get(addon, 'saveExposedName')
    if (typeof saveExposedName !== 'function') throw new Error('no saveExposedName')
    expect(await saveExposedName.call(addon, 'hae_002', '7', 'Office gate', true)).toBe(false)

    const onTargetChanged: unknown = Reflect.get(addon, 'onTargetChanged')
    if (typeof onTargetChanged !== 'function') throw new Error('no onTargetChanged')
    await onTargetChanged.call(addon, 'hae_001', 'deleted')

    expect(store.get(7)).toEqual({ [EXPOSED_NAMES_STORE_KEY]: { hae_002: 'Gate' }, other: 1 })
  })
})
