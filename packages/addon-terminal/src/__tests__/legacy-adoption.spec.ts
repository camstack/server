/**
 * The one-off legacy-camera migration: every legacy automatic camera becomes
 * an instance that keeps its stable id, node and profile; a rerun with nothing
 * left adopts nothing and reports 0.
 */
import type { TerminalLegacyCamera } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { adoptAllLegacyCameras, legacyAdoptionBody } from '../legacy-adoption.js'
import { listLegacyTerminalCameraCandidates } from '../terminal-instances.js'
import type { TerminalBody } from '../terminal-record-kinds.js'

const ROWS = [
  {
    id: 811,
    stableId: 'terminal-camera-hub',
    name: 'Hub monitor',
    config: { nodeId: 'hub', profileId: 'monitor', profileLabel: 'BTM' },
  },
  {
    id: 812,
    stableId: 'terminal-camera-garage-nuc-top',
    name: 'Garage top',
    config: { nodeId: 'garage-nuc', profileId: 'top', profileLabel: 'Top' },
  },
  // Already an instance camera: never a legacy candidate.
  {
    id: 813,
    stableId: 'terminal-camera-instance-abc',
    name: 'x',
    config: { nodeId: 'hub' },
  },
]

/** A store whose candidate list reads the instances it holds, as the addon's does. */
function fakeStore() {
  const records = new Map<string, TerminalBody>()
  let next = 0
  return {
    records,
    deps: {
      listLegacy: async (): Promise<readonly TerminalLegacyCamera[]> =>
        listLegacyTerminalCameraCandidates(
          ROWS,
          new Set([...records.values()].map((body) => body.cameraStableId ?? '')),
          new Set(),
        ),
      putInstance: async (id: string, body: TerminalBody) => {
        if (records.has(id)) throw new Error('exists')
        records.set(id, body)
      },
      newId: () => `id-${String(++next)}`,
    },
  }
}

describe('adoptAllLegacyCameras', () => {
  it('adopts every legacy camera, keeping its stable id, node and profile', async () => {
    const store = fakeStore()
    const result = await adoptAllLegacyCameras(store.deps)
    expect(result.adopted).toBe(2)
    expect(result.cameras).toEqual([
      {
        stableId: 'terminal-camera-hub',
        instanceId: 'id-1',
        nodeId: 'hub',
        profileId: 'monitor',
      },
      {
        stableId: 'terminal-camera-garage-nuc-top',
        instanceId: 'id-2',
        nodeId: 'garage-nuc',
        profileId: 'top',
      },
    ])
    expect(store.records.get('id-2')).toMatchObject({
      name: 'Garage top',
      nodeId: 'garage-nuc',
      profileId: 'top',
      profileLabel: 'Top',
      cameraStableId: 'terminal-camera-garage-nuc-top',
    })
  })

  it('is a no-op on a rerun and reports 0', async () => {
    const store = fakeStore()
    await adoptAllLegacyCameras(store.deps)
    const rerun = await adoptAllLegacyCameras(store.deps)
    expect(rerun).toEqual({ adopted: 0, cameras: [] })
    expect(store.records.size).toBe(2)
  })
})

describe('legacyAdoptionBody', () => {
  it('names the instance as asked, else after the legacy camera', () => {
    const legacy = {
      stableId: 'terminal-camera-hub',
      nodeId: 'hub',
      profileId: 'monitor',
      profileLabel: 'BTM',
      name: 'Hub monitor',
      adoptable: true,
    }
    expect(legacyAdoptionBody(legacy).name).toBe('Hub monitor')
    expect(legacyAdoptionBody(legacy, '  Renamed ').name).toBe('Renamed')
  })
})
