import { describe, expect, it } from 'vitest'
import { HaProviderAddon } from '../addon.js'

/**
 * D986 M4: the Home Assistant provider declares no addon-settings key. A broker link carries no
 * editable field, and `reconcileIntervalSec` (a ha-export target record field since
 * `targets-from-links`) is no longer an addon-settings key.
 */
describe('the Home Assistant provider settings', () => {
  it('declares no addon-settings key: the scoped settings is gone', async () => {
    expect(await new HaProviderAddon().listScopedSettings()).toEqual([])
  })
})
