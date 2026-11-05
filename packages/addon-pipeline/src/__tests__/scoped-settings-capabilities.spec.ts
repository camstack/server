import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { AudioAnalyzerAddon } from '../audio-analyzer/addons/analyzer/index.js'
import PipelineRunnerAddon from '../pipeline-runner/index.js'
import { StreamBrokerAddon } from '../stream-broker/addon.js'

/**
 * D986 M4: the first config resolve runs before the providers register, so an addon that holds
 * node settings names the capabilities of its scoped hooks up front. A capability left out
 * would resolve its node keys from the bare key at boot.
 */
interface Probe {
  scopedSettingsCapabilities(): readonly string[]
  getScopedSettingsSchema(scope: 'node', cap: string): Promise<ConfigUISchema | null>
}

class AudioProbe extends AudioAnalyzerAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}
class RunnerProbe extends PipelineRunnerAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}
class BrokerProbe extends StreamBrokerAddon {
  override scopedSettingsCapabilities(): readonly string[] {
    return super.scopedSettingsCapabilities()
  }
}

async function nodeCaps(addon: Probe, candidates: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const cap of candidates) {
    if ((await addon.getScopedSettingsSchema('node', cap)) !== null) out.push(cap)
  }
  return out
}

describe('scoped settings capabilities of the pipeline addons', () => {
  it.each([
    ['audio-analyzer', new AudioProbe(), ['audio-analyzer', 'audio-analysis']],
    ['pipeline-runner', new RunnerProbe(), ['pipeline-runner', 'load-contribution']],
    ['stream-broker', new BrokerProbe(), ['stream-broker']],
  ] as const)('%s names every capability that has a node schema', async (_name, addon, caps) => {
    const withNode = await nodeCaps(addon, caps)
    expect(withNode.length).toBeGreaterThan(0)
    for (const cap of withNode) expect(addon.scopedSettingsCapabilities()).toContain(cap)
  })
})
