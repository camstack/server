/**
 * Modal addon settings no longer own entries — Training → Providers does — so the addon
 * declares no settings at all (D986): an empty form is not a form.
 */
import { describe, expect, it } from 'vitest'
import { TrainingModalAddon } from '../training-modal.addon.js'

describe('training-modal settings schema', () => {
  it('declares no scoped settings', async () => {
    expect(await new TrainingModalAddon().listScopedSettings()).toEqual([])
  })
})
