/* eslint-disable @typescript-eslint/no-unsafe-assignment, @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-unsafe-return -- AddonContext stub crosses typed boundaries. */
/**
 * planning#580: a grid is a core block. The composer owns its camera row
 * `composed-<blockId>`; this engine builds its device on that row and serves
 * the camera caps. It keeps no list: every pass reads the blocks.
 *
 * - `not-loaded` withdraws nothing (D315); a block missing from one trusted
 *   read is kept, two withdraw it (D49).
 * - `getLayout` names the grid by its DEVICE row — the only name it has.
 * - a layout save writes the block spec, sources by identity, never a name.
 * - a legacy `camera-grid` row is removed through the declared sweep (D865).
 */
import {
  type AddonContext,
  type CapabilityDefinition,
  type CompositionListRead,
  type CoreBlock,
  type CropHelperSpec,
  type DeviceContext,
  DeviceType,
  type GridHelperSpec,
  type IDeviceRuntimeState,
  type IScopedLogger,
} from '@dominevo/types'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CameraGridAddon } from '../addon.js'

const RECONCILE_MS = 60_000
const RECT = { x: 0, y: 0, width: 1, height: 1 }

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

function gridBlock(
  id: string,
  spec: GridHelperSpec | CropHelperSpec,
  name = `block ${id}`,
): CoreBlock {
  return {
    id,
    name,
    code: '',
    enabled: true,
    createdAt: 1,
    updatedAt: 77,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
    source: {
      kind: 'composition',
      composition: { target: { kind: 'new', type: DeviceType.Camera }, features: [], helper: spec },
    },
  } as unknown as CoreBlock
}

const SPEC: GridHelperSpec = {
  kind: 'grid',
  fps: 10,
  publishedProfiles: ['mid', 'low'],
  cells: [{ source: { addonId: 'provider-rtsp', stableId: 'cam-a' }, region: RECT, cell: RECT }],
}

function loaded(...blocks: CoreBlock[]): CompositionListRead {
  return {
    state: 'loaded',
    views: blocks.map((block) => ({ block, state: { kind: 'answered', state: null } })),
  }
}

interface World {
  readonly ctx: AddonContext
  readonly listCompositions: ReturnType<typeof vi.fn>
  readonly updateComposition: ReturnType<typeof vi.fn>
  readonly loadContext: ReturnType<typeof vi.fn>
  readonly unregistered: string[]
  readonly providers: Map<string, Record<string, (input: unknown) => Promise<unknown>>>
  readonly getBindings: ReturnType<typeof vi.fn>
  readonly writeDeviceStore: ReturnType<typeof vi.fn>
  readonly remove: ReturnType<typeof vi.fn>
  readonly getByAddonId: ReturnType<typeof vi.fn>
}

/** The members `BaseDevice` reaches at construction; a structural double narrowed at this boundary. */
function deviceContext(
  stableId: string,
  id: number,
  config: Record<string, unknown>,
  providers: World['providers'],
  unregistered: string[],
): DeviceContext {
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
    bindRuntimeState: (s: IDeviceRuntimeState) => {
      state = s
    },
    registerNativeCap: (cap: CapabilityDefinition, provider: unknown) => {
      providers.set(cap.name, provider as Record<string, (input: unknown) => Promise<unknown>>)
      if (cap.runtimeState && state) state.installCapSchema(cap.name, cap.runtimeState)
    },
    unregisterNativeCap: (capName: string) => {
      unregistered.push(capName)
    },
  }
  return surface as unknown as DeviceContext
}

function world(opts: {
  readonly reads: readonly CompositionListRead[]
  readonly silenced?: boolean
  readonly legacyIntegration?: boolean
  /** The per-device store read throws on its first call only. */
  readonly storeReadFailsOnce?: boolean
  /** From this call on (0-based), the blocks read throws. */
  readonly compositionsThrowFrom?: number
  /** From this call on (0-based), the composer rows read throws. */
  readonly composerRowsThrowFrom?: number
}): World {
  const providers: World['providers'] = new Map()
  const unregistered: string[] = []
  let call = 0
  let storeReads = 0
  let composerReads = 0
  const listCompositions = vi.fn(async () => {
    const read = opts.reads[Math.min(call, opts.reads.length - 1)]
    call += 1
    if (opts.compositionsThrowFrom !== undefined && call > opts.compositionsThrowFrom) {
      throw new Error('core-blocks unreachable')
    }
    return read
  })
  const updateComposition = vi.fn(async (input: { blockId: string }) => ({
    block: gridBlock(input.blockId, SPEC),
  }))
  const loadContext = vi.fn(
    async (stableId: string, id: number, _parent: null, config: Record<string, unknown>) =>
      deviceContext(stableId, id, config, providers, unregistered),
  )
  const getBindings = vi.fn(async () => ({ entries: [] }))
  const writeDeviceStore = vi.fn(async () => undefined)
  const remove = vi.fn(async () => undefined)
  const getByAddonId = vi.fn(async () =>
    opts.legacyIntegration === true ? { id: 'int_grid', info: { fixed: true } } : null,
  )
  const rowsByAddon: Record<string, unknown[]> = {
    composer: [{ id: 4581, stableId: 'composed-g1', name: 'Bimbi camera' }],
    'provider-rtsp': [{ id: 611, stableId: 'cam-a', addonId: 'provider-rtsp' }],
    'camera-grid': [{ id: 10, stableId: 'camera-grid-old', integrationId: 'int_grid', config: {} }],
  }
  const ctx = {
    id: 'addon:camera-grid',
    logger: logger(),
    dataDir: mkdtempSync(path.join(tmpdir(), 'camera-grid-hosting-')),
    settings: {
      readAddonStore: vi.fn(async () => ({})),
      writeAddonStore: vi.fn(async () => undefined),
      readDeviceStore: vi.fn(async () => {
        storeReads += 1
        if (opts.storeReadFailsOnce === true && storeReads === 1) throw new Error('store down')
        return opts.silenced ? { analysisSilenced: true } : {}
      }),
      writeDeviceStore,
      getSection: vi.fn(async () => ({})),
      setSection: vi.fn(async () => undefined),
    },
    eventBus: { emit: vi.fn(), subscribe: vi.fn(() => () => undefined) },
    kernel: { localNodeId: 'hub', devices: { loadContext, remove } },
    deps: { ensureFfmpeg: vi.fn(async () => '/usr/bin/true') },
    api: {
      coreBlocks: {
        listCompositions: { query: listCompositions },
        updateComposition: { mutate: updateComposition },
      },
      deviceManager: {
        listAll: {
          query: vi.fn(async (input: { addonId?: string; deviceIds?: number[] }) => {
            if (input.deviceIds !== undefined) {
              return input.deviceIds.map((id) => ({
                id,
                addonId: 'provider-rtsp',
                stableId: `cam-${id}`,
              }))
            }
            if (input.addonId === 'composer') {
              composerReads += 1
              const from = opts.composerRowsThrowFrom
              if (from !== undefined && composerReads > from) throw new Error('device-manager down')
            }
            return rowsByAddon[input.addonId ?? ''] ?? []
          }),
        },
        getDevice: {
          query: vi.fn(async ({ deviceId }: { deviceId: number }) =>
            deviceId === 4581 ? { id: 4581, name: 'Bimbi camera' } : null,
          ),
        },
        getBindings: { query: getBindings },
        setWrapperActive: { mutate: vi.fn(async () => undefined) },
      },
      integrations: {
        getByAddonId: { query: getByAddonId },
        update: { mutate: vi.fn(async () => undefined) },
      },
      integrationInstances: { createInstance: { mutate: vi.fn() } },
      streamBroker: { listAllProfileSlots: { query: vi.fn(async () => []) } },
    },
  } as unknown as AddonContext
  return {
    ctx,
    listCompositions,
    updateComposition,
    loadContext,
    unregistered,
    providers,
    getBindings,
    writeDeviceStore,
    remove,
    getByAddonId,
  }
}

describe('CameraGridAddon — grids are core blocks it hosts (planning#580)', () => {
  let addon: CameraGridAddon | null = null
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  })
  afterEach(async () => {
    await addon?.shutdown()
    addon = null
    vi.useRealTimers()
  })

  async function boot(w: World): Promise<void> {
    addon = new CameraGridAddon()
    await addon.initialize(w.ctx)
  }

  async function pass(): Promise<void> {
    await vi.advanceTimersByTimeAsync(RECONCILE_MS)
  }

  it('builds its device on the composer row and silences analysis once, by a per-device flag', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))] })
    await boot(w)
    expect(w.loadContext).toHaveBeenCalledWith('composed-g1', 4581, null, { blockId: 'g1' })
    expect(w.providers.has('stream-catalog')).toBe(true)
    expect(w.getBindings).toHaveBeenCalledWith({ deviceId: 4581 })
    expect(w.writeDeviceStore).toHaveBeenCalledWith(4581, { analysisSilenced: true })
  })

  it('hosts a crop block (#611) on its composer row like a grid, silenced once', async () => {
    const crop: CropHelperSpec = {
      kind: 'crop',
      source: { addonId: 'provider-rtsp', stableId: 'cam-a' },
      rect: { x: 0.2, y: 0.2, width: 0.5, height: 0.5 },
      aspect: 'free',
      fps: 10,
      publishedProfiles: ['mid', 'low'],
    }
    const w = world({ reads: [loaded(gridBlock('g1', crop))] })
    await boot(w)
    expect(w.loadContext).toHaveBeenCalledWith('composed-g1', 4581, null, { blockId: 'g1' })
    expect(w.providers.has('stream-catalog')).toBe(true)
    expect(w.writeDeviceStore).toHaveBeenCalledWith(4581, { analysisSilenced: true })
  })

  it('a device already silenced is not silenced again', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))], silenced: true })
    await boot(w)
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.getBindings).not.toHaveBeenCalled()
  })

  it('a device store that fails to read keeps the hosted device: no orphan, no second device', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))], storeReadFailsOnce: true })
    await boot(w)
    await pass()
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.unregistered).toEqual([])
    expect(w.writeDeviceStore).not.toHaveBeenCalled()
  })

  it('not-loaded withdraws nothing, however many passes', async () => {
    const notLoaded: CompositionListRead = { state: 'not-loaded', reason: 'cold' }
    const w = world({ reads: [loaded(gridBlock('g1', SPEC)), notLoaded] })
    await boot(w)
    await pass()
    await pass()
    await pass()
    expect(w.listCompositions.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(w.unregistered).toEqual([])
  })

  it('a blocks read that throws withdraws nothing, however many passes', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))], compositionsThrowFrom: 1 })
    await boot(w)
    await pass()
    await pass()
    await pass()
    expect(w.listCompositions.mock.calls.length).toBeGreaterThanOrEqual(4)
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.unregistered).toEqual([])
  })

  it('a composer rows read that throws withdraws nothing, however many passes', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))], composerRowsThrowFrom: 1 })
    await boot(w)
    await pass()
    await pass()
    await pass()
    expect(w.loadContext).toHaveBeenCalledTimes(1)
    expect(w.unregistered).toEqual([])
  })

  it('a block switched off is kept one pass, withdrawn on the second', async () => {
    const off = { ...gridBlock('g1', SPEC), enabled: false }
    const w = world({ reads: [loaded(gridBlock('g1', SPEC)), loaded(off)] })
    await boot(w)
    await pass()
    expect(w.unregistered).toEqual([])
    await pass()
    expect(w.unregistered).toContain('stream-catalog')
    expect(w.unregistered).toContain('camera-grid-layout')
  })

  it('one trusted read without the block keeps it; a second withdraws it', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC)), loaded()] })
    await boot(w)
    await pass()
    expect(w.unregistered).toEqual([])
    await pass()
    expect(w.unregistered).toContain('stream-catalog')
    expect(w.unregistered).toContain('camera-grid-layout')
  })

  it('getLayout names the grid by its device row, not by the block', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC, 'stale block name'))] })
    await boot(w)
    const layout = w.providers.get('camera-grid-layout')
    const view = await layout?.getLayout?.({ deviceId: 4581 })
    expect(view).toMatchObject({ blockId: 'g1', deviceId: 4581, name: 'Bimbi camera' })
    expect(view).toMatchObject({ cells: [{ deviceId: 611, source: RECT, cell: RECT }] })
  })

  it('a layout save writes the block spec, sources by identity, never a name', async () => {
    const w = world({ reads: [loaded(gridBlock('g1', SPEC))] })
    await boot(w)
    const layout = w.providers.get('camera-grid-layout')
    await layout?.saveLayout?.({
      deviceId: 4581,
      fps: 12,
      cells: [{ deviceId: 612, source: RECT, cell: RECT }],
    })
    expect(w.updateComposition).toHaveBeenCalledTimes(1)
    const input = w.updateComposition.mock.calls[0]?.[0]
    expect(input).toMatchObject({ blockId: 'g1', expectedUpdatedAt: 77 })
    expect(input.block.name).toBeUndefined()
    expect(input.block.composition.helper).toEqual({
      kind: 'grid',
      fps: 12,
      publishedProfiles: ['mid', 'low'],
      cells: [
        { source: { addonId: 'provider-rtsp', stableId: 'cam-612' }, region: RECT, cell: RECT },
      ],
    })
  })

  it('an integration lookup that answers null does not end the sweep: the next pass asks again', async () => {
    const w = world({ reads: [loaded()] })
    await boot(w)
    const asked = w.getByAddonId.mock.calls.length
    await pass()
    expect(w.getByAddonId.mock.calls.length).toBeGreaterThan(asked)
  })

  it('removes a legacy camera-grid row through the declared sweep, unconditionally', async () => {
    const w = world({ reads: [loaded()], legacyIntegration: true })
    await boot(w)
    expect(w.remove).toHaveBeenCalledWith(10)
  })
})
