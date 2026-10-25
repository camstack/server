/**
 * `buildCameraSensorsPorts` (D672): the resolver's ports over the hub API.
 * A throw or a missing API is `unreadable` (never "no rows" — D49), a row
 * keeps only the fields the resolver judges, and bindings are narrowed to the
 * source caps without reading `kind` (D13).
 */
import type { AddonApi, IScopedLogger } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { buildCameraSensorsPorts } from '../camera-sensors/resolver.js'

const logger: IScopedLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
  child: () => logger,
  withTags: () => logger,
}

const PIR_ROW = {
  id: 3299,
  stableId: 'ha:porch-pir',
  addonId: 'provider-homeassistant',
  type: 'sensor',
  name: 'Motion',
  location: null,
  disabled: false,
  parentDeviceId: null,
  online: true,
  features: [],
  isCamera: false,
  config: {},
}

function fakeApi(opts: { listAll?: () => Promise<unknown>; bindings?: () => Promise<unknown> }) {
  const listAll = vi.fn(opts.listAll ?? (async () => [PIR_ROW]))
  const getBindingsBatch = vi.fn(opts.bindings ?? (async () => []))
  const api = {
    deviceManager: { listAll: { query: listAll }, getBindingsBatch: { query: getBindingsBatch } },
  }
  // Test boundary: the ports touch only these two procedures of the full API.
  return { api: api as unknown as AddonApi, listAll, getBindingsBatch }
}

describe('buildCameraSensorsPorts', () => {
  it('asks slim listings, by addon and by id, and keeps only the judged fields', async () => {
    const f = fakeApi({})
    const ports = buildCameraSensorsPorts(() => f.api, logger)
    expect(await ports.listByAddon('provider-homeassistant')).toEqual({
      kind: 'rows',
      rows: [
        {
          id: 3299,
          addonId: 'provider-homeassistant',
          stableId: 'ha:porch-pir',
          name: 'Motion',
          online: true,
          disabled: false,
          isCamera: false,
        },
      ],
    })
    await ports.listByIds([3299])
    expect(f.listAll.mock.calls).toEqual([
      [{ addonId: 'provider-homeassistant', projection: 'slim' }],
      [{ deviceIds: [3299], projection: 'slim' }],
    ])
  })

  it('a throw or a missing API is unreadable, never an empty answer', async () => {
    const f = fakeApi({
      listAll: async () => {
        throw new Error('timeout')
      },
      bindings: async () => {
        throw new Error('refused')
      },
    })
    const ports = buildCameraSensorsPorts(() => f.api, logger)
    expect(await ports.listByIds([3299])).toEqual({ kind: 'unreadable', error: 'timeout' })
    expect(await ports.sourceCapsOf([3299])).toEqual({ kind: 'unreadable', error: 'refused' })
    const none = buildCameraSensorsPorts(() => null, logger)
    expect(await none.listByAddon('x')).toEqual({
      kind: 'unreadable',
      error: 'no api in this context',
    })
  })

  it('narrows bindings to source caps; a device with none answers an empty list', async () => {
    const entry = (capName: string, kind: 'native' | 'wrapped') => ({
      capName,
      kind,
      providerAddonId: 'a',
      providerNodeId: 'hub',
      nativeAddonId: 'a',
    })
    const f = fakeApi({
      bindings: async () => [
        {
          deviceId: 3299,
          entries: [
            entry('motion', 'native'),
            entry('battery', 'native'),
            entry('binary', 'wrapped'),
          ],
        },
        { deviceId: 3300, entries: [entry('battery', 'native')] },
      ],
    })
    const read = await buildCameraSensorsPorts(() => f.api, logger).sourceCapsOf([3299, 3300])
    expect(read.kind).toBe('caps')
    if (read.kind !== 'caps') return
    expect(read.byDevice.get(3299)).toEqual(['binary', 'motion'])
    expect(read.byDevice.get(3300)).toEqual([])
  })
})
