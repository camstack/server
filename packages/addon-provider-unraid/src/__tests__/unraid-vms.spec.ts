import type { IScopedLogger } from '@camstack/types'
import { UnraidApiError } from 'node-unraid'
import { describe, expect, it, vi } from 'vitest'
import { settingsToConnection } from '../config.js'
import type { UnraidClientLike, UnraidVmInfo } from '../unraid-client-contract.js'
import {
  createLiveUnraidClient,
  UnraidClientError,
  type UnraidApiSource,
} from '../unraid-client-live.js'
import { UnraidIntegrationManager } from '../unraid-integration-manager.js'

type VmsSource = UnraidApiSource['vms']

function vmsSource(over: Partial<VmsSource> = {}): VmsSource {
  return {
    list: async () => [
      { id: 'srv:uuid-ccu', name: 'CCU3', state: 'RUNNING' },
      { id: 'srv:uuid-win', name: null, state: 'SHUTOFF' },
      { id: 'srv:uuid-idle', name: 'idle', state: 'IDLE' },
      { id: 'srv:uuid-pm', name: 'pm', state: 'PMSUSPENDED' },
      { id: 'srv:uuid-down', name: 'down', state: 'SHUTDOWN' },
      { id: 'srv:uuid-crash', name: 'crash', state: 'CRASHED' },
      { id: 'srv:uuid-none', name: 'none', state: 'NOSTATE' },
    ],
    start: vi.fn(async () => true),
    stop: vi.fn(async () => true),
    pause: vi.fn(async () => true),
    resume: vi.fn(async () => true),
    forceStop: vi.fn(async () => true),
    reboot: vi.fn(async () => true),
    ...over,
  }
}

/** Only the VM domain is exercised; every other read is a spec bug if called. */
function apiWith(vms: VmsSource): UnraidApiSource {
  const unused = async (): Promise<never> => {
    throw new Error('not used by this spec')
  }
  async function* none(): AsyncGenerator<never> {}
  return {
    array: { get: unused, setState: unused, parity: { start: unused, cancel: unused } },
    docker: { list: unused, start: unused, stop: unused, stats$: none },
    vms,
    system: { versions: unused, cpu$: none },
    notifications: { warningsAndAlerts: unused },
    close: async () => undefined,
  }
}

describe('live client: VMs', () => {
  it('maps every libvirt state onto a run state and names an unnamed VM by its id', async () => {
    const list = await createLiveUnraidClient(apiWith(vmsSource())).vms.list()
    expect(list).toEqual<UnraidVmInfo[]>([
      { id: 'srv:uuid-ccu', name: 'CCU3', state: 'running' },
      { id: 'srv:uuid-win', name: 'srv:uuid-win', state: 'shut off' },
      { id: 'srv:uuid-idle', name: 'idle', state: 'running' },
      { id: 'srv:uuid-pm', name: 'pm', state: 'paused' },
      { id: 'srv:uuid-down', name: 'down', state: 'stopping' },
      { id: 'srv:uuid-crash', name: 'crash', state: 'crashed' },
      { id: 'srv:uuid-none', name: 'none', state: 'unknown' },
    ])
  })

  it('dispatches each VM action to the API with the VM id', async () => {
    const source = vmsSource()
    const vms = createLiveUnraidClient(apiWith(source)).vms
    await vms.start('v1')
    await vms.stop('v2')
    await vms.pause('v3')
    await vms.resume('v4')
    await vms.forceStop('v5')
    await vms.reboot('v6')
    expect(source.start).toHaveBeenCalledWith('v1')
    expect(source.stop).toHaveBeenCalledWith('v2')
    expect(source.pause).toHaveBeenCalledWith('v3')
    expect(source.resume).toHaveBeenCalledWith('v4')
    expect(source.forceStop).toHaveBeenCalledWith('v5')
    expect(source.reboot).toHaveBeenCalledWith('v6')
  })

  it('a failed VM call is a typed client error', async () => {
    const source = vmsSource({
      list: async () => {
        throw new UnraidApiError('VMs are not available', {
          errors: [{ message: 'VMs are not available' }],
        })
      },
    })
    const failure = await createLiveUnraidClient(apiWith(source))
      .vms.list()
      .catch((err: unknown) => err)
    expect(failure).toBeInstanceOf(UnraidClientError)
    expect(failure).toMatchObject({ kind: 'api' })
  })
})

const quiet: IScopedLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => quiet,
  withTags: () => quiet,
}

function fakeClient(vmsList: () => Promise<readonly UnraidVmInfo[]>): UnraidClientLike {
  const done = async (): Promise<void> => undefined
  return {
    connect: done,
    disconnect: done,
    array: {
      get: async () => ({
        state: 'STARTED',
        capacityKb: { total: 1, used: 0, free: 1 },
        parityCheck: null,
        disks: [],
      }),
      setState: done,
      parity: { start: done, cancel: done },
    },
    docker: { list: async () => [], start: done, stop: done },
    vms: {
      list: vmsList,
      start: done,
      stop: done,
      pause: done,
      resume: done,
      forceStop: done,
      reboot: done,
    },
    system: { cpu: async () => ({ percent: 1, tempC: null, powerW: null }) },
    notifications: { active: async () => ({ activeCount: 0, latest: null }) },
  }
}

async function snapshotWith(vmsList: () => Promise<readonly UnraidVmInfo[]>) {
  const manager = new UnraidIntegrationManager({
    id: 'int-1',
    name: 'Tower',
    connection: settingsToConnection({ host: 'tower.example.com', apiKey: 'k' }),
    logger: quiet,
    onConnected: () => undefined,
    onDisconnected: () => undefined,
    onPolled: () => undefined,
    makeClient: () => fakeClient(vmsList),
  })
  await manager.start()
  const snapshot = manager.getSnapshot()
  await manager.stop()
  return snapshot
}

describe('snapshot: the VM section', () => {
  it('carries the VM list', async () => {
    const snapshot = await snapshotWith(async () => [{ id: 'v', name: 'CCU3', state: 'running' }])
    expect(snapshot?.vms).toEqual([{ id: 'v', name: 'CCU3', state: 'running' }])
  })

  it('a failed VM list is unknown (null), never empty, and never fails the poll', async () => {
    const snapshot = await snapshotWith(async () => {
      throw new Error('VM service stopped')
    })
    expect(snapshot).not.toBeNull()
    expect(snapshot?.vms).toBeNull()
    expect(snapshot?.array.state).toBe('STARTED')
  })
})
