/**
 * A scoped cluster write that lands after shutdown (the controllers are gone) is a no-op: there
 * is nothing left to re-derive, and the write must not throw into its caller.
 */
import type { ScopedSettingsScope } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import PipelineOrchestratorAddon from '../index.js'

class Probe extends PipelineOrchestratorAddon {
  async land(scope: ScopedSettingsScope, cap: string, keys: readonly string[]): Promise<void> {
    await this.onScopedSettingsChanged(scope, cap, keys)
  }
}

describe('PipelineOrchestratorAddon: a cluster write after shutdown', () => {
  it('resolves without touching the (absent) device-config controller', async () => {
    const addon = new Probe()
    await expect(
      addon.land('cluster', 'pipeline-orchestrator', ['anyKey']),
    ).resolves.toBeUndefined()
  })
})
