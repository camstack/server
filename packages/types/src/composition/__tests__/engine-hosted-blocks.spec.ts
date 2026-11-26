/**
 * planning#580: an engine reads its blocks and the composer's rows, and hosts
 * what both name. `not-loaded` is untrusted (D315), a withdrawal needs two
 * trusted reads (D49), and a withdraw unregisters exactly what was registered.
 */
import { describe, expect, it, vi } from 'vitest'
import type { CompositionListRead, CoreBlock } from '../../capabilities/core-blocks.cap.js'
import type { DeviceContext, DeviceManagerApi } from '../../device/device-context.js'
import type { IDevice } from '../../device/device.js'
import { DeviceType } from '../../device/device-type.js'
import type { Composition } from '../composition.js'
import {
  HostedWithdrawalGate,
  hostEngineDevice,
  legacySweepDone,
  selectEngineHostedBlocks,
  sweepLegacyEngineRows,
} from '../engine-hosted-blocks.js'
import type { IScopedLogger } from '../../interfaces/logging.js'
import type { HelperSpec } from '../helpers/spec.js'

function block(id: string, helper: HelperSpec, enabled = true): CoreBlock {
  const composition: Composition = {
    target: { kind: 'new', type: DeviceType.Camera },
    features: [],
    helper,
  }
  return {
    id,
    name: `block ${id}`,
    code: '',
    enabled,
    createdAt: 1,
    updatedAt: 42,
    createdBy: 'test',
    status: 'running',
    lastChangedAt: 1,
    source: { kind: 'composition', composition },
  } as const satisfies CoreBlock
}

const grid: HelperSpec = { kind: 'grid', fps: 10, publishedProfiles: ['mid'], cells: [] }
const terminal: HelperSpec = {
  kind: 'terminal',
  terminalId: '3f1c2a4e-6b7d-4e8f-9a0b-1c2d3e4f5a6b',
}
const answered = { kind: 'answered', state: null } as const

function loaded(...blocks: CoreBlock[]): CompositionListRead {
  return { state: 'loaded', views: blocks.map((b) => ({ block: b, state: answered })) }
}

describe('selectEngineHostedBlocks', () => {
  it('names the blocks of one kind whose composer row exists, with the row id', () => {
    const read = selectEngineHostedBlocks(
      'grid',
      loaded(block('g1', grid), block('g2', grid), block('t1', terminal)),
      [
        { id: 7, stableId: 'composed-g1' },
        { id: 8, stableId: 'composed-t1' },
      ],
    )
    expect(read.kind).toBe('trusted')
    if (read.kind !== 'trusted') return
    expect(read.blocks.map((b) => [b.blockId, b.deviceId, b.updatedAt])).toEqual([['g1', 7, 42]])
    expect(read.blocks[0]?.spec.kind).toBe('grid')
  })

  it('reads not-loaded as untrusted, never as no blocks', () => {
    const read = selectEngineHostedBlocks('terminal', { state: 'not-loaded', reason: 'cold' }, [])
    expect(read).toEqual({ kind: 'untrusted', reason: 'cold' })
  })
})

describe('HostedWithdrawalGate', () => {
  it('keeps a block missing from one trusted read and withdraws it on the second', () => {
    const gate = new HostedWithdrawalGate()
    expect(gate.judge(['a', 'b'], new Set(['a']))).toEqual({ withdraw: [], held: ['b'] })
    expect(gate.judge(['a', 'b'], new Set(['a']))).toEqual({ withdraw: ['b'], held: [] })
  })

  it('a block back between two misses resets its count', () => {
    const gate = new HostedWithdrawalGate()
    gate.judge(['a'], new Set())
    gate.judge(['a'], new Set(['a']))
    expect(gate.judge(['a'], new Set()).withdraw).toEqual([])
  })
})

describe('hostEngineDevice', () => {
  it('builds through loadContext and withdraws exactly the natives it registered', async () => {
    const unregister = vi.fn()
    const register = vi.fn()
    const base = { registerNativeCap: register, unregisterNativeCap: unregister } as unknown
    const loadContext = vi.fn(async () => base as DeviceContext)
    const devices = { loadContext } as unknown as DeviceManagerApi
    const removeDevice = vi.fn(async () => {})
    class Fake {
      constructor(ctx: DeviceContext) {
        ctx.registerNativeCap({ name: 'snapshot', methods: {} } as never, {} as never)
      }
      removeDevice = removeDevice
    }
    const hosted = await hostEngineDevice(
      devices,
      { id: 9, stableId: 'composed-x' },
      { blockId: 'x' },
      Fake as unknown as new (
        ctx: DeviceContext,
      ) => IDevice,
    )
    expect(loadContext).toHaveBeenCalledWith('composed-x', 9, null, { blockId: 'x' })
    expect(register).toHaveBeenCalledTimes(1)
    await hosted.withdraw()
    expect(removeDevice).toHaveBeenCalled()
    expect(unregister).toHaveBeenCalledWith('snapshot')
  })

  it('refuses a kernel without loadContext rather than building on an empty state', async () => {
    const devices = {} as DeviceManagerApi
    await expect(
      hostEngineDevice(devices, { id: 9, stableId: 'composed-x' }, {}, class {} as never),
    ).rejects.toThrow(/loadContext/)
  })
})

function quietLogger(): IScopedLogger {
  const logger = {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
    child: () => logger,
    withTags: () => logger,
  }
  return logger as unknown as IScopedLogger
}

describe('sweepLegacyEngineRows', () => {
  it('without an integration removes nothing and mints nothing', async () => {
    const remove = vi.fn(async (_id: number) => {})
    const listAddonRows = vi.fn(async () => [{ id: 1, stableId: 'old', integrationId: 'int' }])
    const result = await sweepLegacyEngineRows(
      {
        logger: quietLogger(),
        addonId: 'camera-grid',
        devices: { remove } as unknown as DeviceManagerApi,
        getIntegration: async () => null,
        listAddonRows,
      },
      'Camera Grids',
    )
    expect(result).toEqual({ kind: 'none' })
    expect(remove).not.toHaveBeenCalled()
    expect(listAddonRows).not.toHaveBeenCalled()
  })

  it('removes every row under the old integration, and only those', async () => {
    const remove = vi.fn(async (_id: number) => {})
    const result = await sweepLegacyEngineRows(
      {
        logger: quietLogger(),
        addonId: 'terminal',
        devices: { remove } as unknown as DeviceManagerApi,
        getIntegration: async () => ({ id: 'int_t' }),
        listAddonRows: async () => [
          { id: 12, stableId: 'terminal-camera-instance-a', integrationId: 'int_t' },
          { id: 11, stableId: 'terminal-camera-agent-1', integrationId: 'int_t' },
          { id: 13, stableId: 'something-else', integrationId: 'int_other' },
        ],
      },
      'Terminal',
    )
    expect(remove.mock.calls.map(([id]) => id)).toEqual([11, 12])
    expect(result).toEqual({ kind: 'swept', removed: [11, 12], drained: false })
  })

  it('is done only once a pass found no old row left; no integration is not done', () => {
    expect(legacySweepDone({ kind: 'none' })).toBe(false)
    expect(legacySweepDone({ kind: 'swept', removed: [11], drained: false })).toBe(false)
    expect(legacySweepDone({ kind: 'swept', removed: [], drained: true })).toBe(true)
  })
})
