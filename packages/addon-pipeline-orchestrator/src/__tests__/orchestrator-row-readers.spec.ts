/**
 * D986 — the orchestrator READS its three id-keyed collections from rows, never from the legacy
 * map keys the migrations copied and left behind for one release.
 *
 * Every fixture is discriminating: the legacy map carries a DIFFERENT marker value than the row,
 * and a node and a camera exist in only one of the two places, so a reader that still looked at
 * the map (or merged both) fails by value, not by shape.
 */
import { describe, expect, it } from 'vitest'
import { createDurableState, type DurableState } from '@camstack/types'
import type { ZodType } from 'zod'
import { PipelineSettingsStore } from '../pipeline-settings-store.js'
import { applyPatch, rowFakes } from './settings-store-row-fakes.js'
import { makeSilentLogger } from './e2e-helpers.js'

function makeStore(seed: Record<string, unknown>) {
  let blob: Record<string, unknown> = { ...seed }
  const fakes = rowFakes(() => blob)
  const state = <T>(key: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
    createDurableState<T>({
      key,
      schema,
      fallback,
      read: async () => blob,
      write: async (patch) => {
        blob = applyPatch(blob, patch)
      },
    })
  const store = new PipelineSettingsStore({
    state,
    ...fakes,
    api: () => null,
    acquireCapability: () => Promise.reject(new Error('not used')),
    getAssignmentNode: () => 'hub',
    hasPackageZone: async () => false,
    logger: makeSilentLogger(),
  })
  return { store, fakes, blob: () => blob }
}

describe('orchestrator readers — node rows', () => {
  it('agent settings come from the node rows, not from the legacy agentSettings map', async () => {
    const { store } = makeStore({
      agentSettings: { 'legacy-only': { maxCameras: 1 }, shared: { maxCameras: 11 } },
      'agentSettings@shared': { maxCameras: 22 },
      'agentSettings@row-only': { maxCameras: 33 },
    })
    const all = await store.readAgentSettingsMap()
    expect(Object.keys(all).toSorted()).toEqual(['row-only', 'shared'])
    expect(all['shared']?.maxCameras).toBe(22)
    expect(all['row-only']?.maxCameras).toBe(33)
    expect((await store.readAgentSettingsMap())['legacy-only']).toBeUndefined()
  })

  it('node bindings come from the node rows, not from the legacy nodeBindings map', async () => {
    const { store } = makeStore({
      nodeBindings: { 'legacy-only': { det: 'old' }, shared: { det: 'old' } },
      'nodeBindings@shared': { det: 'new' },
    })
    expect(await store.getCapabilityBindings('shared')).toEqual({ det: 'new' })
    expect(await store.getCapabilityBindings('legacy-only')).toEqual({})
  })

  it('removing a node drops its row and leaves the neighbours', async () => {
    const { store, blob } = makeStore({
      'nodeBindings@a': { det: 'x' },
      'nodeBindings@b': { det: 'y' },
    })
    expect(await store.removeCapabilityBindings('a')).toBe(true)
    expect(Object.keys(blob()).toSorted()).toEqual(['nodeBindings@b'])
  })

  it('a failed store read throws instead of answering "no node"', async () => {
    const { store, fakes } = makeStore({})
    const failing = new PipelineSettingsStore({
      state: <T>(_k: string, schema: ZodType<T>, fallback: T): DurableState<T> =>
        createDurableState<T>({
          key: _k,
          schema,
          fallback,
          read: async () => ({}),
          write: async () => {},
        }),
      ...fakes,
      readStore: async () => {
        throw new Error('store down')
      },
      api: () => null,
      acquireCapability: () => Promise.reject(new Error('not used')),
      getAssignmentNode: () => 'hub',
      hasPackageZone: async () => false,
      logger: makeSilentLogger(),
    })
    await expect(failing.readAgentSettingsMap()).rejects.toThrow('store down')
    expect(store).toBeDefined()
  })
})

describe('orchestrator readers — device rows', () => {
  it('camera settings come from the per-device store, not from the legacy cameraSettings map', async () => {
    const { store, fakes } = makeStore({
      cameraSettings: {
        '7': { stepSettings: { s: { v: 'legacy' } } },
        '9': { stepSettings: { s: { v: 'legacy-only' } } },
      },
    })
    fakes.devices.set(7, { cameraSettings: { stepSettings: { s: { v: 'row' } } } })
    fakes.devices.set(8, { cameraSettings: { stepSettings: { s: { v: 'row-only' } } } })
    const all = await store.readCameraSettingsMap()
    expect(Object.keys(all).toSorted()).toEqual(['7', '8'])
    expect(all['7']?.stepSettings?.['s']).toEqual({ v: 'row' })
    expect(await store.readCameraSettings(9)).toBeNull()
  })

  it('a camera write lands on the device, and clearing it removes the field', async () => {
    const { store, fakes } = makeStore({})
    await store.writeCameraSettings(5, { stepSettings: { s: { v: 1 } } })
    expect(fakes.devices.get(5)?.['cameraSettings']).toEqual({ stepSettings: { s: { v: 1 } } })
    await store.deleteCameraSettings(5)
    expect(fakes.devices.get(5)?.['cameraSettings']).toBeUndefined()
  })
})
