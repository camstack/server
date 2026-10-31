import { describe, expect, it } from 'vitest'
import { isPreloadedSystemKey } from '../system-settings-policy.js'

describe('preloaded system keys', () => {
  // The agent convergence pass reads this switch synchronously on the hub,
  // whose settings engine is isolated: a key outside the mirror throws and
  // failed every reconcile (1.2.706, D982).
  it('mirrors the addon convergence dry-run switch', () => {
    expect(isPreloadedSystemKey('addons.convergence.dryRun')).toBe(true)
  })
})
