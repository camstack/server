/**
 * planning#580: a Terminal camera is a core block naming a terminal. The
 * composer owns its row `composed-<blockId>`; this engine builds the camera
 * device on that row and serves its caps. It keeps no list: every pass reads
 * the blocks.
 *
 * - `not-loaded` withdraws nothing (D315); a block missing from one trusted
 *   read is kept, two withdraw it (D49).
 * - a block whose terminal is gone hosts nothing; a disabled terminal's camera
 *   is offline.
 * - deleting a terminal deletes its camera block.
 * - an instance list that is not trusted runs no pass: nothing is withdrawn.
 */
import {
  type CapabilityDefinition,
  type CompositionListRead,
  type CoreBlock,
  type DeviceContext,
  type DeviceManagerApi,
  DeviceType,
  type IDeviceRuntimeState,
  type IScopedLogger,
  type TerminalHelperSpec,
} from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { TerminalCameraDevice } from '../terminal-camera-device.js'
import { gatedTerminalCameraPass, TerminalCameraHost } from '../terminal-camera-host.js'
import type { TerminalInstance } from '../terminal-instances.js'

const TERMINAL_ID = '3f1c2a4e-6b7d-4e8f-9a0b-1c2d3e4f5a6b'

function logger(): IScopedLogger {
  return {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: vi.fn().mockReturnThis(),
    withTags: vi.fn().mockReturnThis(),
  } as unknown as IScopedLogger
}

function terminalBlock(id: string, terminalId = TERMINAL_ID): CoreBlock {
  const helper: TerminalHelperSpec = { kind: 'terminal', terminalId }
  return {
    id,
    name: `block ${id}`,
    code: '',
    enabled: true,
    placement: 'hub',
    createdAt: 1,
    updatedAt: 5,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
    source: {
      kind: 'composition',
      composition: { target: { kind: 'new', type: DeviceType.Camera }, features: [], helper },
    },
  } as const satisfies CoreBlock
}

function loaded(...blocks: CoreBlock[]): CompositionListRead {
  return {
    state: 'loaded',
    views: blocks.map((block) => ({ block, state: { kind: 'answered', state: null } })),
  }
}

function terminal(enabled = true): TerminalInstance {
  return {
    id: TERMINAL_ID,
    nodeId: 'hub',
    profileId: 'monitor',
    profileLabel: 'BTM',
    name: 'Hub monitor',
    enabled,
    executable: '',
    args: [],
    cwd: '',
    environment: [],
    profileSettings: {},
  }
}

interface World {
  readonly host: TerminalCameraHost
  readonly loadContext: ReturnType<typeof vi.fn>
  readonly silence: ReturnType<typeof vi.fn>
  readonly writeDeviceFlags: ReturnType<typeof vi.fn>
  readonly deleteBlock: ReturnType<typeof vi.fn>
  readonly unregistered: string[]
}

function world(opts: {
  readonly reads: readonly CompositionListRead[]
  readonly silenced?: boolean
  /** From this call on (0-based), the blocks read throws. */
  readonly readsThrowFrom?: number
}): World {
  let call = 0
  const unregistered: string[] = []
  const loadContext = vi.fn(
    async (stableId: string, id: number, _parent: null, config: Record<string, unknown>) => {
      let state: IDeviceRuntimeState | null = null
      const surface = {
        id,
        stableId,
        parentDeviceId: null,
        persistedConfig: config,
        persistConfig: vi.fn().mockResolvedValue(undefined),
        logger: logger(),
        eventBus: { emit: vi.fn(), subscribe: vi.fn() },
        deviceMeta: {
          id,
          stableId,
          addonId: 'composer',
          type: DeviceType.Camera,
          name: 'row name',
          location: null,
          disabled: false,
          parentDeviceId: null,
          metadata: null,
        },
        fetchDevice: vi.fn().mockResolvedValue({ deviceState: { setCapSlice: vi.fn() } }),
        bindRuntimeState: (next: IDeviceRuntimeState) => {
          state = next
        },
        registerNativeCap: (cap: CapabilityDefinition) => {
          if (cap.runtimeState && state) state.installCapSchema(cap.name, cap.runtimeState)
        },
        unregisterNativeCap: (capName: string) => {
          unregistered.push(capName)
        },
      }
      return surface as unknown as DeviceContext
    },
  )
  const devices = { loadContext } as unknown as DeviceManagerApi
  const silence = vi.fn(async () => undefined)
  const writeDeviceFlags = vi.fn(async () => undefined)
  const deleteBlock = vi.fn(async () => undefined)
  const host = new TerminalCameraHost({
    logger: logger(),
    devices,
    readBlocks: async () => {
      const read = opts.reads[Math.min(call, opts.reads.length - 1)]
      call += 1
      if (opts.readsThrowFrom !== undefined && call > opts.readsThrowFrom) {
        throw new Error('core-blocks unreachable')
      }
      if (read === undefined) throw new Error('no read')
      return read
    },
    readComposerRows: async () => [
      { id: 4590, stableId: 'composed-t1' },
      { id: 4591, stableId: 'composed-t2' },
    ],
    readDeviceFlags: async () => (opts.silenced === true ? { analysisSilenced: true } : {}),
    writeDeviceFlags,
    silence,
    deleteBlock,
  })
  return { host, loadContext, silence, writeDeviceFlags, deleteBlock, unregistered }
}

describe('TerminalCameraHost — Terminal cameras are core blocks it hosts (planning#580)', () => {
  it('builds the camera on the composer row from the terminal it names, and silences once', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'))] })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    expect(w.loadContext).toHaveBeenCalledWith('composed-t1', 4590, null, {
      instanceId: TERMINAL_ID,
      nodeId: 'hub',
      profileId: 'monitor',
      profileLabel: 'BTM',
    })
    expect(w.silence).toHaveBeenCalledWith(4590)
    expect(w.writeDeviceFlags).toHaveBeenCalledWith(4590, { analysisSilenced: true })
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBe(4590)
  })

  it('a device already silenced is not silenced again', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'))], silenced: true })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.silence).not.toHaveBeenCalled()
  })

  it('not-loaded withdraws nothing, however many passes', async () => {
    const w = world({
      reads: [loaded(terminalBlock('t1')), { state: 'not-loaded', reason: 'cold' }],
    })
    for (let pass = 0; pass < 4; pass += 1) {
      await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    }
    expect(w.unregistered).toEqual([])
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBe(4590)
  })

  it('a blocks read that throws withdraws nothing, however many passes', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'))], readsThrowFrom: 1 })
    for (let pass = 0; pass < 4; pass += 1) {
      await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    }
    expect(w.unregistered).toEqual([])
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBe(4590)
  })

  it('one trusted read without the block keeps it; a second withdraws it', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1')), loaded()] })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    expect(w.unregistered).toEqual([])
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    expect(w.unregistered).toContain('stream-catalog')
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBeUndefined()
  })

  it('a block naming a terminal that does not exist hosts nothing', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'))] })
    await w.host.reconcile({ terminals: [], isLive: () => true })
    expect(w.loadContext).not.toHaveBeenCalled()
  })

  it("a disabled terminal's camera is hosted and offline", async () => {
    const setNodeOnline = vi.spyOn(TerminalCameraDevice.prototype, 'setNodeOnline')
    const w = world({ reads: [loaded(terminalBlock('t1'))] })
    await w.host.reconcile({ terminals: [terminal(false)], isLive: () => true })
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(setNodeOnline).toHaveBeenLastCalledWith(false)
    setNodeOnline.mockRestore()
  })

  it('a second block on a taken terminal is refused, the first keeps it', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'), terminalBlock('t2'))] })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBe(4590)
  })

  it('deleting a terminal deletes the camera blocks that name it', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'), terminalBlock('t2', 'other'))] })
    await w.host.deleteCamerasOf(TERMINAL_ID)
    expect(w.deleteBlock).toHaveBeenCalledTimes(1)
    expect(w.deleteBlock).toHaveBeenCalledWith('t1')
  })

  it('an instance list that is not trusted runs no pass: the hosted camera stays', async () => {
    const w = world({ reads: [loaded(terminalBlock('t1'))] })
    await w.host.reconcile({ terminals: [terminal()], isLive: () => true })
    // The list a failed read leaves behind: nothing the host could still serve.
    for (let pass = 0; pass < 3; pass += 1) {
      const outcome = await gatedTerminalCameraPass({
        logger: logger(),
        refreshInstances: async () => false,
        run: () => w.host.reconcile({ terminals: [], isLive: () => true }),
      })
      expect(outcome).toBe('untrusted')
    }
    expect(w.unregistered).toEqual([])
    expect(w.host.deviceIdFor(TERMINAL_ID)).toBe(4590)
  })

  it('a trusted instance list runs the pass', async () => {
    const run = vi.fn(async () => undefined)
    const outcome = await gatedTerminalCameraPass({
      logger: logger(),
      refreshInstances: async () => true,
      run,
    })
    expect(outcome).toBe('ran')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
