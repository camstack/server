/**
 * Modal addon settings no longer own entries — Training → Providers does — so the addon
 * declares no settings schema at all (D986): an empty form is not a form.
 */
import type { ConfigUISchema } from '@camstack/types'
import { describe, expect, it } from 'vitest'
import { TrainingModalAddon } from '../training-modal.addon.js'

class Probe extends TrainingModalAddon {
  globalFormForTest(): ConfigUISchema | null {
    return this.globalSettingsSchema()
  }
}

describe('training-modal settings schema', () => {
  it('declares no global schema', () => {
    expect(new Probe().globalFormForTest()).toBeNull()
  })
})
