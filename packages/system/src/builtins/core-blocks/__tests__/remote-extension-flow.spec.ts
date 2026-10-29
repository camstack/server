/**
 * The Remote extension end to end on one media player (D963, D964): the real
 * runtime (`buildRemoteRuntime`) over an in-memory settings store, a template
 * record and a fake cluster API, reached the way a caller reaches it — the
 * saved configuration, then the dispatch redirect for the media-player
 * commands and `sendCommand` for the volume steps and power.
 */
import {
  type AddonApi,
  createRecordsAccess,
  DeviceType,
  type CapCall,
  type RemoteBindingAction,
  type RemoteConfig,
} from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { makeRecordsWorld } from '../../sqlite-storage/__tests__/support/records-world.js'
import { coreBlocksRecordKinds } from '../record-kinds.js'
import { remoteCallRedirect } from '../remote-call-redirect.js'
import { buildRemoteRuntime, type RemoteRuntime } from '../remote-wiring.js'
import { recordingLogger } from './fixtures.js'

const TV = 901
const BOARD = 902

const irSend = (tag: string): RemoteBindingAction => ({
  kind: 'cap',
  deviceId: BOARD,
  cap: 'ir-transmitter',
  method: 'send',
  args: { timings: [9000, -4500, 560, -560], settings: { tag } },
})

const LAYOUT = {
  columns: 2,
  rows: 1,
  buttons: [
    { id: 'p', role: 'power', col: 0, row: 0, colSpan: 1, rowSpan: 1 },
    { id: 'v', role: 'volume_up', col: 1, row: 0, colSpan: 1, rowSpan: 1 },
  ],
}

interface World {
  readonly runtime: RemoteRuntime
  readonly sent: CapCall[]
  readonly nativeCalls: string[]
  readonly templateId: string
  readonly redirect: ReturnType<typeof remoteCallRedirect>
  readonly running: { value: boolean | null }
}

async function world(bound: Partial<RemoteConfig>): Promise<World> {
  const w = makeRecordsWorld()
  await w.provider.init()
  const records = createRecordsAccess({
    owner: 'core-blocks',
    transport: w.transportFor('core-blocks'),
    secrets: null,
  })
  await records.declare(coreBlocksRecordKinds)
  const logger = recordingLogger().logger

  const rows = new Map<number, Record<string, unknown>>()
  const settings = {
    readDeviceStore: async (id: number) => ({ ...rows.get(id) }),
    writeDeviceStore: async (id: number, patch: Record<string, unknown>) => {
      rows.set(id, { ...rows.get(id), ...patch })
    },
    readDeviceStoreBatch: async (ids: readonly number[]) =>
      new Map(ids.map((id) => [id, { ...rows.get(id) }])),
    listDeviceStoreIds: async () => [...rows.keys()],
  }

  const sent: CapCall[] = []
  const nativeCalls: string[] = []
  const running: { value: boolean | null } = { value: null }
  // Test double: only the routers the remote reaches. The remote addresses the cluster
  // through `ctx.api`, whose full type is the whole generated surface.
  const api = {
    deviceManager: {
      getDevice: {
        query: async ({ deviceId }: { deviceId: number }) =>
          deviceId === TV ? { id: TV, name: 'Living room TV', type: DeviceType.MediaPlayer } : null,
      },
    },
    irTransmitter: {
      send: {
        mutate: async (input: { deviceId: number; timings: number[]; settings?: object }) => {
          sent.push({
            deviceId: input.deviceId,
            cap: 'ir-transmitter',
            method: 'send',
            args: {
              timings: input.timings,
              ...(input.settings ? { settings: input.settings } : {}),
            },
          })
        },
      },
    },
    mediaPlayer: {
      getStatus: { query: async () => null },
      play: { mutate: async () => void nativeCalls.push('play') },
      pause: { mutate: async () => void nativeCalls.push('pause') },
      setMute: { mutate: async () => void nativeCalls.push('setMute') },
    },
    runningState: {
      getStatus: {
        query: async () =>
          running.value === null
            ? Promise.reject(new Error('no source'))
            : { running: running.value, since: 1, source: 'native', phase: null, lastFetchedAt: 1 },
      },
    },
  } as unknown as AddonApi

  const runtime = buildRemoteRuntime({ records, settings, api: () => api, logger })
  const made = await runtime.templates.create({ kind: 'remote', name: 'TV', payload: LAYOUT })
  if (made.status !== 'saved') throw new Error('the layout template was refused')
  const templateId = made.template.id
  const saved = await runtime.remote.setConfig({
    deviceId: TV,
    config: {
      layoutTemplateId: templateId,
      defaultTransmitterId: BOARD,
      bindings: {},
      customButtons: [],
      power: { mode: 'toggle' },
      ...bound,
    },
  })
  expect(saved).toEqual({ status: 'saved' })
  const redirect = remoteCallRedirect({
    remote: runtime.remote,
    hasNative: () => true,
    logger,
  })
  return { runtime, sent, nativeCalls, templateId, redirect, running }
}

const mediaCall = (method: string, args: Record<string, unknown> = {}) => ({
  capName: 'media-player',
  method,
  deviceId: TV,
  args: { deviceId: TV, ...args },
})

describe('the Remote extension on a media player, end to end', () => {
  it('play and setMute run their bindings through the transmitter, and the native cap does not run', async () => {
    const w = await world({
      bindings: {
        play: { action: irSend('play') },
        mute: { action: irSend('mute') },
      },
    })
    expect(await w.redirect.attempt(mediaCall('play'))).toEqual({
      kind: 'redirected',
      result: undefined,
    })
    expect(await w.redirect.attempt(mediaCall('setMute', { muted: true }))).toEqual({
      kind: 'redirected',
      result: undefined,
    })
    expect(w.sent.map((c) => c.args?.['settings'])).toEqual([{ tag: 'play' }, { tag: 'mute' }])
    expect(w.sent.every((c) => c.deviceId === BOARD)).toBe(true)
    expect(w.nativeCalls).toEqual([])
  })

  it('a volume step sends the bound code as many times as the caller asked', async () => {
    const w = await world({ bindings: { volume_up: { action: irSend('vol+') } } })
    const result = await w.runtime.remote.sendCommand({
      deviceId: TV,
      role: 'volume_up',
      repeat: 5,
    })
    expect(result).toEqual({ status: 'sent', sends: 5 })
    expect(w.sent).toHaveLength(5)
    // The repeat is the caller's: nothing about it was stored.
    expect(JSON.stringify(await w.runtime.remote.getConfig({ deviceId: TV }))).not.toContain(
      'repeat',
    )
  })

  it('an unbound role is left to the native cap', async () => {
    const w = await world({ bindings: { play: { action: irSend('play') } } })
    expect(await w.redirect.attempt(mediaCall('pause'))).toEqual({ kind: 'not-redirected' })
    expect(w.sent).toEqual([])
    expect(
      await w.runtime.remote.sendCommand({ deviceId: TV, role: 'pause', repeat: 1 }),
    ).toMatchObject({ status: 'refused', reason: 'unbound-role' })
  })

  it('a toggle power is not sent again once the device is already in that state', async () => {
    const w = await world({ bindings: { power: { action: irSend('power') } } })
    const on = () => w.runtime.remote.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 })
    expect(await on()).toEqual({ status: 'sent', sends: 1 })
    expect(await on()).toEqual({ status: 'skipped', reason: 'already-in-state' })
    expect(w.sent).toHaveLength(1)
  })

  it('a running-state reading outranks what the remote assumed', async () => {
    const w = await world({ bindings: { power: { action: irSend('power') } } })
    const off = () => w.runtime.remote.sendCommand({ deviceId: TV, role: 'power_off', repeat: 1 })
    expect(
      await w.runtime.remote.sendCommand({ deviceId: TV, role: 'power_on', repeat: 1 }),
    ).toEqual({
      status: 'sent',
      sends: 1,
    })
    // The TV was switched off by hand: the source says so, so power_off has nothing to do.
    w.running.value = false
    expect(await off()).toEqual({ status: 'skipped', reason: 'already-in-state' })
    expect(w.sent).toHaveLength(1)
  })

  it('refuses a template that is in use, naming the device', async () => {
    const w = await world({})
    expect(await w.runtime.templates.delete({ id: w.templateId })).toMatchObject({
      status: 'in-use',
      devices: [{ deviceId: TV, name: 'Living room TV' }],
    })
  })
})
