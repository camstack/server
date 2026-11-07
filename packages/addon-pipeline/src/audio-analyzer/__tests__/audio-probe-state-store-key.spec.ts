/**
 * The probed audio backend is per-node state under `probedBestAudioBackend@<node>` — the key every
 * earlier build wrote through `updateGlobalSettings`. A probe an old build stored is read by the new
 * code (boot does not re-probe), and a re-probe overwrites only this node's key.
 */
import { fakeAddonContext } from '@camstack/types/testing'
import { describe, expect, it } from 'vitest'
import { AudioAnalyzerAddon } from '../addons/analyzer/index.js'

class ProbeAddon extends AudioAnalyzerAddon {
  protected override async onInitialize(): ReturnType<AudioAnalyzerAddon['onInitialize']> {
    return { providers: [] }
  }
  stored() {
    return this.probedBestAudioBackend().get()
  }
}

async function boot(store: Record<string, unknown>): Promise<ProbeAddon> {
  const addon = new ProbeAddon()
  await addon.initialize(
    fakeAddonContext({
      id: 'audio-analyzer',
      localNodeId: 'hub',
      settings: {
        readAddonStore: async () => ({ ...store }),
        writeAddonStore: async (patch) => {
          Object.assign(store, patch)
        },
      },
    }),
  )
  return addon
}

describe('probedBestAudioBackend node-state key', () => {
  it('reads a probe written by the old build', async () => {
    const addon = await boot({
      'probedBestAudioBackend@hub': 'yamnet-onnx',
      'probedBestAudioBackend@agent-1': 'apple-soundanalysis',
    })
    expect(await addon.stored()).toBe('yamnet-onnx')
  })

  it('a re-probe writes only this node key', async () => {
    const store: Record<string, unknown> = {
      'probedBestAudioBackend@hub': 'stale',
      'probedBestAudioBackend@agent-1': 'apple-soundanalysis',
    }
    const addon = await boot(store)
    const { backend } = await addon.reprobeAudioEngine()
    expect(store['probedBestAudioBackend@hub']).toBe(backend)
    expect(store['probedBestAudioBackend@agent-1']).toBe('apple-soundanalysis')
    expect(store).not.toHaveProperty('probedBestAudioBackend')
  })
})
