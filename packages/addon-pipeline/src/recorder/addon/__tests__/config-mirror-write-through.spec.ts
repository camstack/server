/**
 * The operator's edit reaches the mirror, and it reaches it FIRST.
 *
 * `config-mirror.spec.ts` pins the mirror's own contract. This one pins the
 * wiring that makes the freshness window safe: `recording.setDeviceConfig` is
 * the only writer of `recorder:recording-configs`, so the value it persists
 * must be handed to this addon's mirror — otherwise the window D466 introduces
 * becomes exactly the D224 failure ("stale by design on the one write an
 * operator makes") in a different file.
 *
 * And the ORDER is load-bearing: `onConfigChanged` re-evaluates the controller,
 * which reads the config straight back. A mirror updated after it would hand
 * the operator's own edit a decision made against the previous value.
 *
 * The store is the REAL settings engine on `:memory:` (`configs-state-fixture`),
 * so a save that does not actually persist cannot pass.
 */
import { recordingsLocationOfMode } from '../roots.js'
import type { IScopedLogger, RecordingConfig } from '@camstack/types'
import { describe, expect, it, vi } from 'vitest'
import { RecordingIndex } from '../../recording-index.js'
import type { SegmentStore } from '../../segment-store.js'
import { createRecordingConfigMirror } from '../config-mirror.js'
import { loadDeviceConfig } from '../config-store.js'
import { buildRecordingProvider, type RecordingProviderDeps } from '../recording-provider.js'
import { makeConfigsState } from './configs-state-fixture.js'

const noopLogger: IScopedLogger = {
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
} as unknown as IScopedLogger

function continuousConfig(postBufferSec: number): RecordingConfig {
  return {
    enabled: true,
    bands: [
      {
        days: [0, 1, 2, 3, 4, 5, 6],
        start: '00:00',
        end: '23:59',
        mode: 'events',
        postBufferSec,
      },
    ],
  } as unknown as RecordingConfig
}

async function wiredProvider(order: string[]): Promise<{
  readonly setDeviceConfig: (input: {
    deviceId: number
    config: RecordingConfig
  }) => Promise<RecordingConfig>
  readonly read: (deviceId: number) => Promise<RecordingConfig>
  readonly storeReads: () => number
}> {
  const configStore = await makeConfigsState()
  let storeReads = 0
  const mirror = createRecordingConfigMirror({
    load: async (deviceId: number) => {
      storeReads += 1
      return loadDeviceConfig(configStore, deviceId)
    },
    logger: noopLogger,
  })
  const locations = [
    recordingsLocationOfMode({ id: 'loc-a', type: 'recordings', root: '/recordings/a' }, 'active'),
  ]
  const deps: RecordingProviderDeps = {
    index: new RecordingIndex(),
    segmentStore: {} as unknown as SegmentStore,
    nodeId: 'node-1',
    logger: noopLogger,
    configStore,
    locations: () => locations,
    refreshLocations: async () => locations,
    capacity: async () => ({ availableBytes: null, totalBytes: null }),
    hydrateDevice: async () => {},
    dataDir: '/data',
    playbackBaseUrl: () => null,
    onConfigSaved: (deviceId, config) => {
      order.push('mirror')
      mirror.put(deviceId, config)
    },
    onConfigChanged: async () => {
      order.push('reevaluate')
    },
  }
  const provider = buildRecordingProvider(deps)
  return {
    setDeviceConfig: (input) => provider.setDeviceConfig(input),
    read: mirror.read,
    storeReads: () => storeReads,
  }
}

describe('setDeviceConfig → the recorder mirror', () => {
  it('serves the operator edit on the very next read, with no store round trip', async () => {
    const p = await wiredProvider([])

    // The camera has never been read: the first read is honest and goes to the
    // store, so the mirror now holds the pre-edit value.
    await expect(p.read(102)).resolves.toMatchObject({ enabled: false })
    expect(p.storeReads()).toBe(1)

    await p.setDeviceConfig({ deviceId: 102, config: continuousConfig(300) })

    const after = await p.read(102)
    expect(after.bands[0]).toMatchObject({ postBufferSec: 300 })
    // The edit did NOT cost a read — it was written through.
    expect(p.storeReads()).toBe(1)
  })

  it('updates the mirror BEFORE the controller re-evaluates', async () => {
    const order: string[] = []
    const p = await wiredProvider(order)
    await p.setDeviceConfig({ deviceId: 101, config: continuousConfig(120) })
    expect(order).toEqual(['mirror', 'reevaluate'])
  })

  it('a re-evaluate that throws does not cost the mirror its value', async () => {
    const configStore = await makeConfigsState()
    let storeReads = 0
    const mirror = createRecordingConfigMirror({
      load: async (deviceId: number) => {
        storeReads += 1
        return loadDeviceConfig(configStore, deviceId)
      },
      logger: noopLogger,
    })
    const locations = [
      recordingsLocationOfMode(
        { id: 'loc-a', type: 'recordings', root: '/recordings/a' },
        'active',
      ),
    ]
    const provider = buildRecordingProvider({
      index: new RecordingIndex(),
      segmentStore: {} as unknown as SegmentStore,
      nodeId: 'node-1',
      logger: noopLogger,
      configStore,
      locations: () => locations,
      refreshLocations: async () => locations,
      capacity: async () => ({ availableBytes: null, totalBytes: null }),
      hydrateDevice: async () => {},
      dataDir: '/data',
      playbackBaseUrl: () => null,
      onConfigSaved: (deviceId, config) => {
        mirror.put(deviceId, config)
      },
      onConfigChanged: vi.fn(async () => {
        throw new Error('broker not ready')
      }),
    })

    await provider.setDeviceConfig({ deviceId: 102, config: continuousConfig(300) })
    const after = await mirror.read(102)
    expect(after.bands[0]).toMatchObject({ postBufferSec: 300 })
    expect(storeReads).toBe(0)
  })
})
